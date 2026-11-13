import { createHash } from "node:crypto";
import { platformFee } from "./fee";
import { validateProposal } from "./schema";
import type {
  Action,
  EscalateReason,
  EvaluationContext,
  EvaluationResult,
  Policy,
  RejectReason,
  SettlementProposal,
} from "./types";

const AMOUNT = /^[0-9]+$/;

// The UTC calendar day number. Matches the on-chain rule: block.timestamp / 86400.
export function utcDay(unixSeconds: number): number {
  return Math.floor(unixSeconds / 86400);
}

// JSON with object keys sorted recursively, so key order never changes the hash.
export function canonicalise(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalise(v === undefined ? null : v)).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalise(obj[k]));
    return "{" + parts.join(",") + "}";
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("cannot canonicalise this value");
  return text;
}

export function hashProposal(proposal: unknown): string {
  let text: string;
  try {
    text = canonicalise(proposal);
  } catch {
    text = "unserialisable"; // only reachable for input that is not valid JSON data
  }
  return createHash("sha256").update(text).digest("hex");
}

// Throws if the policy document is not usable. The engine never runs with a bad policy.
export function validatePolicy(policy: Policy): void {
  const bad = (msg: string): never => {
    throw new Error("invalid policy: " + msg);
  };
  const p = policy as unknown as Record<string, unknown>;
  if (p === null || typeof p !== "object") bad("not an object");
  if (!Number.isInteger(p.version) || (p.version as number) < 1) bad("version must be an integer >= 1");
  for (const key of ["per_tx_cap", "per_tx_soft_limit", "daily_cap", "vault_min_reserve"]) {
    if (typeof p[key] !== "string" || !AMOUNT.test(p[key] as string)) bad(key + " must be a numeric string");
  }
  if (BigInt(policy.per_tx_soft_limit) > BigInt(policy.per_tx_cap)) bad("per_tx_soft_limit must be <= per_tx_cap");
  if (!Array.isArray(p.payee_allowlist) || !policy.payee_allowlist.every((x) => typeof x === "string")) {
    bad("payee_allowlist must be an array of strings");
  }
  const bps = p.min_tax_reserve_bps;
  if (!Number.isInteger(bps) || (bps as number) < 0 || (bps as number) > 10000) bad("min_tax_reserve_bps must be an integer 0..10000");
  const th = p.confidence_threshold;
  if (typeof th !== "number" || !(th >= 0 && th <= 1)) bad("confidence_threshold must be a number 0..1");
  const hold = p.chargeback_hold_seconds;
  if (!Number.isInteger(hold) || (hold as number) < 0) bad("chargeback_hold_seconds must be an integer >= 0");
}

type PayoutAction = Extract<Action, { type: "payout" | "mobile_money_payout" }>;

function isPayout(a: Action): a is PayoutAction {
  return a.type === "payout" || a.type === "mobile_money_payout";
}

