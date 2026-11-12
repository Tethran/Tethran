// Settlement orchestrator: agent proposal -> Policy Service decision and co-signature -> agent signer module
// -> vault payout through ChainClient -> receipt mint. One Opik trace per settlement run; every LLM attempt and
// every tool call in it is a span, and the trace id is stored on the settlement plan.
//
// Trust boundaries kept here:
// - The LLM only returns a proposal. It holds no key and its output is never executed: it goes to the Policy
//   Service as data. Whatever the model says, only Policy-approved, Policy-signed transfers can be paid, and the
//   vault enforces the limits again on-chain.
// - The orchestrator does not decide anything about money. It moves a Policy decision to the chain.
// - Untrusted input (contract text, evidence) is passed to the agent as delimited data (see services/llm).
import type { DatabaseSync } from "node:sqlite";
import { keccak256, toUtf8Bytes } from "ethers";
import type { AgentInput, Tracer } from "../../llm/src/index";
import { traceTool } from "../../llm/src/index";
import type { Agent, AgentMode } from "./replay";
import type { AgentSigner } from "./agentSigner";
import type { TreasuryChain } from "./chainPort";
import { milestones, payeesOf, type MilestoneRow } from "./db";
import { ApiError, safeErrorMessage } from "./errors";
import type { Cosignature, PolicyClient } from "./policyClient";

export interface OrchestratorDeps {
  db: DatabaseSync;
  chain: TreasuryChain;
  policy: PolicyClient;
  agentSigner: AgentSigner;
  /** The Settlement Agent, live or replay (see replay.ts). */
  agent: Agent;
  /** Default agent mode when a request does not choose one. */
  defaultAgentMode: AgentMode;
  tracer: Tracer;
  chainName: string;
  now: () => Date;
}

type PayoutRow = {
  id: number; plan_id: number; milestone_id: string; action_index: number; action_id: string; payee_id: string;
  rail: string; to_address: string; amount: string; chain_id: number; proposal_hash: string; deadline: number;
  policy_sig: string; tx: string | null; status: string; simulated: number;
};

