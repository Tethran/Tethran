import {
  AbiCoder, Interface, JsonRpcProvider, MaxUint256, concat, decodeBytes32String, id as keccakUtf8, isError, keccak256,
} from "ethers";
import { assertTestNetwork } from "./config";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";
import type {
  ChainClient,
  ChainConfig,
  CreateAndFundParams,
  EscrowState,
  MilestoneView,
  MintReceiptParams,
  RotateSignersParams,
  SetPayeesParams,
  SetPolicyParams,
  TxRef,
  TxStatus,
  VaultExecuteParams,
  VaultState,
  VaultWithdrawParams,
} from "./types";

/**
 * The account that sends transactions. An ethers Signer fits; so can a WDK account behind a small adapter.
 * The key behind it never passes through this module.
 * Do not wrap the signer in ethers' NonceManager: it does not roll its counter back after a failed send.
 */
export interface TxSender {
  getAddress(): Promise<string>;
  sendTransaction(tx: { to: string; data: string }): Promise<{ hash: string }>;
}

/** The part of an ethers JsonRpcProvider this client uses. */
export type ChainReader = Pick<
  JsonRpcProvider,
  "send" | "call" | "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "getBlockNumber"
>;

const ESCROW_ABI = [
  "function createAndFund(bytes32 milestoneId, address client, address provider, address arbiter, address vault, uint256 amount, uint64 timeout, bool cardFunded, uint32 holdSeconds)",
  "function approve(bytes32 milestoneId)",
  "function dispute(bytes32 milestoneId)",
  "function decide(bytes32 milestoneId, bool releaseToProvider, bytes[] sigs, address[] signers)",
  "function release(bytes32 milestoneId)",
  "function refund(bytes32 milestoneId)",
  "function refundApproved(bytes32 milestoneId)",
  "function milestone(bytes32 milestoneId) view returns (tuple(address funder, address client, address provider, address arbiter, address vault, uint256 amount, uint64 timeout, uint64 approvedAt, uint32 holdSeconds, bool cardFunded, uint8 state))",
];
const VAULT_ABI = [
  "function execute(address to, uint256 amount, bytes32 proposalHash, bytes32 actionId, uint256 deadline, bytes agentSig, bytes policySig)",
  "function setPolicy(uint256 version, uint256 perTxCap, uint256 dailyCap, uint256 minReserve, bytes operatorSig)",
  "function setPayees(uint256 version, address[] payees, bool allowed, bytes operatorSig)",
  "function rotateSigners(uint256 version, address agentSigner, address policySigner, bytes operatorSig)",
  "function withdrawToProvider(uint256 version, uint256 amount, bytes operatorSig)",
  "function check(address to, uint256 amount) view returns (bool ok, bytes32 reason)",
  "function spentToday() view returns (uint256)",
  "function policyVersion() view returns (uint256)",
  "function perTxCap() view returns (uint256)",
  "function dailyCap() view returns (uint256)",
  "function minReserve() view returns (uint256)",
  "function agentSigner() view returns (address)",
  "function policySigner() view returns (address)",
  "function operator() view returns (address)",
  "function providerPayout() view returns (address)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];

/**
 * ethers error codes that mean the node refused the transaction before accepting it, so nothing was
 * broadcast: a revert at gas estimation, no gas money, a nonce already used, or an underpriced replacement.
 * Anything else (timeouts, network errors, unknown errors) is treated as "may have been sent".
 */
const REJECTED_BEFORE_BROADCAST = ["CALL_EXCEPTION", "INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"] as const;

export const ESCROW_STATES: readonly EscrowState[] = ["None", "Funded", "Approved", "Disputed", "Released", "Refunded"];

/** A key was claimed but no transaction hash was recorded. Do not resend; use resolve(). */
export class IdempotencyInFlightError extends Error {
  constructor(key: string) {
    super(`idempotency key "${key}" is in flight or its outcome is unknown; not sending again (see resolve)`);
  }
}

/** The same key was used for a different call. That is a caller bug, never a retry. */
export class IdempotencyKeyReuseError extends Error {
  constructor(key: string) {
    super(`idempotency key "${key}" was already used for a different call`);
  }
}

/** resolve() could not prove that the transaction failed or never landed, so the key stays claimed. */
export class CannotResolveError extends Error {}

/** The contract behind this call is not built yet. */
export class NotBuiltYetError extends Error {
  constructor(method: string, waitingFor: string) {
    super(`ChainClient.${method} is not built yet: waiting for ${waitingFor}`);
  }
}

/** The milestone on-chain is not the one the backend asked for. */
export class MilestoneMismatchError extends Error {
  constructor(readonly fields: string[]) {
    super(`on-chain milestone does not match the request: ${fields.join(", ")}`);
  }
}

/**
 * Id of one action of a proposal: keccak256(abi.encode(bytes32 proposalHash, uint256 actionIndex)).
 * The vault lets each id be paid once.
 */
export function vaultActionId(proposalHash: string, actionIndex: number): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [proposalHash, actionIndex]));
}