// Assumption: `conversion` actions move no funds out of the vault, so they count towards no cap.
export function evaluateProposal(proposal: unknown, ctx: EvaluationContext): EvaluationResult {
  validatePolicy(ctx.policy);
  for (const [name, value] of [
    ["spentTodayBaseUnits", ctx.spentTodayBaseUnits],
    ["vaultBalance", ctx.vaultBalance],
    ["milestone.grossAmount", ctx.milestone.grossAmount],
    ["settled.allocated", ctx.settled?.allocated],
  ]) {
    if (typeof value !== "string" || !AMOUNT.test(value)) throw new Error("invalid context: " + name + " must be a numeric string");
  }
  if (!Number.isInteger(ctx.settled.approvedCount) || ctx.settled.approvedCount < 0) throw new Error("invalid context: settled.approvedCount");
  if (typeof ctx.milestone.released !== "boolean") throw new Error("invalid context: milestone.released must be a boolean");
  if (typeof ctx.requestMilestoneId !== "string" || ctx.requestMilestoneId.length === 0) throw new Error("invalid context: requestMilestoneId");
  const pf = ctx.platformFee;
  if (!pf || !Number.isInteger(pf.bps) || pf.bps < 0 || pf.bps > 10_000 || typeof pf.payeeId !== "string" || pf.payeeId.length === 0 || typeof pf.address !== "string") {
    throw new Error("invalid context: platformFee");
  }
  const proposal_hash = hashProposal(proposal);

  // Nothing else can be evaluated safely on a malformed proposal.
  if (!validateProposal(proposal).valid) {
    return { decision: "rejected", reasons: ["SCHEMA_INVALID"], proposal_hash };
  }

  const p = proposal as SettlementProposal;
  const policy = ctx.policy;
  const payouts = p.actions.filter(isPayout);
  const payoutAmounts = payouts.map((a) => BigInt(a.amount));
  const payoutTotal = payoutAmounts.reduce((sum, n) => sum + n, 0n);
  const taxTotal = p.actions
    .filter((a) => a.type === "tax_reserve")
    .reduce((sum, a) => sum + BigInt(a.amount), 0n);

  const rejected: RejectReason[] = [];
  const escalated: EscalateReason[] = [];

  // The proposal must be about the milestone the authenticated request names: the facts, budget and settled log were
  // read for that milestone, so a plan naming another one is refused whatever it contains.
  if (p.milestone_id !== ctx.requestMilestoneId) rejected.push("MILESTONE_ID_MISMATCH");

  // One approved settlement per milestone. Once the Policy Service has signed a plan for this milestone, every further
  // plan is refused, whatever it contains (the operator's approval of an escalation is checked the same way).
  if (ctx.settled.approvedCount > 0) rejected.push("ALREADY_SETTLED");

  // A payout of zero is never valid: it would get a co-signature and an action id for nothing, and it must not
  // turn a plan that moves no money into one that looks like it does. Checked for every proposal with payouts.
  if (payoutAmounts.some((n) => n === 0n)) rejected.push("ZERO_AMOUNT_PAYOUT");

  // Hard rules: they run only when money actually leaves the vault (payout total above zero). A proposal that moves
  // no money cannot break a payee, cap, reserve, duplicate or hold rule, so it is never rejected for one; it goes to
  // a human instead.
  const movesMoney = payoutTotal > 0n;
  if (movesMoney) {
    // In INTERFACES.md order.
    if (ctx.seenProposalHashes.has(proposal_hash)) rejected.push("DUPLICATE_PROPOSAL");

    // Money leaves the vault only for a milestone whose escrow released its funds to the vault, whatever the funding
    // source. Read from the chain by the Policy Service; it does not rely on the caller.
    if (!ctx.milestone.released) rejected.push("MILESTONE_NOT_RELEASED");

    if (ctx.milestone.cardFunded && !ctx.milestone.releaseEligible) rejected.push("HOLD_ACTIVE");

    const payeeBad = payouts.some((a) => {
      if (!policy.payee_allowlist.includes(a.payee_id)) return true;
      if (!Object.hasOwn(ctx.payees, a.payee_id)) return true;
      return ctx.payees[a.payee_id].address.length === 0;
    });
    if (payeeBad) rejected.push("PAYEE_NOT_ALLOWED");

    const perTxCap = BigInt(policy.per_tx_cap);
    if (payoutAmounts.some((n) => n > perTxCap)) rejected.push("OVER_PER_TX_CAP");

    if (BigInt(ctx.spentTodayBaseUnits) + payoutTotal > BigInt(policy.daily_cap)) rejected.push("OVER_DAILY_CAP");

    // The payouts leave the vault; tax_reserve and conversion amounts stay in it.
    // After this proposal the vault must still hold at least vault_min_reserve (the guard enforces the same on-chain).
    if (BigInt(ctx.vaultBalance) - payoutTotal < BigInt(policy.vault_min_reserve)) rejected.push("BELOW_VAULT_RESERVE");

    // grossAmount is the escrow's on-chain milestone amount, which release pays to the vault in full. The Policy
    // Service reads it from the chain itself; it never comes from the agent or the request.
    const gross = BigInt(ctx.milestone.grossAmount);

    // The milestone's budget, cumulative: what earlier approved plans for this milestone allocated, plus this plan's
    // payouts and tax reserve, may not exceed what the escrow released.
    if (BigInt(ctx.settled.allocated) + payoutTotal + taxTotal > gross) rejected.push("OVER_MILESTONE_AMOUNT");

    // The platform fee (fee.ts): exactly one `payout` to the earnings payee, for exactly fee(gross), and that payee must
    // be the earnings address configured in this service. Missing, wrong, doubled, sent by another rail or to another
    // address: rejected. It is a payout like any other, so the caps, the daily cap and the budget rule above count it.
    const expectedFee = platformFee(gross, pf.bps);
    const feeLines = p.actions.filter((a) => (a.type === "payout" || a.type === "mobile_money_payout") && a.payee_id === pf.payeeId);
    const earnings = Object.hasOwn(ctx.payees, pf.payeeId) ? ctx.payees[pf.payeeId] : undefined;
    const feeOk = expectedFee === 0n
      ? feeLines.length === 0
      : feeLines.length === 1 && feeLines[0].type === "payout" && BigInt((feeLines[0] as { amount: string }).amount) === expectedFee &&
        earnings !== undefined && pf.address.length > 0 && earnings.address.toLowerCase() === pf.address.toLowerCase();
    if (!feeOk) rejected.push("FEE_MISMATCH");

    // The tax reserve is a share of the gross milestone amount, required whenever money is paid out.
    // Rule: taxTotal / grossAmount >= min_tax_reserve_bps / 10000, checked as taxTotal * 10000 >= bps * gross.
    if (taxTotal * 10000n < BigInt(policy.min_tax_reserve_bps) * gross) rejected.push("TAX_RESERVE_TOO_LOW");
  }

  // Escalating rules (any proposal).
  const softLimit = BigInt(policy.per_tx_soft_limit);
  if (payoutAmounts.some((n) => n > softLimit)) escalated.push("OVER_SOFT_LIMIT");
  if (p.confidence < policy.confidence_threshold) escalated.push("LOW_CONFIDENCE");
  if (p.needs_human) escalated.push("NEEDS_HUMAN");
  if (!ctx.milestone.identityMatch) escalated.push("IDENTITY_MISMATCH");
  if (p.flags.some((f) => INJECTION_FLAG_CODES.has(f.code))) escalated.push("INJECTION_FLAGGED");
  // The agent's delivery check: a person decides when any acceptance criterion is unmet or unclear. Never a rejection,
  // and a clearly met check changes nothing.
  const check = p.delivery_check ?? [];
  if (check.some((c) => c.status === "unmet")) escalated.push("CRITERIA_UNMET");
  if (check.some((c) => c.status === "unclear")) escalated.push("CRITERIA_UNCLEAR");
  // A plan that pays nobody is never approved automatically, even when nothing else is wrong.
  if (!movesMoney && escalated.length === 0) escalated.push("NO_PAYOUTS");

  if (rejected.length > 0) return { decision: "rejected", reasons: rejected, proposal_hash };
  if (escalated.length > 0) return { decision: "escalated", reasons: escalated, proposal_hash };
  // Unreachable with needs_human=true (it always escalates); kept explicit as the last line of defence.
  if (p.needs_human) return { decision: "escalated", reasons: ["NEEDS_HUMAN"], proposal_hash };
  return { decision: "approved", reasons: [], proposal_hash };
}

/**
 * Flag codes that mean the agent or its input guard saw an injection attempt: the agent's own
 * INJECTION_SUSPECTED (also added by the post-check whenever the input guard found something) and the input
 * guard's pattern codes.
 */
export const INJECTION_FLAG_CODES: ReadonlySet<string> = new Set([
  "INJECTION_SUSPECTED", "IGNORE_RULES", "ROLE_PLAY", "PAY_UNLISTED_ADDRESS", "KEY_REQUEST", "TOOL_REQUEST",
  "REVEAL_PROMPT", "FORCE_OUTPUT",
]);
