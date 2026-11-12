// Types for the Policy Service rule engine. See docs/INTERFACES.md sections 1 and 2.

export type Decision = "approved" | "escalated" | "rejected";

export type RejectReason =
  | "SCHEMA_INVALID"
  | "DUPLICATE_PROPOSAL"
  | "HOLD_ACTIVE"
  | "PAYEE_NOT_ALLOWED"
  | "OVER_PER_TX_CAP"
  | "OVER_DAILY_CAP"
  | "BELOW_VAULT_RESERVE"
  | "TAX_RESERVE_TOO_LOW"
  | "OVER_MILESTONE_AMOUNT"
  | "ZERO_AMOUNT_PAYOUT"
  | "MILESTONE_NOT_RELEASED"
  | "ALREADY_SETTLED"
  | "MILESTONE_ID_MISMATCH";

export type EscalateReason = "LOW_CONFIDENCE" | "NEEDS_HUMAN" | "IDENTITY_MISMATCH" | "OVER_SOFT_LIMIT" | "INJECTION_FLAGGED" | "NO_PAYOUTS";

export type ReasonCode = RejectReason | EscalateReason;

// All money fields are strings of base units (USDT has 6 decimals).
export interface Policy {
  version: number;
  per_tx_cap: string;
  per_tx_soft_limit: string;
  daily_cap: string;
  vault_min_reserve: string; // vault balance floor; checked here and enforced on-chain by the guard
  payee_allowlist: string[];
  min_tax_reserve_bps: number;
  confidence_threshold: number;
  chargeback_hold_seconds: number;
}

export type Action =
  | { type: "payout"; payee_id: string; amount: string; asset: "USDT" }
  | { type: "mobile_money_payout"; payee_id: string; amount: string; provider: "mpesa" | "mtn_momo" | "airtel" | "bank" }
  | { type: "tax_reserve"; amount: string; reason: string }
  | { type: "conversion"; amount: string; target: string; condition: string };

export interface SettlementProposal {
  milestone_id: string;
  confidence: number;
  evidence_used: string[];
  actions: Action[];
  flags: { code: string; detail: string }[];
  needs_human: boolean;
}

// One row of the payees table. Simulated rails are labelled simulated.
export interface ResolvedPayee {
  address: string;
  rail: string;
  simulated: boolean;
}

export interface MilestoneFacts {
  cardFunded: boolean;
  releaseEligible: boolean;
  // The escrow milestone is in state Released on-chain (its funds are in the vault). Payouts need this, whatever the
  // funding source.
  released: boolean;
  identityMatch: boolean;
  // Gross milestone payout amount: what the escrow released to the vault, in base units.
  // The minimum tax reserve is a share of this.
  grossAmount: string;
}

// Everything the rules need. The engine reads no clock and does no I/O.
export interface EvaluationContext {
  policy: Policy;
  payees: Record<string, ResolvedPayee>;
  spentTodayBaseUnits: string; // already approved in the current UTC day
  vaultBalance: string; // USDT held by the vault of the provider right now, in base units
  nowUnixSeconds: number; // reserved for callers; the day-window is applied by whoever fills spentToday
  seenProposalHashes: ReadonlySet<string>;
  milestone: MilestoneFacts;
  // From the Policy Service's own log of signed (approved) proposals for this milestone: how many, and how much they
  // allocated (payouts plus tax reserve, base units).
  settled: { approvedCount: number; allocated: string };
  // The milestone the authenticated request is about (POST /v1/proposals body `milestone_id`, sent by the backend).
  // Every fact above was read for this milestone. A proposal naming any other milestone is rejected.
  requestMilestoneId: string;
}

export interface EvaluationResult {
  decision: Decision;
  reasons: ReasonCode[];
  proposal_hash: string;
}
