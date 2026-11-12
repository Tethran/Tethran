// Operator and arbiter endpoints.
//
// Operator (the provider or agency admin; their wallet is the vault operator):
//   - one queue of everything waiting for a human: identity holds, Policy Service approvals, reconciliation issues
//   - identity holds: decided with an EIP-712 signature by the vault's operator; "release" lets the release go ahead
// Arbiter (the platform arbiter, third party of every milestone):
//   - disputed milestones, the typed data each party signs, and attestation collection; once two different parties
//     have signed the same outcome, the backend submits escrow.decide (anyone may submit; the signatures decide)
// Nothing here moves money on its own authority: decisions are signatures checked here and again on-chain.
import type { DatabaseSync } from "node:sqlite";
import { getAddress, isAddress, verifyTypedData } from "ethers";
import type { TreasuryChain } from "./chainPort";
import { milestones } from "./db";
import { ApiError } from "./errors";
import type { PolicyClient } from "./policyClient";
import type { Treasury } from "./treasury";
import { approvalDecisionTypes, policyDomain } from "../../policy/src/typed";

// The Policy Service's own typed data for approval decisions (same definitions, imported, never copied).
const APPROVAL_DOMAIN = policyDomain;
const APPROVAL_TYPES = approvalDecisionTypes;

export const OPERATOR_TYPES = {
  IdentityDecision: [
    { name: "milestoneId", type: "string" },
    { name: "decision", type: "string" },
  ],
};

