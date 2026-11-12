import type { EvaluationContext, Policy } from "../src/index";

export const policy: Policy = {
  version: 1,
  per_tx_cap: "1000000000", // 1000 USDT
  per_tx_soft_limit: "500000000", // 500 USDT
  daily_cap: "2000000000", // 2000 USDT
  vault_min_reserve: "0",
  payee_allowlist: ["payee-1", "payee-2"],
  min_tax_reserve_bps: 1000, // 10%
  confidence_threshold: 0.7,
  chargeback_hold_seconds: 0,
};

// A test that does not set a milestone is not about the milestone amount or the tax reserve: it gets a gross amount
// far above any payout (OVER_MILESTONE_AMOUNT out of the way) and a 0% tax rule. Tests about either set the milestone
// with milestoneOf() and keep the policy's 10% tax rule. A milestone given with grossAmount "0" means the same as no
// milestone for amounts: the test only sets a flag (card hold, identity), so it gets LARGE_GROSS and a 0% tax rule.
export const LARGE_GROSS = "1000000000000"; // 1,000,000 USDT
export function makeCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const aboutAmounts = overrides.milestone !== undefined && overrides.milestone.grossAmount !== "0";
  const pol = overrides.policy ?? policy;
  return {
    ...overrides,
    policy: aboutAmounts ? pol : { ...pol, min_tax_reserve_bps: 0 },
    payees: overrides.payees ?? {
      "payee-1": { address: "0x00000000000000000000000000000000000000a1", rail: "usdt", simulated: false },
      "payee-2": { address: "0x00000000000000000000000000000000000000a2", rail: "mpesa", simulated: true },
    },
    spentTodayBaseUnits: overrides.spentTodayBaseUnits ?? "0",
    vaultBalance: overrides.vaultBalance ?? "10000000000", // 10,000 USDT
    nowUnixSeconds: overrides.nowUnixSeconds ?? 1_800_000_000,
    seenProposalHashes: overrides.seenProposalHashes ?? new Set<string>(),
    settled: overrides.settled ?? { approvedCount: 0, allocated: "0" },
    milestone: aboutAmounts ? { ...overrides.milestone!, released: overrides.milestone!.released ?? true } : { cardFunded: false, releaseEligible: true, released: true, identityMatch: true, ...overrides.milestone, grossAmount: LARGE_GROSS },
  };
}
// 450 USDT payout + 50 USDT tax reserve: tax is exactly 10% of the 500 USDT total.
export function goodProposal(): Record<string, unknown> {
  return {
    milestone_id: "11111111-1111-4111-8111-111111111111",
    confidence: 0.9,
    evidence_used: ["invoice.pdf"],
    actions: [
      { type: "payout", payee_id: "payee-1", amount: "450000000", asset: "USDT" },
      { type: "tax_reserve", amount: "50000000", reason: "tax set aside" },
    ],
    flags: [],
    needs_human: false,
  };
}

// Milestone facts with a given gross amount (base units).
export function milestoneOf(grossAmount: string, extra: Partial<EvaluationContext["milestone"]> = {}) {
  return { cardFunded: false, releaseEligible: true, released: true, identityMatch: true, grossAmount, ...extra } as EvaluationContext["milestone"];
}

export function withActions(actions: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...goodProposal(), actions, ...extra };
}
