// The part of ChainClient the backend uses, so tests can pass a fake. The real one is EvmChainClient
// (services/chain), bound to the treasury key. The backend never talks to a chain any other way.
import type {
  CreateAndFundParams, MilestoneView, MintReceiptParams, ReceiptView, SetPayeesParams, SetPolicyParams, TxRef, VaultExecuteParams, VaultState,
} from "../../chain/src/index";

export interface TreasuryChain {
  chainId: number;
  createAndFund(p: CreateAndFundParams, idempotencyKey: string): Promise<TxRef>;
  release(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refund(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refundApproved(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  vaultExecute(p: VaultExecuteParams, idempotencyKey: string): Promise<TxRef>;
  mintReceipt(p: MintReceiptParams, idempotencyKey: string): Promise<TxRef>;
  setPolicy(p: SetPolicyParams, idempotencyKey: string): Promise<TxRef>;
  setPayees(p: SetPayeesParams, idempotencyKey: string): Promise<TxRef>;
  decide(milestoneId: string, releaseToProvider: boolean, sigs: string[], signers: string[], idempotencyKey: string): Promise<TxRef>;
  attestationTypedData(milestoneId: string, kind: 0 | 1 | 2, releaseToProvider: boolean): {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: { Attestation: { name: string; type: string }[] };
    message: { milestoneId: string; kind: number; releaseToProvider: boolean };
  };
  milestone(milestoneId: string): Promise<MilestoneView>;
  vaultState(vault: string): Promise<VaultState>;
  /** The vault contract's own guard (the same rule execute enforces), as a view call. */
  vaultCheck?(vault: string, to: string, amount: string): Promise<{ ok: boolean; reason: string }>;
  receiptOf(milestoneId: string): Promise<ReceiptView | undefined>;
  balance(address: string): Promise<string>;
  waitConfirmed(txHash: string): Promise<void>;
  /** TEST TOKEN FAUCET: stands in for the simulated fiat-to-USDT conversion. */
  mintTestUsdt(to: string, amount: string, idempotencyKey: string): Promise<TxRef>;
  /** Transfers of the configured USDT inside a confirmed transaction. */
  /** Our token's Transfer logs in a successful tx on this chain, with the block time (see EvmChainClient). */
  usdtTransfersInTx(txHash: string): Promise<{ from: string; to: string; value: string; blockTime: number }[]>;
}
