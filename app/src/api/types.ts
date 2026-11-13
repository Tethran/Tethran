// Screen-facing types. src/api/index.ts maps the Tethran backend's responses (docs/API.md) into these.
// Money is shown in dollars of test USDT; the backend's base-unit strings are converted only for display.

export type MilestoneStatus = "Draft" | "Funded" | "In review" | "Approved" | "Disputed" | "Released" | "Paid out" | "Refunded";
export type Country = "NG" | "KE" | "ZA" | "GH";
export type Decision = "APPROVED" | "REJECTED" | "ESCALATED";

export interface Milestone {
  id: string;
  contractId: string;
  title: string;
  amount: number;
  fee: number;
  status: MilestoneStatus;
  criteria: string;
  dueDate: string;
  cardHoldEndsAt?: string;
  evidence?: string[];
  /** The escrow milestone exists on-chain (the contract milestone was activated). */
  live: boolean;
  escrowTx?: string | null;
  releaseTx?: string | null;
  /** Transfers out of the provider's vault for this milestone (each co-signed by the Policy Service). */
  payouts?: VaultPayout[];
}

export interface VaultPayout {
  to: string;
  amount: number;
  /** usdt (on-chain), or a SIMULATED rail (mobile money, bank) whose off-chain leg is simulated. */
  rail: string;
  simulated: boolean;
  tx: string | null;
  status: string;
}

export interface Contract {
  id: string;
  title: string;
  provider: string;
  client: string;
  country: Country | null;
  createdAt: string;
  status: string;
  milestones: Milestone[];
}

export interface Invoice {
  id: string;
  contractId: string;
  milestoneId: string;
  number: string;
  amount: number;
  fee: number;
  feePaidBy: "client" | "provider" | "split";
  status: "Unpaid" | "Paid";
  payLink: string;
  issuedAt: string;
  taxId?: string;
  provider: string;
  client: string;
  title: string;
}

export interface Proposal {
  id: string;
  milestoneId: string;
  summary: string;
  payouts: { to: string; method: "phone" | "bank" | "wallet"; amount: number }[];
  decision: Decision;
  /** Policy Service reason codes (docs/INTERFACES.md v0.8). */
  reasons: string[];
  /** The agent's own flags (untrusted output, shown as data). */
  flags: { code: string; detail: string }[];
  needsHuman: boolean;
  confidence: number | null;
  agentMode: string | null;
  traceId: string | null;
  approvalId: string | null;
  createdAt: string;
}

export interface Payout {
  id: string;
  milestoneId: string;
  method: "phone" | "bank" | "wallet";
  recipient: string;
  amount: number;
  fee: number;
  status: "Pending" | "Sent" | "Held";
  simulated: boolean;
  txHash?: string;
}

export interface Receipt {
  id: string;
  milestoneId: string;
  milestoneTitle: string;
  amount: number;
  date: string;
  tokenId: string;
  contentHash: string;
  txHash: string;
  network: string;
  holder?: string;
}

export interface ReconRow {
  id: string;
  invoice: string;
  payment: string | null;
  escrow: string | null;
  payout: string | null;
  receipt: string | null;
  country: Country | null;
  amount: number;
  complete: boolean;
  gaps: string[];
}

export interface ApprovalItem {
  id: string;
  milestoneId: string;
  proposal: Proposal;
  payee: string;
  amount: number;
  createdAt: string;
  /** A plan that moves no money: only "request a new plan" or "reject" (INTERFACES v0.8). */
  movesNoMoney: boolean;
}

export interface IdentityHold { milestoneId: string; reason: string; status: string; openedAt: string }

export interface Dispute {
  milestoneId: string;
  title: string;
  amount: number;
  timeout: number;
  attestations: { signer: string; kind: number; releaseToProvider: boolean; at: string }[];
}

export interface AuditEntry { id: string; at: string; actor: string; action: string; reasons: string[] }

export interface Limits {
  perPayment: number;
  softLimit: number;
  daily: number;
  taxReservePercent: number;
  confidenceThreshold: number;
  approvedPayees: string[];
  version: number;
}

export interface WalletReview {
  from: string;
  recipient: { address: string; savedName: string | null };
  network: { name: string; chainId: number };
  amount: number;
  feeDisplay: string | null;
  canSign: boolean;
  blocked: string[];
  paymentReference: string;
  custody: string;
}

/** One line of a demo wallet's recent activity. */
export interface WalletActivity {
  kind: "top_up" | "send" | "payout" | string;
  direction: "in" | "out";
  amount: number;
  at: string;
  txHash: string | null;
  detail: string;
  /** A simulated card top-up (test USDT minted by the treasury). */
  simulated: boolean;
}