/** EIP-712 types of the vault, as in docs/INTERFACES.md section 3. */
export const VAULT_TYPES = {
  Transfer: [
    { name: "to", type: "address" }, { name: "amount", type: "uint256" },
    { name: "proposalHash", type: "bytes32" }, { name: "actionId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  SetPolicy: [
    { name: "version", type: "uint256" }, { name: "perTxCap", type: "uint256" },
    { name: "dailyCap", type: "uint256" }, { name: "minReserve", type: "uint256" },
  ],
  SetPayees: [
    { name: "version", type: "uint256" }, { name: "payees", type: "address[]" }, { name: "allowed", type: "bool" },
  ],
  RotateSigners: [
    { name: "version", type: "uint256" }, { name: "agentSigner", type: "address" },
    { name: "policySigner", type: "address" },
  ],
  Withdraw: [{ name: "version", type: "uint256" }, { name: "amount", type: "uint256" }],
} as const;

/** On-chain milestone id: keccak256 of the UTF-8 milestone UUID. */
export function milestoneIdToBytes32(milestoneId: string): string {
  return keccakUtf8(milestoneId);
}

/**
 * The backend calls this after every funding, before it relies on the milestone:
 * state alone proves nothing about who funded it, how much, or where a release would go.
 */
export function assertMilestoneMatches(
  onChain: MilestoneView,
  expected: CreateAndFundParams & { funder: string },
  expectedState: EscrowState = "Funded",
): void {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const wrong: string[] = [];
  if (onChain.state !== expectedState) wrong.push(`state is ${onChain.state}`);
  for (const f of ["funder", "client", "provider", "arbiter", "vault"] as const) {
    if (!same(onChain[f], expected[f])) wrong.push(f);
  }
  if (BigInt(onChain.amount) !== BigInt(expected.amount)) wrong.push("amount");
  if (onChain.timeout < expected.timeout) wrong.push("timeout"); // a dispute may only push it out
  if (onChain.cardFunded !== expected.cardFunded) wrong.push("cardFunded");
  if (onChain.holdSeconds !== expected.holdSeconds) wrong.push("holdSeconds");
  if (wrong.length > 0) throw new MilestoneMismatchError(wrong);
}

/**
 * The provider this client expects. cacheTimeout -1 turns off the short response cache in ethers: with it on,
 * two sends a few milliseconds apart read the same cached account nonce and the second one is refused.
 */
export function newProvider(config: ChainConfig): JsonRpcProvider {
  return new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true, cacheTimeout: -1 });
}

export type EvmChainClientOptions = {
  provider?: ChainReader;
  /** resolve() treats a transaction as "never landed" only when the key is at least this old. */
  resolveMinAgeMs?: number;
  /** How often to ask again when gas estimation reverts. Default: 2 on chains with confirmations > 1, else 0. */
  estimateRetries?: number;
  estimateRetryMs?: number;
};

export class EvmChainClient implements ChainClient {
  readonly chainId: number;
  private readonly provider: ChainReader;
  private readonly resolveMinAgeMs: number;
  private readonly estimateRetries: number;
  private readonly estimateRetryMs: number;
  private readonly escrow = new Interface(ESCROW_ABI);
  private readonly erc20 = new Interface(ERC20_ABI);
  private readonly vaultAbi = new Interface(VAULT_ABI);
  private chainChecked?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private senderAddress?: Promise<string>;