export function createOrchestrator(deps: OrchestratorDeps) {
  const { db, chain } = deps;
  const iso = () => deps.now().toISOString();

  function agentInput(m: MilestoneRow, policy: Record<string, any>): AgentInput {
    const payees = payeesOf(db, m.provider_id).map((p) => ({
      id: p.payee_id, name: p.name, rail: p.rail, network: deps.chainName, verified_name: p.verified_name ?? undefined,
    }));
    const evidence = (db.prepare("SELECT id, text FROM evidence WHERE milestone_id = ? ORDER BY id").all(m.id) as { id: number; text: string }[])
      .map((e) => ({ id: `ev-${e.id}`, text: e.text }));
    return {
      milestone: {
        id: m.id, title: m.title, gross_amount: m.amount, asset: "USDT", status: "released", expected_network: deps.chainName,
      },
      payees,
      policy_summary: {
        per_tx_cap: String(policy.per_tx_cap), per_tx_soft_limit: String(policy.per_tx_soft_limit),
        confidence_threshold: Number(policy.confidence_threshold),
      },
      tax_profile: { min_tax_reserve_bps: Number(policy.min_tax_reserve_bps) },
      contract_text: `Milestone "${m.title}" for ${m.amount} base units of USDT, paid to the provider's listed payees.`,
      evidence,
    };
  }

  /** Records the Policy co-signatures as payouts to execute (once per action id). */
  function recordPayouts(planId: number, m: MilestoneRow, proposal: any, proposalHash: string, cosigs: Cosignature[]) {
    const payees = new Map(payeesOf(db, m.provider_id).map((p) => [p.payee_id, p]));
    for (const c of cosigs) {
      const action = proposal.actions[c.action_index];
      const payee = payees.get(action?.payee_id);
      if (!payee) throw new ApiError(500, `co-signed action ${c.action_index} has no known payee`);
      db.prepare(
        `INSERT OR IGNORE INTO payouts (plan_id, milestone_id, action_index, action_id, payee_id, rail, to_address, amount, chain_id,
           proposal_hash, deadline, policy_sig, tx, status, simulated, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'signed', ?, ?)`,
      ).run(planId, m.id, c.action_index, c.action_id, payee.payee_id, payee.rail, c.to, c.amount, m.chain_id,
        "0x" + proposalHash, c.deadline, c.signature, payee.simulated, iso());
    }
  }

  /** Executes every signed payout of a milestone that has not landed yet. Safe to call again. */
  async function executePayouts(m: MilestoneRow): Promise<PayoutRow[]> {
    const rows = db.prepare("SELECT * FROM payouts WHERE milestone_id = ? ORDER BY action_index").all(m.id) as unknown as PayoutRow[];
    for (const p of rows) {
      if (p.status === "confirmed") continue;
      try {
        const agentSig = await traceTool("agent_signer.sign", { input: { action_index: p.action_index, amount: p.amount } }, () =>
          deps.agentSigner.sign({
            vault: m.vault, chainId: m.chain_id, to: p.to_address, amount: p.amount, proposalHash: p.proposal_hash,
            actionId: p.action_id, deadline: p.deadline, policySig: p.policy_sig,
          }));
        const tx = await traceTool("vault.execute", { input: { action_index: p.action_index, to: p.to_address, amount: p.amount } },
          async () => {
            const ref = await chain.vaultExecute({
              vault: m.vault, to: p.to_address, amount: p.amount, proposalHash: p.proposal_hash, actionId: p.action_id,
              deadline: p.deadline, agentSig, policySig: p.policy_sig,
            }, `pay:${p.action_id}`);
            await chain.waitConfirmed(ref.txHash);
            return ref;
          });
        db.prepare("UPDATE payouts SET tx = ?, status = 'confirmed' WHERE id = ?").run(tx.txHash, p.id);
      } catch (e) {
        const status = e instanceof ApiError && e.code === "EXPIRED" ? "expired" : "failed";
        db.prepare("UPDATE payouts SET status = ? WHERE id = ?").run(status, p.id);
        throw e instanceof ApiError ? e : new ApiError(502, `payout ${p.action_index} failed: ${safeErrorMessage(e)}`, "PAYOUT_FAILED");
      }
    }
    return db.prepare("SELECT * FROM payouts WHERE milestone_id = ? ORDER BY action_index").all(m.id) as unknown as PayoutRow[];
  }

  /** Mints the receipt once every payout of the approved plan has landed. Idempotent (and enforced on-chain). */
  async function mintReceipt(m: MilestoneRow, proposalHash: string) {
    const existing = db.prepare("SELECT * FROM receipts WHERE milestone_id = ?").get(m.id);
    if (existing) return existing;
    if (!m.release_tx) throw new ApiError(500, "milestone has no release transaction recorded");
    const invoiceHash = keccak256(toUtf8Bytes(m.invoice_ref));
    const tx = await traceTool("receipt.mint", { input: { milestone_id: m.id } }, async () => {
      const ref = await chain.mintReceipt({
        milestoneId: m.id, holder: m.provider_address, invoiceHash, settlementHash: "0x" + proposalHash,
        amount: m.amount, releaseTx: m.release_tx!,
      }, `receipt:${m.id}`);
      await chain.waitConfirmed(ref.txHash);
      return ref;
    });
    const onChain = await chain.receiptOf(m.id);
    db.prepare("INSERT OR IGNORE INTO receipts (milestone_id, chain_id, token_id, mint_tx, holder, invoice_hash, settlement_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.chain_id, onChain?.tokenId ?? null, tx.txHash, m.provider_address, invoiceHash, "0x" + proposalHash, iso());
    return db.prepare("SELECT * FROM receipts WHERE milestone_id = ?").get(m.id);
  }

  async function finish(m: MilestoneRow, planId: number, proposalHash: string) {
    const payouts = await executePayouts(m);
    milestones.setState(db, m.id, "paid_out");
    const receipt = await mintReceipt(milestones.get(db, m.id)!, proposalHash);
    db.prepare("UPDATE settlement_plans SET decision = 'paid_out' WHERE id = ?").run(planId);
    return { payouts, receipt };
  }

  return {
    /**
     * Runs a settlement for a released milestone. If an approved plan already exists (an earlier run stopped
     * part-way), it resumes that plan's payouts instead of asking the agent again.
     */
    async settle(milestoneId: string, opts: { agentMode?: AgentMode } = {}) {
      const mode = opts.agentMode ?? deps.defaultAgentMode;
      const m = milestones.get(db, milestoneId);
      if (!m) throw new ApiError(404, "milestone not found");
      if (m.state !== "released" && m.state !== "paid_out") {
        throw new ApiError(409, `milestone is ${m.state}; it must be released to the vault first`);
      }
      const prior = db.prepare("SELECT * FROM settlement_plans WHERE milestone_id = ? AND decision IN ('approved', 'paid_out') ORDER BY id DESC LIMIT 1")
        .get(m.id) as { id: number; proposal_hash: string; trace_id: string; decision: string } | undefined;
      if (prior) {
        const { payouts, receipt } = await finish(m, prior.id, prior.proposal_hash);
        return { decision: "approved", resumed: true, trace_id: prior.trace_id, proposal_hash: prior.proposal_hash, payouts, receipt };
      }

      const { traceId, result } = await deps.tracer.run(
        { name: "settlement", input: { milestone_id: m.id }, metadata: { milestone_id: m.id, chain_id: m.chain_id, agent_mode: mode }, tags: ["settlement"] },
        async (run) => {
          const { policy } = await traceTool("get_policy_summary", { output: () => ({ ok: true }) }, () => deps.policy.getPolicy());
          const input = await traceTool("build_agent_input", { input: { milestone_id: m.id } }, async () => agentInput(m, policy));
          const proposed = await deps.agent.propose(input, mode, m.scenario ?? "clean_delivery");
          const agent = { agent_mode: proposed.agent_mode, ...(proposed.replay_source ? { replay_source: proposed.replay_source } : {}) };
          if (proposed.agent_mode !== "live") run.span({ name: "agent.replay", type: "general", output: agent });
          if (!proposed.ok) {
            run.span({ name: "agent.rejected", type: "guardrail", output: { reasons: proposed.reasons } });
            const planId = Number(db.prepare("INSERT INTO settlement_plans (milestone_id, proposal_json, proposal_hash, trace_id, decision, reasons, agent_mode, at) VALUES (?, NULL, NULL, ?, 'rejected', ?, ?, ?)")
              .run(m.id, run.traceId, JSON.stringify(proposed.reasons), proposed.agent_mode, iso()).lastInsertRowid);
            const agent_attempts = proposed.attempts.map((x) => ({ provider: x.provider, model: x.model, attempt: x.attempt, reason: x.reason }));
            return { decision: "rejected" as const, reasons: proposed.reasons as string[], rejected_by: "agent output check", agent_attempts, plan_id: planId, ...agent };
          }
          const decision = await traceTool("policy.submit", {
            input: { actions: proposed.proposal.actions.length },
            output: (d) => ({ decision: d.decision, reasons: d.reasons, cosignatures: d.cosignatures?.length ?? 0 }),
          }, () => deps.policy.submitProposal(proposed.proposal, run.traceId));
          const planId = Number(db.prepare("INSERT INTO settlement_plans (milestone_id, proposal_json, proposal_hash, trace_id, decision, reasons, approval_id, agent_mode, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(m.id, JSON.stringify(proposed.proposal), decision.proposal_hash, run.traceId, decision.decision, JSON.stringify(decision.reasons), decision.approval_id ?? null, proposed.agent_mode, iso()).lastInsertRowid);
          if (decision.decision !== "approved") {
            return { decision: decision.decision, reasons: decision.reasons, rejected_by: "policy service", approval_id: decision.approval_id, plan_id: planId, ...agent };
          }
          recordPayouts(planId, m, proposed.proposal, decision.proposal_hash, decision.cosignatures ?? []);
          const { payouts, receipt } = await finish(m, planId, decision.proposal_hash);
          return { decision: "approved" as const, reasons: [], plan_id: planId, proposal_hash: decision.proposal_hash, payouts, receipt, ...agent };
        },
      );
      return { ...result, resumed: false, trace_id: traceId };
    },

    /**
     * Executes an escalated settlement after a human decision. The operator's signed decision goes to the
     * Policy Service, which re-runs every rejecting rule against the current policy and chain state and only then
     * co-signs. A human can override an escalation reason (low confidence, soft limit), never a rejecting rule or
     * an on-chain limit. The payouts then run exactly as for an approved settlement.
     */
    async executeApproval(milestoneId: string, approvalId: string, body: { decision?: unknown; operator_signature?: unknown }) {
      const m = milestones.get(db, milestoneId);
      if (!m) throw new ApiError(404, "milestone not found");
      const plan = db.prepare("SELECT * FROM settlement_plans WHERE milestone_id = ? AND approval_id = ? ORDER BY id DESC LIMIT 1")
        .get(m.id, approvalId) as { id: number; proposal_json: string; proposal_hash: string; trace_id: string; decision: string } | undefined;
      if (!plan) throw new ApiError(404, "no escalated settlement with this approval id for this milestone");
      if (plan.decision === "approved" || plan.decision === "paid_out") {
        const { payouts, receipt } = await finish(m, plan.id, plan.proposal_hash);
        return { decision: "approved", resumed: true, trace_id: plan.trace_id, payouts, receipt };
      }
      if (plan.decision !== "escalated") throw new ApiError(409, `this settlement was ${plan.decision}, not escalated`);
      if (body.decision !== "approve" && body.decision !== "reject") throw new ApiError(400, 'decision must be "approve" or "reject"');
      if (typeof body.operator_signature !== "string") throw new ApiError(403, "operator_signature required");

      const { traceId, result } = await deps.tracer.run(
        { name: "settlement.approval", input: { milestone_id: m.id, approval_id: approvalId }, metadata: { milestone_id: m.id, approval_id: approvalId, settlement_trace_id: plan.trace_id }, tags: ["settlement", "approval"] },
        async () => {
          const decision = await traceTool("policy.decide_approval", {
            input: { approval_id: approvalId, decision: body.decision },
            output: (d) => ({ decision: d.decision, reasons: d.reasons, cosignatures: d.cosignatures?.length ?? 0 }),
          }, () => deps.policy.decideApproval(approvalId, body.decision as string, body.operator_signature as string));
          db.prepare("UPDATE settlement_plans SET decision = ?, reasons = ? WHERE id = ?").run(decision.decision, JSON.stringify(decision.reasons), plan.id);
          if (decision.decision !== "approved") return { decision: decision.decision, reasons: decision.reasons, plan_id: plan.id };
          if (m.state !== "released" && m.state !== "paid_out") throw new ApiError(409, `milestone is ${m.state}; it must be released to the vault first`);
          recordPayouts(plan.id, m, JSON.parse(plan.proposal_json), plan.proposal_hash, decision.cosignatures ?? []);
          const { payouts, receipt } = await finish(m, plan.id, plan.proposal_hash);
          return { decision: "approved" as const, reasons: decision.reasons, plan_id: plan.id, payouts, receipt };
        },
      );
      return { ...result, trace_id: traceId, settlement_trace_id: plan.trace_id };
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
