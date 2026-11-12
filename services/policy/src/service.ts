import { getAddress, isAddress } from "ethers";
import type { AuditLog, AuditRow } from "./audit";
import { cosignProposal, type Cosignature, type TypedDataSigner } from "./cosign";
import { evaluateProposal, validatePolicy } from "./engine";
import { validateProposal } from "./schema";
import type { ApprovalRow, ApprovalStatus, ApprovalStore, DecisionStore, PolicyStore } from "./stores";
import type {
  Decision,
  EvaluationContext,
  EvaluationResult,
  MilestoneFacts,
  Policy,
  ReasonCode,
  ResolvedPayee,
  SettlementProposal,
} from "./types";
import {
  approvalDecisionTypes,
  approvalDecisionValue,
  ATTESTATION_KIND,
  attestationDomain,
  attestationTypes,
  onChainMilestoneId,
  policyDocumentTypes,
  policyDocumentValue,
  policyDomain,
  policyHash,
  signatureMatches,
  type AttestationType,
} from "./typed";

// Application logic behind the HTTP API. No HTTP here. Everything outside comes in through `ServiceDeps`.

// An error whose message is written by us and is safe to show to a caller.
export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Short printable message for any thrown value, with URLs removed (copied from services/chain/src/errors.ts).
export function safeErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown; code?: unknown };
  const text =
    typeof err?.shortMessage === "string" ? err.shortMessage : typeof err?.message === "string" ? err.message : String(e);
  const code = typeof err?.code === "string" ? ` [${err.code}]` : "";
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"',)]+/gi, "[url removed]") + code;
}

// What the service reads from the chain and the database of payees. Tests fake it.
export interface ChainReader {
  vaultFor(milestone_id: string): Promise<{ vault: string; chainId: number }>;
  vaultState(vault: string): Promise<{ spentToday: string; balance: string }>;
  milestoneFacts(milestone_id: string): Promise<MilestoneFacts>;
  payees(): Promise<Record<string, ResolvedPayee>>;
}

// Writes accepted policy limits to the on-chain vault. Called after a policy update is accepted.
export interface ChainWriter {
  applyPolicy(update: { policy: Policy; version: number; operator_signature: string }): Promise<void>;
}

// NOT WIRED YET: records the call and does nothing on chain. Replace before the demo.
export function stubChainWriter(): ChainWriter & { calls: { policy: Policy; version: number; operator_signature: string }[] } {
  const calls: { policy: Policy; version: number; operator_signature: string }[] = [];
  return {
    calls,
    async applyPolicy(update) {
      calls.push(update);
    },
  };
}

export interface ServiceDeps {
  policyStore: PolicyStore;
  audit: AuditLog;
  decisions: DecisionStore;
  approvals: ApprovalStore;
  chain: ChainReader;
  chainWriter: ChainWriter;
  signer: TypedDataSigner; // Policy Service signer, used only for vault co-signatures
  operatorAddress: string; // the operator's ADDRESS, never a key
  escrow: { chainId: number; address: string }; // for attestation verification
  now: () => Date;
}

export interface ProposalResponse {
  decision: Decision;
  reasons: ReasonCode[];
  proposal_hash: string;
  cosignatures?: Cosignature[];
  approval_id?: string; // set when escalated
}

const ATTESTATION_TYPES = Object.keys(ATTESTATION_KIND);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function bad(message: string): never {
  throw new ServiceError(400, message);
}

// Co-signatures are valid for 15 minutes; the vault refuses the transfer after the deadline.
export const COSIGN_VALID_SECONDS = 900;