  constructor(
    private readonly config: ChainConfig,
    private readonly sender: TxSender,
    private readonly store: IdempotencyStore,
    options: EvmChainClientOptions = {},
  ) {
    assertTestNetwork(config.chainId, config.testnet, `EvmChainClient chain "${config.key}"`);
    if (!config.usdt || !config.escrow) throw new Error(`chain "${config.key}" has no usdt or escrow address yet`);
    this.chainId = config.chainId;
    this.provider = options.provider ?? newProvider(config);
    this.resolveMinAgeMs = options.resolveMinAgeMs ?? 120_000;
    this.estimateRetries = options.estimateRetries ?? (config.confirmations > 1 ? 2 : 0);
    this.estimateRetryMs = options.estimateRetryMs ?? 5_000;
  }

  /**
   * Confirms once that the RPC endpoint really is the configured chain. Every read and write waits for it,
   * so a wrong RPC_URL override cannot point the client at another network.
   */
  ready(): Promise<void> {
    this.chainChecked ??= (async () => {
      const reported = Number(BigInt(await this.provider.send("eth_chainId", [])));
      if (reported !== this.chainId) {
        throw new Error(`RPC reports chain id ${reported}, config "${this.config.key}" says ${this.chainId}; refusing`);
      }
      assertTestNetwork(reported, true, "RPC endpoint");
    })();
    return this.chainChecked;
  }

  // ---- escrow ----

  async createAndFund(p: CreateAndFundParams, idempotencyKey: string): Promise<TxRef> {
    const amount = BigInt(p.amount);
    const data = this.escrow.encodeFunctionData("createAndFund", [
      milestoneIdToBytes32(p.milestoneId), p.client, p.provider, p.arbiter, p.vault,
      amount, p.timeout, p.cardFunded, p.holdSeconds,
    ]);
    await this.ready();
    const done = await this.finished(this.config.escrow, data, idempotencyKey);
    if (done) return done;

    // The escrow pulls the amount from the funder. Approve once, without a limit: the escrow is our own
    // contract, and an exact approval would be overwritten by a second funding running in parallel.
    const funder = await this.address();
    const [allowance] = await this.read(this.config.usdt, this.erc20, "allowance", [funder, this.config.escrow]);
    if ((allowance as bigint) < amount) {
      const allow = await this.send(
        this.config.usdt,
        this.erc20.encodeFunctionData("approve", [this.config.escrow, MaxUint256]),
        `${idempotencyKey}:allowance`,
      );
      await this.waitConfirmed(allow.txHash);
    }

    return this.send(this.config.escrow, data, idempotencyKey);
  }

  approve(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("approve", milestoneId, idempotencyKey);
  }

  dispute(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("dispute", milestoneId, idempotencyKey);
  }

  decide(
    milestoneId: string,
    releaseToProvider: boolean,
    sigs: string[],
    signers: string[],
    idempotencyKey: string,
  ): Promise<TxRef> {
    return this.send(
      this.config.escrow,
      this.escrow.encodeFunctionData("decide", [milestoneIdToBytes32(milestoneId), releaseToProvider, sigs, signers]),
      idempotencyKey,
    );
  }

  /** EIP-712 payload a party signs to settle a dispute. kind: 0 = client, 1 = provider, 2 = arbiter. */
  attestationTypedData(milestoneId: string, kind: 0 | 1 | 2, releaseToProvider: boolean) {
    return {
      domain: { name: "TethranEscrow", version: "1", chainId: this.chainId, verifyingContract: this.config.escrow },
      types: {
        Attestation: [
          { name: "milestoneId", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "releaseToProvider", type: "bool" },
        ],
      },
      message: { milestoneId: milestoneIdToBytes32(milestoneId), kind, releaseToProvider },
    };
  }

  release(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("release", milestoneId, idempotencyKey);
  }

  refund(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("refund", milestoneId, idempotencyKey);
  }

  refundApproved(milestoneId: string, idempotencyKey: string): Promise<TxRef> {
    return this.escrowCall("refundApproved", milestoneId, idempotencyKey);
  }

