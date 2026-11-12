// Mirrors docs/INTERFACES.md section 3a. Change that file first, by agreement.
// Amounts are strings in base units (USDT: 6 decimals). Never floating point.

export type TxRef = { txHash: string; chainId: number; idempotencyKey: string };
export type TxStatus = "pending" | "confirmed" | "failed" | "unknown";
export type EscrowState = "None" | "Funded" | "Approved" | "Disputed" | "Released" | "Refunded";

export type CreateAndFundParams = {
  milestoneId: string;
  client: string;
  provider: string;
  arbiter: string;
  vault: string;
  amount: string;
  timeout: number; // unix seconds
  cardFunded: boolean;
  holdSeconds: number;
};

/** A milestone as stored by the escrow contract. */
export type MilestoneView = {
  funder: string;
  client: string;
  provider: string;
  arbiter: string;
  vault: string;
  amount: string;
  timeout: number;
  approvedAt: number;
  holdSeconds: number;
  cardFunded: boolean;
  state: EscrowState;
};

export type VaultExecuteParams = { vault: string; to: string; amount: string; agentSig: string; policySig: string };

export type SetPolicyParams = {
  guard: string;
  version: number;
  perTxCap: string;
  dailyCap: string;
  minReserve: string;
  operatorSig: string;
};

export type MintReceiptParams = {
  milestoneId: string;
  holder: string;
  invoiceHash: string;
  settlementHash: string;
  amount: string;
  releaseTx: string;
};

export interface ChainClient {
  chainId: number;
  // escrow
  createAndFund(p: CreateAndFundParams, idempotencyKey: string): Promise<TxRef>;
  approve(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  dispute(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  decide(
    milestoneId: string,
    releaseToProvider: boolean,
    sigs: string[],
    signers: string[],
    idempotencyKey: string,
  ): Promise<TxRef>;
  release(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refund(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refundApproved(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  // vault and guard
  vaultExecute(p: VaultExecuteParams, idempotencyKey: string): Promise<TxRef>;
  setPolicy(p: SetPolicyParams, idempotencyKey: string): Promise<TxRef>;
  // receipt
  mintReceipt(p: MintReceiptParams, idempotencyKey: string): Promise<TxRef>;
  // reads
  milestone(milestoneId: string): Promise<MilestoneView>;
  txStatus(txHash: string): Promise<TxStatus>;
  balance(address: string): Promise<string>;
}

/** One entry of config/chains.json. */
export type ChainConfig = {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  testnet: boolean;
  /** Blocks to wait before treating a transaction as settled. */
  confirmations: number;
  usdt: string;
  escrow: string;
  receiptNft: string;
};