export function migrateOperator(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS attestations (
    milestone_id TEXT NOT NULL, signer TEXT NOT NULL, kind INTEGER NOT NULL, release_to_provider INTEGER NOT NULL,
    signature TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (milestone_id, signer, release_to_provider)
  )`);
}

const KINDS = { client: 0, provider: 1, arbiter: 2 } as const;

export function createOperator(deps: {
  db: DatabaseSync;
  chain: TreasuryChain;
  treasury: Treasury;
  policy: PolicyClient;
  now: () => Date;
}) {
  const { db, chain } = deps;
  migrateOperator(db);
  const need = (id: string) => {
    const m = milestones.get(db, id);
    if (!m) throw new ApiError(404, "milestone not found");
    return m;
  };
  const domain = () => ({ name: "TethranOperator", version: "1", chainId: chain.chainId });
  const operatorOf = (providerId: string) => {
    const v = db.prepare("SELECT operator FROM vaults WHERE provider_id = ? AND chain_id = ?").get(providerId, chain.chainId) as { operator: string } | undefined;
    if (!v) throw new ApiError(404, "provider has no vault on this chain");
    return getAddress(v.operator);
  };

  return {
    async queue() {
      const identity_holds = db.prepare("SELECT * FROM identity_holds WHERE status = 'open' ORDER BY opened_at").all();
      let policy_approvals: unknown = [];
      try {
        policy_approvals = await deps.policy.listApprovals("pending");
      } catch {
        policy_approvals = { error: "Policy Service unreachable" };
      }
      return { identity_holds, policy_approvals, reconciliation_queue: "/reconciliation/queue", simulated_identity: true };
    },

    identityTypedData(milestoneId: string, decision: unknown) {
      need(milestoneId);
      if (decision !== "release" && decision !== "hold") throw new ApiError(400, 'decision must be "release" or "hold"');
      return { domain: domain(), types: OPERATOR_TYPES, primaryType: "IdentityDecision", message: { milestoneId, decision } };
    },

    /** The vault's operator decides an identity hold. "release" lets POST /milestones/{id}/release go ahead. */
    async decideIdentity(milestoneId: string, body: { decision?: unknown; operator_signature?: unknown }) {
      const m = need(milestoneId);
      const hold = db.prepare("SELECT * FROM identity_holds WHERE milestone_id = ?").get(m.id) as { status: string } | undefined;
      if (!hold) throw new ApiError(404, "no identity hold for this milestone");
      if (hold.status !== "open") throw new ApiError(409, "this identity hold was already decided");
      if (body.decision !== "release" && body.decision !== "hold") throw new ApiError(400, 'decision must be "release" or "hold"');
      if (typeof body.operator_signature !== "string") throw new ApiError(403, "operator_signature required");
      let signer: string;
      try {
        signer = getAddress(verifyTypedData(domain(), OPERATOR_TYPES, { milestoneId: m.id, decision: body.decision }, body.operator_signature));
      } catch {
        throw new ApiError(403, "operator signature is malformed");
      }
      if (signer !== operatorOf(m.provider_id)) throw new ApiError(403, "not signed by this provider's vault operator");
      db.prepare("UPDATE identity_holds SET status = 'decided', decision = ?, decided_by = ?, decided_at = ? WHERE milestone_id = ?")
        .run(body.decision, signer, deps.now().toISOString(), m.id);
      if (body.decision === "hold") return { milestone_id: m.id, decision: "hold", released: false };
      const released = await deps.treasury.release(m.id);
      return { milestone_id: m.id, decision: "release", released: true, release: released };
    },

    /**
     * Escalated settlements: the typed data the operator signs, and a relay of the signed decision to the Policy
     * Service. The Policy Service verifies the operator signature itself; this backend cannot decide for it.
     */
    async approvalTypedData(approvalId: string, decision: unknown) {
      if (decision !== "approve" && decision !== "reject" && decision !== "new_plan") throw new ApiError(400, 'decision must be "approve", "reject" or "new_plan"');
      const pending = (await deps.policy.listApprovals("pending")) as { id: string; proposal_hash: string }[];
      const a = Array.isArray(pending) ? pending.find((x) => x.id === approvalId) : undefined;
      if (!a) throw new ApiError(404, "no pending approval with this id");
      return {
        domain: APPROVAL_DOMAIN, types: APPROVAL_TYPES, primaryType: "ApprovalDecision",
        message: { approvalId, decision, proposalHash: "0x" + a.proposal_hash.replace(/^0x/, "") },
      };
    },

    async decideApproval(approvalId: string, body: { decision?: unknown; operator_signature?: unknown }) {
      if (body.decision !== "approve" && body.decision !== "reject" && body.decision !== "new_plan") throw new ApiError(400, 'decision must be "approve", "reject" or "new_plan"');
      if (typeof body.operator_signature !== "string") throw new ApiError(403, "operator_signature required");
      return deps.policy.decideApproval(approvalId, body.decision, body.operator_signature);
    },

    async disputes() {
      const rows = db.prepare("SELECT id FROM milestones WHERE state IN ('funded', 'in_review', 'disputed')").all() as { id: string }[];
      const out = [];
      for (const r of rows) {
        const m = await deps.treasury.sync(r.id);
        if (m.state !== "disputed") continue;
        const onChain = await chain.milestone(m.id);
        const atts = db.prepare("SELECT signer, kind, release_to_provider, at FROM attestations WHERE milestone_id = ?").all(m.id);
        out.push({ milestone_id: m.id, title: m.title, amount: m.amount, timeout: onChain.timeout, attestations: atts, evidence_summary: `/milestones/${m.id}/evidence/summary` });
      }
      return out;
    },

    attestationTypedData(milestoneId: string, kind: unknown, release: unknown) {
      need(milestoneId);
      if (!(typeof kind === "string" && kind in KINDS)) throw new ApiError(400, "kind must be client, provider or arbiter");
      if (release !== "true" && release !== "false" && typeof release !== "boolean") throw new ApiError(400, "release_to_provider must be true or false");
      return chain.attestationTypedData(milestoneId, KINDS[kind as keyof typeof KINDS], release === true || release === "true");
    },

    /** Stores a party's signed attestation; when two parties agree, submits escrow.decide. */
    async attest(milestoneId: string, body: { signer?: unknown; signature?: unknown; release_to_provider?: unknown }) {
      const m = await deps.treasury.sync(milestoneId);
      if (m.state !== "disputed") throw new ApiError(409, `milestone is ${m.state}, not disputed`);
      if (typeof body.signer !== "string" || !isAddress(body.signer)) throw new ApiError(400, "signer must be an address");
      if (typeof body.signature !== "string") throw new ApiError(400, "signature required");
      if (typeof body.release_to_provider !== "boolean") throw new ApiError(400, "release_to_provider must be a boolean");
      const onChain = await chain.milestone(m.id);
      const signer = getAddress(body.signer);
      const kind = signer === getAddress(onChain.client) ? 0 : signer === getAddress(onChain.provider) ? 1 : signer === getAddress(onChain.arbiter) ? 2 : -1;
      if (kind < 0) throw new ApiError(403, "signer is not a party of this milestone");
      const td = chain.attestationTypedData(m.id, kind as 0 | 1 | 2, body.release_to_provider);
      let recovered: string;
      try {
        recovered = getAddress(verifyTypedData(td.domain, td.types, td.message, body.signature));
      } catch {
        throw new ApiError(403, "attestation signature is malformed");
      }
      if (recovered !== signer) throw new ApiError(403, "attestation was not signed by this party");
      db.prepare("INSERT OR REPLACE INTO attestations VALUES (?, ?, ?, ?, ?, ?)").run(m.id, signer, kind, body.release_to_provider ? 1 : 0, body.signature, deps.now().toISOString());

      const agreeing = db.prepare("SELECT signer, signature FROM attestations WHERE milestone_id = ? AND release_to_provider = ? ORDER BY at")
        .all(m.id, body.release_to_provider ? 1 : 0) as { signer: string; signature: string }[];
      if (agreeing.length < 2) return { milestone_id: m.id, recorded: true, decided: false, waiting_for: "one more party with the same outcome" };
      const two = agreeing.slice(0, 2);
      const tx = await chain.decide(m.id, body.release_to_provider, two.map((a) => a.signature), two.map((a) => a.signer), `decide:${m.id}:${body.release_to_provider}`);
      await chain.waitConfirmed(tx.txHash);
      const after = await deps.treasury.sync(m.id);
      return { milestone_id: m.id, recorded: true, decided: true, outcome: body.release_to_provider ? "release to provider" : "refund to funder", decide_tx: tx.txHash, state: after.state };
    },
  };
}

export type Operator = ReturnType<typeof createOperator>;

export function operatorRoutes(op: Operator): [string, RegExp, (ctx: any) => Promise<unknown>][] {
  return [
    ["GET", /^\/operator\/queue$/, async () => op.queue()],
    ["GET", /^\/operator\/identity-holds\/([^/]+)\/typed-data$/, async ({ params, url }) => op.identityTypedData(params[1], url.searchParams.get("decision"))],
    ["POST", /^\/operator\/identity-holds\/([^/]+)\/decision$/, async ({ params, body }) => op.decideIdentity(params[1], body ?? {})],
    ["GET", /^\/operator\/approvals\/([^/]+)\/typed-data$/, async ({ params, url }) => op.approvalTypedData(params[1], url.searchParams.get("decision"))],
    ["POST", /^\/operator\/approvals\/([^/]+)\/decision$/, async ({ params, body }) => op.decideApproval(params[1], body ?? {})],
    ["GET", /^\/arbiter\/disputes$/, async () => op.disputes()],
    ["GET", /^\/arbiter\/disputes\/([^/]+)\/typed-data$/, async ({ params, url }) =>
      op.attestationTypedData(params[1], url.searchParams.get("kind"), url.searchParams.get("release_to_provider"))],
    ["POST", /^\/arbiter\/disputes\/([^/]+)\/attestations$/, async ({ params, body }) => op.attest(params[1], body ?? {})],
  ];
}