  // ---- vault (the spending guard is part of it) ----
  // Every vault action is authorised by signatures made elsewhere; this client only submits them.

  vaultExecute(p: VaultExecuteParams, idempotencyKey: string): Promise<TxRef> {
    return this.send(
      p.vault,
      this.vaultAbi.encodeFunctionData("execute", [
        p.to, BigInt(p.amount), p.proposalHash, p.actionId, p.deadline, p.agentSig, p.policySig,
      ]),
      idempotencyKey,
    );
  }

  setPolicy(p: SetPolicyParams, idempotencyKey: string): Promise<TxRef> {
    return this.send(
      p.vault,
      this.vaultAbi.encodeFunctionData("setPolicy", [
        p.version, BigInt(p.perTxCap), BigInt(p.dailyCap), BigInt(p.minReserve), p.operatorSig,
      ]),
      idempotencyKey,
    );
  }

  setPayees(p: SetPayeesParams, idempotencyKey: string): Promise<TxRef> {
    return this.send(
      p.vault,
      this.vaultAbi.encodeFunctionData("setPayees", [p.version, p.payees, p.allowed, p.operatorSig]),
      idempotencyKey,
    );
  }

  rotateVaultSigners(p: RotateSignersParams, idempotencyKey: string): Promise<TxRef> {
    return this.send(
      p.vault,
      this.vaultAbi.encodeFunctionData("rotateSigners", [p.version, p.agentSigner, p.policySigner, p.operatorSig]),
      idempotencyKey,
    );
  }

  vaultWithdraw(p: VaultWithdrawParams, idempotencyKey: string): Promise<TxRef> {
    return this.send(
      p.vault,
      this.vaultAbi.encodeFunctionData("withdrawToProvider", [p.version, BigInt(p.amount), p.operatorSig]),
      idempotencyKey,
    );
  }

  /** EIP-712 domain of one vault. Sign VAULT_TYPES against it. */
  vaultDomain(vault: string) {
    return { name: "TethranVault", version: "1", chainId: this.chainId, verifyingContract: vault };
  }

  async vaultState(vault: string): Promise<VaultState> {
    await this.ready();
    const num = async (fn: string) => ((await this.read(vault, this.vaultAbi, fn, []))[0] as bigint).toString();
    const addr = async (fn: string) => (await this.read(vault, this.vaultAbi, fn, []))[0] as string;
    return {
      policyVersion: Number(await num("policyVersion")),
      perTxCap: await num("perTxCap"),
      dailyCap: await num("dailyCap"),
      minReserve: await num("minReserve"),
      spentToday: await num("spentToday"),
      balance: await this.balance(vault),
      agentSigner: await addr("agentSigner"),
      policySigner: await addr("policySigner"),
      operator: await addr("operator"),
      providerPayout: await addr("providerPayout"),
    };
  }

  /** Would the vault's limits let this transfer through right now? reason is "" when ok. */
  async vaultCheck(vault: string, to: string, amount: string): Promise<{ ok: boolean; reason: string }> {
    await this.ready();
    const [ok, reason] = await this.read(vault, this.vaultAbi, "check", [to, BigInt(amount)]);
    return { ok: ok as boolean, reason: ok ? "" : decodeBytes32String(reason as string) };
  }

  // ---- receipt: contract not built yet ----

  async mintReceipt(_p: MintReceiptParams, _idempotencyKey: string): Promise<TxRef> {
    throw new NotBuiltYetError("mintReceipt", "the ReceiptNFT contract");
  }

  // ---- reads ----

  async milestone(milestoneId: string): Promise<MilestoneView> {
    await this.ready();
    const [m] = await this.read(this.config.escrow, this.escrow, "milestone", [milestoneIdToBytes32(milestoneId)]);
    return {
      funder: m.funder,
      client: m.client,
      provider: m.provider,
      arbiter: m.arbiter,
      vault: m.vault,
      amount: (m.amount as bigint).toString(),
      timeout: Number(m.timeout),
      approvedAt: Number(m.approvedAt),
      holdSeconds: Number(m.holdSeconds),
      cardFunded: m.cardFunded,
      state: ESCROW_STATES[Number(m.state)],
    };
  }

