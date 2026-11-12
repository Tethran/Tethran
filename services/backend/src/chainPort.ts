// The part of ChainClient the backend uses, so tests can pass a fake. The real one is EvmChainClient
// (services/chain), bound to the treasury key. The backend never talks to a chain any other way.
import type {
  CreateAndFundParams, MilestoneView, MintReceiptParams, ReceiptView, TxRef, VaultExecuteParams, VaultState,
} from "../../chain/src/index";

export interface TreasuryChain {
  chainId: number;
  createAndFund(p: CreateAndFundParams, idempotencyKey: string): Promise<TxRef>;
  release(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refund(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refundApproved(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  vaultExecute(p: VaultExecuteParams, idempotencyKey: string): Promise<TxRef>;
  mintReceipt(p: MintReceiptParams, idempotencyKey: string): Promise<TxRef>;
  milestone(milestoneId: string): Promise<MilestoneView>;
  vaultState(vault: string): Promise<VaultState>;
  receiptOf(milestoneId: string): Promise<ReceiptView | undefined>;
  balance(address: string): Promise<string>;
  waitConfirmed(txHash: string): Promise<void>;
  /** TEST TOKEN FAUCET: stands in for the simulated fiat-to-USDT conversion. */
  mintTestUsdt(to: string, amount: string, idempotencyKey: string): Promise<TxRef>;
  /** Transfers of the configured USDT inside a confirmed transaction. */
  usdtTransfersInTx(txHash: string): Promise<{ from: string; to: string; value: string }[]>;
}
