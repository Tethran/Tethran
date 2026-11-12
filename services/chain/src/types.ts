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

export type VaultExecuteParams = {
  vault: string;
  to: string;
  amount: string;
  proposalHash: string; // bytes32
  actionId: string; // bytes32
  deadline: number; // unix seconds
  agentSig: string;
  policySig: string;
};

export type SetPayeesParams = { vault: string; version: number; payees: string[]; allowed: boolean; operatorSig: string };
export type RotateSignersParams = {
  vault: string; version: number; agentSigner: string; policySigner: string; operatorSig: string;
};
export type VaultWithdrawParams = { vault: string; version: number; amount: string; operatorSig: string };

export type VaultState = {
  policyVersion: number;
  perTxCap: string;
  dailyCap: string;
  minReserve: string;
  spentToday: string;
  balance: string;
  agentSigner: string;
  policySigner: string;
  operator: string;
  providerPayout: string;
};

export type SetPolicyParams = {
  vault: string;
  version: number;
  perTxCap: string;
  dailyCap: string;
  minReserve: string;
  operatorSig: string;
};

export type ReceiptView = {
  tokenId: number;
  holder: string;
  milestoneId: string; // bytes32 on-chain id
  invoiceHash: string;
  settlementHash: string;
  amount: string;
  chainId: number;
  releaseTx: string;
  mintedAt: number;
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
  // vault (the spending guard is part of it)
  vaultExecute(p: VaultExecuteParams, idempotencyKey: string): Promise<TxRef>;
  setPolicy(p: SetPolicyParams, idempotencyKey: string): Promise<TxRef>;
  setPayees(p: SetPayeesParams, idempotencyKey: string): Promise<TxRef>;
  rotateVaultSigners(p: RotateSignersParams, idempotencyKey: string): Promise<TxRef>;
  vaultWithdraw(p: VaultWithdrawParams, idempotencyKey: string): Promise<TxRef>;
  // receipt
  mintReceipt(p: MintReceiptParams, idempotencyKey: string): Promise<TxRef>;
  // reads
  receiptOf(milestoneId: string): Promise<ReceiptView | undefined>;
  vaultState(vault: string): Promise<VaultState>;
  vaultCheck(vault: string, to: string, amount: string): Promise<{ ok: boolean; reason: string }>;
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
  /** Public RPC used for read-only calls when the primary (an API-key provider) times out. Never used to send. */
  fallbackRpcUrl?: string;
  testnet: boolean;
  /** Blocks to wait before treating a transaction as settled. */
  confirmations: number;
  usdt: string;
  escrow: string;
  receiptNft: string;
};