  async txStatus(txHash: string): Promise<TxStatus> {
    await this.ready();
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (receipt) return receipt.status === 1 ? "confirmed" : "failed";
    return (await this.provider.getTransaction(txHash)) ? "pending" : "unknown";
  }

  async balance(address: string): Promise<string> {
    await this.ready();
    const [balance] = await this.read(this.config.usdt, this.erc20, "balanceOf", [address]);
    return (balance as bigint).toString();
  }

  // ---- extras outside the ChainClient interface ----

  /** TEST TOKEN FAUCET. Mints TestUSDT; it only exists on test networks. */
  mintTestUsdt(to: string, amount: string, idempotencyKey: string): Promise<TxRef> {
    return this.send(this.config.usdt, this.erc20.encodeFunctionData("mint", [to, BigInt(amount)]), idempotencyKey);
  }

  /**
   * Polls the same hash until it is mined and `config.confirmations` blocks deep. Never resubmits.
   * More than one confirmation matters on public RPC endpoints: they are load-balanced, and a node that
   * is one block behind would make the next call see the old state.
   */
  async waitConfirmed(txHash: string, timeoutMs = 180_000, pollMs = 1_500): Promise<void> {
    await this.ready();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (receipt && receipt.status !== 1) throw new Error(`transaction failed: ${txHash}`);
      if (receipt) {
        const depth = (await this.provider.getBlockNumber()) - receipt.blockNumber + 1;
        if (depth >= this.config.confirmations) return;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${txHash}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Operator tool for a key that is stuck. It frees the key ONLY after the chain shows that its
   * transaction failed or never landed; otherwise the key stays claimed.
   *
   *   "confirmed"  the transaction succeeded; the key stays bound to it
   *   "pending"    the transaction is still in the mempool; nothing changed
   *   "freed"      proven failed or never landed; the key can be used again
   *
   * A key with no recorded hash (the process died between sending and recording) is freed only if the
   * sender has mined nothing since the key was claimed and has nothing pending. If the sender has sent
   * anything since, pass the transaction hash from the logs or an explorer as `txHash`; it is accepted
   * only if that transaction is from this sender and is exactly the call the key stands for.
   */
  async resolve(idempotencyKey: string, opts: { txHash?: string } = {}): Promise<"confirmed" | "pending" | "freed"> {
    await this.ready();
    const sender = await this.address();
    const scoped = this.scopedKey(sender, idempotencyKey);
    const rec = this.store.get(scoped);
    if (!rec) throw new CannotResolveError(`no such idempotency key for this sender: "${idempotencyKey}"`);

    let txHash = rec.txHash;
    if (!txHash && opts.txHash) {
      const tx = await this.provider.getTransaction(opts.txHash);
      if (!tx) throw new CannotResolveError(`transaction ${opts.txHash} was not found`);
      const matches = tx.from.toLowerCase() === sender.toLowerCase() && tx.to !== null
        && this.callHash(tx.to, tx.data) === rec.callHash;
      if (!matches) throw new CannotResolveError(`transaction ${opts.txHash} is not the call behind this key`);
      this.store.complete(scoped, opts.txHash);
      txHash = opts.txHash;
    }

    const oldEnough = Date.now() - rec.reservedAt >= this.resolveMinAgeMs;
    const mined = await this.provider.getTransactionCount(sender, "latest");
    const nothingPending = (await this.provider.getTransactionCount(sender, "pending")) === mined;

    if (txHash) {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (receipt?.status === 1) return "confirmed";
      if (receipt) return this.free(scoped); // mined and reverted
      if (await this.provider.getTransaction(txHash)) return "pending";
      if (oldEnough && nothingPending) return this.free(scoped); // dropped: not mined, not in the mempool
      throw new CannotResolveError(`transaction ${txHash} is unknown to the node but may still land; try again later`);
    }

    if (oldEnough && nothingPending && mined === rec.nonceAtReserve) return this.free(scoped);
    throw new CannotResolveError(
      mined === rec.nonceAtReserve
        ? "the send may still be in flight; try again later"
        : "this sender has mined transactions since the key was claimed; pass the transaction hash to resolve",
    );
  }

  // ---- internals ----

  /** A read-only contract call. */
  private async read(to: string, iface: Interface, fn: string, args: unknown[]) {
    return iface.decodeFunctionResult(fn, await this.provider.call({ to, data: iface.encodeFunctionData(fn, args) }));
  }

  private free(scoped: string): "freed" {
    this.store.forget(scoped);
    return "freed";
  }

  private address(): Promise<string> {
    this.senderAddress ??= this.sender.getAddress();
    return this.senderAddress;
  }

  /** Keys are scoped to the sender, so two signers sharing one store cannot collide. */
  private scopedKey(sender: string, idempotencyKey: string): string {
    return `${sender.toLowerCase()}:${idempotencyKey}`;
  }

  private callHash(to: string, data: string): string {
    return keccak256(concat([to, data]));
  }

  private escrowCall(
    fn: "approve" | "dispute" | "release" | "refund" | "refundApproved",
    milestoneId: string,
    key: string,
  ) {
    return this.send(this.config.escrow, this.escrow.encodeFunctionData(fn, [milestoneIdToBytes32(milestoneId)]), key);
  }

  /** The stored TxRef when this key has already produced a transaction for this same call. */
  private async finished(to: string, data: string, idempotencyKey: string): Promise<TxRef | undefined> {
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const prev = this.store.get(this.scopedKey(await this.address(), idempotencyKey));
    if (!prev) return undefined;
    return this.refFor(prev, to, data, idempotencyKey);
  }

  private refFor(prev: IdempotencyRecord, to: string, data: string, idempotencyKey: string): TxRef {
    if (prev.chainId !== this.chainId) {
      throw new Error(`idempotency key "${idempotencyKey}" was used on chain ${prev.chainId}`);
    }
    if (prev.callHash !== this.callHash(to, data)) throw new IdempotencyKeyReuseError(idempotencyKey);
    if (!prev.txHash) throw new IdempotencyInFlightError(idempotencyKey);
    return { txHash: prev.txHash, chainId: prev.chainId, idempotencyKey };
  }

  /**
   * Sends at most one transaction per (sender, idempotency key).
   * - The same key with the same call returns the first TxRef.
   * - The same key with a different call throws.
   * - If the node rejects the send up front (see REJECTED_BEFORE_BROADCAST), nothing was broadcast and
   *   the key is released. After any other failure the key stays claimed: see resolve().
   * Sends from one client run one at a time, so two calls never race for the same account nonce.
   */
  private send(to: string, data: string, idempotencyKey: string): Promise<TxRef> {
    const run = this.queue.then(() => this.sendNow(to, data, idempotencyKey));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow(to: string, data: string, idempotencyKey: string): Promise<TxRef> {
    await this.ready();
    const done = await this.finished(to, data, idempotencyKey);
    if (done) return done;

    const sender = await this.address();
    const scoped = this.scopedKey(sender, idempotencyKey);
    const claimed = this.store.reserve({
      key: scoped,
      chainId: this.chainId,
      callHash: this.callHash(to, data),
      nonceAtReserve: await this.provider.getTransactionCount(sender, "latest"),
      reservedAt: Date.now(),
    });
    if (!claimed) return this.refFor(this.store.get(scoped)!, to, data, idempotencyKey); // lost a race

    let hash: string;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ hash } = await this.sender.sendTransaction({ to, data }));
        break;
      } catch (e) {
        // A revert at gas estimation means nothing was broadcast, so asking again is safe. On a public,
        // load-balanced RPC it is often a node that has not yet seen the previous block.
        if (isError(e, "CALL_EXCEPTION") && attempt < this.estimateRetries) {
          await new Promise((r) => setTimeout(r, this.estimateRetryMs));
          continue;
        }
        if (REJECTED_BEFORE_BROADCAST.some((code) => isError(e, code))) this.store.release(scoped);
        throw e;
      }
    }
    try {
      this.store.complete(scoped, hash);
    } catch (e) {
      // The transaction is out but could not be recorded. A hash is not a secret: print it so an
      // operator can pass it to resolve().
      console.error(`idempotency key "${idempotencyKey}": sent ${hash} but could not record it`);
      throw e;
    }
    return { txHash: hash, chainId: this.chainId, idempotencyKey };
  }
}
