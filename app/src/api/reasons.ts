// Reason codes in plain language. docs/INTERFACES.md v0.9 is the source of truth for the Policy Service codes;
// this file only explains them. Codes from the wallet layer, identity check and reconciliation follow docs/API.md.

export interface ReasonInfo { title: string; plain: string; kind: "rejected" | "escalated" | "blocked" | "info" }

export const POLICY_REJECT_CODES = [
  "SCHEMA_INVALID", "ALREADY_SETTLED", "ZERO_AMOUNT_PAYOUT", "DUPLICATE_PROPOSAL", "MILESTONE_NOT_RELEASED", "HOLD_ACTIVE", "PAYEE_NOT_ALLOWED", "OVER_PER_TX_CAP",
  "OVER_DAILY_CAP", "BELOW_VAULT_RESERVE", "OVER_MILESTONE_AMOUNT", "TAX_RESERVE_TOO_LOW",
] as const;
export const POLICY_ESCALATE_CODES = [
  "LOW_CONFIDENCE", "NEEDS_HUMAN", "IDENTITY_MISMATCH", "OVER_SOFT_LIMIT", "INJECTION_FLAGGED", "NO_PAYOUTS",
] as const;

const REASONS: Record<string, ReasonInfo> = {
  // ---- Policy Service: rejected (INTERFACES v0.9) ----
  ALREADY_SETTLED: { kind: "rejected", title: "Already settled", plain: "This milestone was already paid out under an approved plan. A second plan can never pay it again." },
  MILESTONE_NOT_RELEASED: { kind: "rejected", title: "Not released yet", plain: "The escrow has not released this milestone to the vault, so nothing can be paid from it yet." },
  SCHEMA_INVALID: { kind: "rejected", title: "The plan was not readable", plain: "The AI's plan did not match the required format, so nothing in it was considered." },
  ZERO_AMOUNT_PAYOUT: { kind: "rejected", title: "A payment of zero", plain: "The plan contains a payment of $0. That is never allowed." },
  DUPLICATE_PROPOSAL: { kind: "rejected", title: "Already submitted", plain: "This exact plan was already signed or is waiting for a decision. It cannot pay twice." },
  HOLD_ACTIVE: { kind: "rejected", title: "Card protection hold", plain: "The client paid by card and the chargeback protection period has not ended yet." },
  PAYEE_NOT_ALLOWED: { kind: "rejected", title: "Not an approved payee", plain: "The plan pays someone who is not on the approved list, or whose wallet is unknown." },
  OVER_PER_TX_CAP: { kind: "rejected", title: "Over the per-payment limit", plain: "One payment is larger than the most a single payment may be." },
  OVER_DAILY_CAP: { kind: "rejected", title: "Over the daily limit", plain: "Together with today's payments, this goes past the daily limit." },
  BELOW_VAULT_RESERVE: { kind: "rejected", title: "Below the vault reserve", plain: "Paying this would leave less in the vault than the minimum it must keep." },
  OVER_MILESTONE_AMOUNT: { kind: "rejected", title: "More than the milestone", plain: "Together with what was already approved for this milestone, the payments and tax reserve add up to more than it released." },
  TAX_RESERVE_TOO_LOW: { kind: "rejected", title: "Tax reserve too low", plain: "Not enough is set aside for tax. A share of every payout must be reserved." },
  // ---- Policy Service: escalated to a human (INTERFACES v0.9) ----
  LOW_CONFIDENCE: { kind: "escalated", title: "The AI is not sure", plain: "The AI's confidence is below the threshold, so a person decides." },
  NEEDS_HUMAN: { kind: "escalated", title: "Asked for a person", plain: "The AI asked for a human to look at this before anything is paid." },
  IDENTITY_MISMATCH: { kind: "escalated", title: "Names don't match", plain: "The payer's verified name and the customer's name differ (simulated identity check)." },
  OVER_SOFT_LIMIT: { kind: "escalated", title: "Large payment", plain: "A payment is above the review threshold, so a person confirms it." },
  INJECTION_FLAGGED: { kind: "escalated", title: "Suspicious instructions", plain: "The evidence or other input tried to give the AI orders. Nothing was paid; a person decides." },
  NO_PAYOUTS: { kind: "escalated", title: "Pays nobody", plain: "The plan moves no money. Request a new plan or reject it; it cannot be approved." },
  // ---- Wallet review and sending (docs/API.md) ----
  WRONG_NETWORK: { kind: "blocked", title: "Wrong network", plain: "Your wallet is on a different network from this payment. Switch before signing." },
  DUPLICATE_PENDING: { kind: "blocked", title: "Already sending", plain: "The same payment is still on its way. It will not be sent twice." },
  ALREADY_SENT: { kind: "blocked", title: "Already sent", plain: "This payment was already sent. It will not be sent again." },
  BAD_ADDRESS: { kind: "blocked", title: "Bad address", plain: "The recipient address is not valid." },
  BAD_AMOUNT: { kind: "blocked", title: "Bad amount", plain: "The amount is not valid." },
  NO_REFERENCE: { kind: "blocked", title: "No reference", plain: "Every payment needs a reference so it can never be sent twice." },
  WALLET_POLICY: { kind: "blocked", title: "Wallet rule", plain: "Your wallet's own safety rules refuse this transfer." },
  FEE_UNAVAILABLE: { kind: "info", title: "Fee not available yet", plain: "The network fee could not be estimated right now." },
  // ---- Treasury and platform ----
  FUNDING_IN_PROGRESS: { kind: "blocked", title: "Another payment in progress", plain: "Another payment for this milestone is still being funded. This one was not taken twice." },
  AMOUNT_TOO_LARGE: { kind: "blocked", title: "Amount too large", plain: "The amount is above the largest milestone this platform accepts." },
  PLATFORM_ONLY: { kind: "blocked", title: "Platform action", plain: "Only the platform can release, refund or settle a milestone." },
  refund_needed: { kind: "info", title: "Refund needed", plain: "A payment arrived that the escrow will not take; a person refunds it." },
  // ---- Reconciliation ----
  NO_COUNTRY_PROFILE: { kind: "info", title: "No country profile", plain: "The contract has no country profile, so the tax export cannot include it." },
  PAID_NOT_RELEASED: { kind: "info", title: "Paid, not released", plain: "Funds are in escrow and not yet released." },
  RELEASED_NOT_SETTLED: { kind: "info", title: "Released, not settled", plain: "Funds are in the vault and waiting for a settlement." },
  RECEIPT_MISSING: { kind: "info", title: "Receipt missing", plain: "Paid out, but the receipt has not been minted." },
  OFFCHAIN_IN_FLIGHT: { kind: "info", title: "Payout on its way", plain: "The mobile-money or bank leg is still in progress (simulated)." },
};

export function reasonInfo(code: string): ReasonInfo {
  return REASONS[code] ?? { kind: "info", title: code.toLowerCase().replace(/_/g, " "), plain: "See the service documentation for this code." };
}
