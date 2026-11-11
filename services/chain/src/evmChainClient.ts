import { Contract, Interface, JsonRpcProvider, id as keccakUtf8, isError } from "ethers";
import type { Provider } from "ethers";
import type { IdempotencyStore } from "./idempotency";
import type {
  ChainClient,
  ChainConfig,
  CreateAndFundParams,
  MintReceiptParams,
  SetPolicyParams,
  TxRef,
  TxStatus,
  VaultExecuteParams,
} from "./types";

/**
 * The account that sends transactions. An ethers Signer fits; so can a WDK account behind a small adapter.
 * The key behind it never passes through this module.
 */
export interface TxSender {
  getAddress(): Promise<string>;
  sendTransaction(tx: { to: string; data: string }): Promise<{ hash: string }>;
}

const ESCROW_ABI = [
  "function createAndFund(bytes32 milestoneId, address client, address provider, address arbiter, address vault, uint256 amount, uint64 timeout, bool cardFunded, uint32 holdSeconds)",
  "function approve(bytes32 milestoneId)",
  "function dispute(bytes32 milestoneId)",
  "function release(bytes32 milestoneId)",
  "function refund(bytes32 milestoneId)",
  "function state(bytes32 milestoneId) view returns (uint8)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];

export const ESCROW_STATES = ["None", "Funded", "Approved", "Disputed", "Released", "Refunded"] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

/** A key was claimed but no transaction hash was recorded. Do not resend; check the chain by hand. */
export class IdempotencyInFlightError extends Error {
  constructor(key: string) {
    super(`idempotency key "${key}" is in flight or its outcome is unknown; not sending again`);
  }
}

/** The contract behind this call is not built yet. */
export class NotBuiltYetError extends Error {
  constructor(method: string, waitingFor: string) {
    super(`ChainClient.${method} is not built yet: waiting for ${waitingFor}`);
  }
}

/** On-chain milestone id: keccak256 of the UTF-8 milestone UUID. */
export function milestoneIdToBytes32(milestoneId: string): string {
  return keccakUtf8(milestoneId);
}

export class EvmChainClient implements ChainClient {
  readonly chainId: number;
  private readonly provider: Provider;
  private readonly escrow = new Interface(ESCROW_ABI);
  private readonly erc20 = new Interface(ERC20_ABI);

  constructor(
    private readonly config: ChainConfig,
    private readonly sender: TxSender,
    private readonly store: IdempotencyStore,
    provider?: Provider,
  ) {
    if (!config.testnet) throw new Error("EvmChainClient: test networks only");
    if (!config.usdt || !config.escrow) throw new Error(`chain "${config.key}" has no usdt or escrow address yet`);
    this.chainId = config.chainId;
    this.provider = provider ?? new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  }

  // ---- escrow ----

  async createAndFund(p: CreateAndFundParams, idempotencyKey: string): Promise<TxRef> {
    const amount = BigInt(p.amount);
    const done = this.finished(idempotencyKey);
    if (done) return done;

    // The escrow pulls the amount, so the funder has to allow exactly that first.
    const funder = await this.sender.getAddress();
    const token = new Contract(this.config.usdt, ERC20_ABI, this.provider);
    if ((await token.allowance(funder, this.config.escrow)) < amount) {
      const allow = await this.send(
        this.config.usdt,
        this.erc20.encodeFunctionData("approve", [this.config.escrow, amount]),
        `${idempotencyKey}:allowance`,
      );
      await this.waitConfirmed(allow.txHash);
    }

    return this.send(
      this.config.escrow,
      this.escrow.encodeFunctionData("createAndFund", [
        milestoneIdToBytes32(p.milestoneId),
        p.client,
        p.provider,
        p.arbiter,
        p.vault,
        amount,
        p.timeout,
        p.cardFunded,
        p.holdSeconds,
      ]),
      idempotencyKey,
    );
  }

  approve(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("approve", milestoneId, idempotencyKey);
  }

  dispute(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("dispute", milestoneId, idempotencyKey);
  }

  async decide(): Promise<TxRef> {
    throw new NotBuiltYetError("decide", "MilestoneEscrow.decide (EIP-712 attestations)");
  }

  release(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("release", milestoneId, idempotencyKey);
  }

  refund(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("refund", milestoneId, idempotencyKey);
  }

  // ---- vault, guard, receipt: contracts not built yet ----

  async vaultExecute(_p: VaultExecuteParams, _idempotencyKey: string): Promise<TxRef> {
    throw new NotBuiltYetError("vaultExecute", "the vault contract");
  }

  async setPolicy(_p: SetPolicyParams, _idempotencyKey: string): Promise<TxRef> {
    throw new NotBuiltYetError("setPolicy", "the SpendingGuard contract");
  }

  async mintReceipt(_p: MintReceiptParams, _idempotencyKey: string): Promise<TxRef> {
    throw new NotBuiltYetError("mintReceipt", "the ReceiptNFT contract");
  }

  // ---- reads ----

  async txStatus(txHash: string): Promise<TxStatus> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (receipt) return receipt.status === 1 ? "confirmed" : "failed";
    return (await this.provider.getTransaction(txHash)) ? "pending" : "unknown";
  }

  async balance(address: string): Promise<string> {
    const token = new Contract(this.config.usdt, ERC20_ABI, this.provider);
    return ((await token.balanceOf(address)) as bigint).toString();
  }

  // ---- extras outside the ChainClient interface ----

  async escrowState(milestoneId: string): Promise<EscrowState> {
    const escrow = new Contract(this.config.escrow, ESCROW_ABI, this.provider);
    return ESCROW_STATES[Number(await escrow.state(milestoneIdToBytes32(milestoneId)))];
  }

  /** TEST TOKEN FAUCET. Mints TestUSDT; it only exists on test networks. */
  mintTestUsdt(to: string, amount: string, idempotencyKey: string): Promise<TxRef> {
    return this.send(this.config.usdt, this.erc20.encodeFunctionData("mint", [to, BigInt(amount)]), idempotencyKey);
  }

  /** Polls txStatus for the same hash until it leaves "pending"/"unknown". Never resubmits. */
  async waitConfirmed(txHash: string, timeoutMs = 180_000, pollMs = 1_500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.txStatus(txHash);
      if (status === "confirmed") return;
      if (status === "failed") throw new Error(`transaction failed: ${txHash}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${txHash} (last status: ${status})`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // ---- internals ----

  private escrowCall(fn: "approve" | "dispute" | "release" | "refund", milestoneId: string, key: string) {
    return this.send(this.config.escrow, this.escrow.encodeFunctionData(fn, [milestoneIdToBytes32(milestoneId)]), key);
  }

  /** The stored TxRef when this key has already produced a transaction. */
  private finished(idempotencyKey: string): TxRef | undefined {
    const prev = this.store.get(idempotencyKey);
    if (!prev) return undefined;
    if (!prev.txHash) throw new IdempotencyInFlightError(idempotencyKey);
    if (prev.chainId !== this.chainId) {
      throw new Error(`idempotency key "${idempotencyKey}" was used on chain ${prev.chainId}`);
    }
    return { txHash: prev.txHash, chainId: prev.chainId, idempotencyKey };
  }

  /**
   * Sends at most one transaction per idempotency key.
   * A repeated key returns the first TxRef. If a send fails in a way that proves nothing was
   * broadcast (the node rejected it up front), the key is released; otherwise it stays claimed.
   */
  private async send(to: string, data: string, idempotencyKey: string): Promise<TxRef> {
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const done = this.finished(idempotencyKey);
    if (done) return done;
    if (!this.store.reserve(idempotencyKey, this.chainId)) throw new IdempotencyInFlightError(idempotencyKey);

    let hash: string;
    try {
      ({ hash } = await this.sender.sendTransaction({ to, data }));
    } catch (e) {
      if (isError(e, "CALL_EXCEPTION") || isError(e, "INSUFFICIENT_FUNDS")) this.store.release(idempotencyKey);
      throw e;
    }
    this.store.complete(idempotencyKey, hash);
    return { txHash: hash, chainId: this.chainId, idempotencyKey };
  }
}
