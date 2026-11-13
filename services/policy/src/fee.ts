// Tethran's platform fee (the business model): 5% of each milestone's gross amount, paid by the freelancer out of the
// settlement, to the Tethran earnings account. Computed here, deterministically; never by the agent. The Policy
// Service enforces it (FEE_MISMATCH) and the backend uses the same function to tell the agent and to build replays.
//
// Rounding: fee = round_half_up(gross * PLATFORM_FEE_BPS / 10000) in USDT base units (6 decimals). For any whole-cent
// milestone (gross = cents * 10^4 base units) 5% is exact, so no rounding happens in practice.
// Base: the GROSS milestone amount, the same base as the tax reserve (min_tax_reserve_bps of gross). The freelancer
// receives net = gross - fee - tax reserve.

/** 5% in basis points. A code constant, not a policy setting: changing the fee is a code change with a review. */
export const PLATFORM_FEE_BPS = 500;
/** The reserved payee id of the Tethran earnings account (in production a company treasury; in the demo a demo wallet). */
export const EARNINGS_PAYEE_ID = "tethran_earnings";

export function platformFee(gross: bigint, bps: number = PLATFORM_FEE_BPS): bigint {
  if (gross < 0n) throw new Error("gross must not be negative");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("fee bps must be an integer 0..10000");
  return (gross * BigInt(bps) + 5_000n) / 10_000n;
}
