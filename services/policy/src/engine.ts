import { createHash } from "node:crypto";
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
  ]) {
    if (typeof value !== "string" || !AMOUNT.test(value)) throw new Error("invalid context: " + name + " must be a numeric string");
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

  // Rejecting rules, in INTERFACES.md order.
  if (ctx.seenProposalHashes.has(proposal_hash)) rejected.push("DUPLICATE_PROPOSAL");

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

  // The tax reserve is a share of the gross milestone payout amount (what the escrow released).
  // Rule: taxTotal / grossAmount >= bps / 10000, done as integers.
  const gross = BigInt(ctx.milestone.grossAmount);
  if (taxTotal * 10000n < BigInt(policy.min_tax_reserve_bps) * gross) rejected.push("TAX_RESERVE_TOO_LOW");

  // Escalating rules.
  const softLimit = BigInt(policy.per_tx_soft_limit);
  if (payoutAmounts.some((n) => n > softLimit)) escalated.push("OVER_SOFT_LIMIT");
  if (p.confidence < policy.confidence_threshold) escalated.push("LOW_CONFIDENCE");
  if (p.needs_human) escalated.push("NEEDS_HUMAN");
  if (!ctx.milestone.identityMatch) escalated.push("IDENTITY_MISMATCH");

  if (rejected.length > 0) return { decision: "rejected", reasons: rejected, proposal_hash };
  if (escalated.length > 0) return { decision: "escalated", reasons: escalated, proposal_hash };
  return { decision: "approved", reasons: [], proposal_hash };
}
