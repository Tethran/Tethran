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

export function makeCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    policy,
    payees: {
      "payee-1": { address: "0x00000000000000000000000000000000000000a1", rail: "usdt", simulated: false },
      "payee-2": { address: "0x00000000000000000000000000000000000000a2", rail: "mpesa", simulated: true },
    },
    spentTodayBaseUnits: "0",
    nowUnixSeconds: 1_800_000_000,
    seenProposalHashes: new Set<string>(),
    milestone: { cardFunded: false, releaseEligible: true, identityMatch: true },
    ...overrides,
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

export function withActions(actions: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...goodProposal(), actions, ...extra };
}