export function createService(deps: ServiceDeps) {
  const { policyStore, audit, decisions, approvals, chain, chainWriter, signer } = deps;
  const iso = () => deps.now().toISOString();

  // Reads everything the rules need. Chain failures stop the request: no decision is guessed.
  async function gather(milestoneId: string, policy: Policy, seen: ReadonlySet<string>) {
    try {
      const { vault, chainId } = await chain.vaultFor(milestoneId);
      const state = await chain.vaultState(vault);
      const milestone = await chain.milestoneFacts(milestoneId);
      const payees = await chain.payees();
      const ctx: EvaluationContext = {
        policy,
        payees,
        spentTodayBaseUnits: state.spentToday,
        vaultBalance: state.balance,
        nowUnixSeconds: Math.floor(deps.now().getTime() / 1000),
        seenProposalHashes: seen,
        milestone,
      };
      return { ctx, vault, chainId, payees };
    } catch (e) {
      throw new ServiceError(502, "chain read failed: " + safeErrorMessage(e));
    }
  }

  async function sign(proposal: SettlementProposal, proposalHash: string, g: { vault: string; chainId: number; payees: Record<string, ResolvedPayee> }) {
    try {
      const deadline = Math.floor(deps.now().getTime() / 1000) + COSIGN_VALID_SECONDS;
      const cosignatures = await cosignProposal({ signer, proposal, proposalHashHex: proposalHash, chainId: g.chainId, vault: g.vault, payees: g.payees, deadline });
      // Record that signatures exist BEFORE they leave this function. From here on the same proposal is a
      // duplicate. If signing or this write fails, nothing is returned, so a retry of the proposal is allowed.
      decisions.markSigned(proposalHash);
      return cosignatures;
    } catch {
      // The decision is already in the audit log. Never return a partial or unsigned "approved".
      throw new ServiceError(500, "signing failed");
    }
  }

  return {
    async submitProposal(input: unknown): Promise<ProposalResponse> {
      if (!isRecord(input)) bad("body must be an object");
      const { proposal, trace_id } = input;
      if (typeof trace_id !== "string" || trace_id.length === 0) bad("trace_id is required");
      if (proposal === undefined) bad("proposal is required");

      const active = policyStore.current();
      const rawMilestone = isRecord(proposal) && typeof proposal.milestone_id === "string" ? proposal.milestone_id : "unknown";
      // Duplicates: a hash that already has co-signatures, or one waiting in the approval queue.
      const seen = decisions.signedHashes();
      for (const pending of approvals.list("pending")) seen.add(pending.proposal_hash);

      let result: EvaluationResult;
      let gathered: Awaited<ReturnType<typeof gather>> | undefined;
      if (validateProposal(proposal).valid) {
        gathered = await gather(rawMilestone, active.policy, seen);
        result = evaluateProposal(proposal, gathered.ctx);
      } else {
        // The engine returns SCHEMA_INVALID before it reads anything else, so no chain reads are needed.
        result = evaluateProposal(proposal, {
          policy: active.policy,
          payees: {},
          spentTodayBaseUnits: "0",
          vaultBalance: "0",
          nowUnixSeconds: 0,
          seenProposalHashes: seen,
          milestone: { cardFunded: false, releaseEligible: true, identityMatch: true, grossAmount: "0" },
        });
      }

      // Log first, sign second.
      const at = iso();
      audit.append({
        at,
        milestone_id: rawMilestone,
        proposal_hash: result.proposal_hash,
        decision: result.decision,
        reasons: result.reasons,
        policy_version: active.version,
        trace_id,
      });
      decisions.add({ proposal_hash: result.proposal_hash, decision: result.decision, reasons: result.reasons, milestone_id: rawMilestone, trace_id, at });

      const response: ProposalResponse = { decision: result.decision, reasons: result.reasons, proposal_hash: result.proposal_hash };
      if (result.decision === "escalated") {
        response.approval_id = approvals.create({
          proposal,
          proposal_hash: result.proposal_hash,
          reasons: result.reasons,
          milestone_id: rawMilestone,
          trace_id,
          at,
        });
      }
      if (result.decision === "approved" && gathered !== undefined) {
        response.cosignatures = await sign(proposal as SettlementProposal, result.proposal_hash, gathered);
      }
      return response;
    },

    getPolicy() {
      const { policy, version } = policyStore.current();
      return { policy, version };
    },

    async setPolicy(input: unknown) {
      if (!isRecord(input)) bad("body must be an object");
      const { policy, version, operator_signature } = input;
      if (typeof operator_signature !== "string" || operator_signature.length === 0) throw new ServiceError(403, "operator signature required");
      if (!Number.isInteger(version)) bad("version must be an integer");
      const current = policyStore.current();
      if (version !== current.version + 1) throw new ServiceError(409, "version must be " + (current.version + 1));
      try {
        validatePolicy(policy as Policy);
      } catch (e) {
        bad((e as Error).message);
      }
      const doc = policy as Policy;
      if (doc.version !== version) bad("policy.version must equal version");

      const value = policyDocumentValue(version as number, doc);
      if (!signatureMatches(policyDomain, policyDocumentTypes, value, operator_signature, deps.operatorAddress)) {
        throw new ServiceError(403, "operator signature does not verify");
      }

      policyStore.add(doc, operator_signature, iso());
      audit.append({
        at: iso(),
        milestone_id: "policy",
        proposal_hash: policyHash(doc).slice(2),
        decision: "approved",
        reasons: [],
        policy_version: doc.version,
        trace_id: "operator",
      });
      try {
        await chainWriter.applyPolicy({ policy: doc, version: doc.version, operator_signature });
      } catch (e) {
        // The new policy is active here and logged; the on-chain write needs a retry.
        throw new ServiceError(502, "policy accepted but on-chain update failed: " + safeErrorMessage(e));
      }
      return { policy: doc, version: doc.version };
    },

    listApprovals(status: unknown = "pending"): ApprovalRow[] {
      if (status !== "pending" && status !== "approved" && status !== "rejected") bad("status must be pending, approved or rejected");
      return approvals.list(status as ApprovalStatus);
    },

    async decideApproval(id: string, input: unknown) {
      if (!isRecord(input)) bad("body must be an object");
      const { decision, operator_signature } = input;
      if (decision !== "approve" && decision !== "reject") bad("decision must be approve or reject");
      if (typeof operator_signature !== "string" || operator_signature.length === 0) throw new ServiceError(403, "operator signature required");

      const approval = approvals.get(id);
      if (approval === undefined) throw new ServiceError(404, "approval not found");
      if (approval.status !== "pending") throw new ServiceError(409, "approval already decided");

      const value = approvalDecisionValue(id, decision as string, approval.proposal_hash);
      if (!signatureMatches(policyDomain, approvalDecisionTypes, value, operator_signature, deps.operatorAddress)) {
        throw new ServiceError(403, "operator signature does not verify");
      }

      const active = policyStore.current();
      const base = {
        milestone_id: approval.milestone_id,
        proposal_hash: approval.proposal_hash,
        policy_version: active.version,
        trace_id: approval.trace_id,
      };

      if (decision === "reject") {
        if (!approvals.decide(id, "rejected", iso())) throw new ServiceError(409, "approval already decided");
        audit.append({ ...base, at: iso(), decision: "rejected", reasons: approval.reasons });
        return { decision: "rejected" as Decision, reasons: approval.reasons, proposal_hash: approval.proposal_hash };
      }

      // Approve: a human can override escalation reasons, never a rejecting rule or an on-chain limit.
      // So the rules run again against the current policy and chain state. The proposal's own earlier
      // decision is not a duplicate of itself, hence the empty seen-set.
      const proposal = approval.proposal as SettlementProposal;
      const gathered = await gather(approval.milestone_id, active.policy, new Set<string>());
      const rerun = evaluateProposal(proposal, gathered.ctx);

      if (rerun.decision === "rejected") {
        if (!approvals.decide(id, "rejected", iso())) throw new ServiceError(409, "approval already decided");
        audit.append({ ...base, at: iso(), decision: "rejected", reasons: rerun.reasons });
        return { decision: "rejected" as Decision, reasons: rerun.reasons, proposal_hash: approval.proposal_hash };
      }

      if (!approvals.decide(id, "approved", iso())) throw new ServiceError(409, "approval already decided");
      // Logged with the escalation reasons that the human overrode. Signing comes after.
      audit.append({ ...base, at: iso(), decision: "approved", reasons: approval.reasons });
      const cosignatures = await sign(proposal, approval.proposal_hash, gathered);
      return { decision: "approved" as Decision, reasons: approval.reasons, proposal_hash: approval.proposal_hash, cosignatures };
    },

    verifyAttestation(input: unknown): { valid: boolean } {
      if (!isRecord(input)) bad("body must be an object");
      // release_to_provider is not in INTERFACES.md's body, but the typed data needs it.
      const { milestone_id, type, signer: signerAddress, signature, release_to_provider } = input;
      if (typeof milestone_id !== "string" || milestone_id.length === 0) bad("milestone_id is required");
      if (typeof type !== "string" || !ATTESTATION_TYPES.includes(type)) bad("type must be client, provider or arbiter");
      if (typeof signerAddress !== "string" || !isAddress(signerAddress)) bad("signer must be an address");
      if (typeof signature !== "string") bad("signature is required");
      if (typeof release_to_provider !== "boolean") bad("release_to_provider must be a boolean");

      const value = {
        milestoneId: onChainMilestoneId(milestone_id as string),
        kind: ATTESTATION_KIND[type as AttestationType],
        releaseToProvider: release_to_provider,
      };
      const domain = attestationDomain(deps.escrow.chainId, getAddress(deps.escrow.address));
      return { valid: signatureMatches(domain, attestationTypes, value, signature as string, getAddress(signerAddress as string)) };
    },

    getAudit(milestone_id?: string): AuditRow[] {
      return audit.list(milestone_id === undefined ? {} : { milestone_id });
    },
  };
}

export type PolicyService = ReturnType<typeof createService>;
