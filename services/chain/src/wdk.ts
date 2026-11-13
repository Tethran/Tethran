// User wallets on Tether's Wallet Development Kit (WDK): client, provider-side payees and subcontractors.
//
// WDK modules used:
//   @tetherto/wdk             the WDK core: seed-based wallet registry and its transaction-policy engine
//   @tetherto/wdk-wallet-evm  the EVM wallet: BIP-44 account derivation, native and token balances, fee quotes,
//                             token transfers, transaction sending, typed-data signing, receipts
//   @tetherto/wdk-failover-provider  the wallets' RPC: the API-key RPC (RPC_URL_<chainId>, e.g. Alchemy) first and the
//                             chain file's public RPC second; a timeout or network error moves the call to the next one
//
// Every account comes from one BIP-39 test seed (DEMO_WALLET_SEED) through `wdk.getAccount(WALLET_ID, index)`.
// The WDK policy engine guards every account before WDK signs anything:
//   transfer         only the configured test USDT, only up to a per-transfer cap
//   sendTransaction  only to the escrow contract (the client's on-chain approve and dispute calls)
// Anything else (other tokens, raw sends to other addresses, unknown write methods) is denied by WDK itself with
// a PolicyViolationError. These are wallet-side guards for the user's own wallet; the platform's limits stay in
// the Policy Service and the vault.
//
// Treasury, Policy Service, agent signer and operator keys do NOT use this module; they are unchanged.
// TEST NETWORKS ONLY: the chain config must be a test network (checked by loadChain and here).
import WDK, { PolicyViolationError } from "@tetherto/wdk";
import FailoverProvider from "@tetherto/wdk-failover-provider";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { FetchRequest, isError, JsonRpcProvider, Network, type AbstractProvider } from "ethers";
import { assertTestNetwork } from "./config";
import type { TxSender } from "./evmChainClient";
import type { ChainConfig } from "./types";

export const WALLET_ID = "tethran-evm";

/** Per-request RPC timeout for the WDK wallets. A request that takes longer fails over to the next RPC. */
export const WDK_RPC_TIMEOUT_MS = 20_000;

/** Only connection trouble moves a call to the next RPC; a revert, a nonce or a funds error is the same everywhere. */
export function isFailoverError(e: unknown): boolean {
  return isError(e, "TIMEOUT") || isError(e, "NETWORK_ERROR") || isError(e, "SERVER_ERROR");
}

/**
 * The WDK wallets' provider: @tetherto/wdk-failover-provider over the API-key RPC (primary) and the public RPC
 * (fallback), each pinned to the chain id (never asked for it) with a per-request timeout. Calls go to the active
 * RPC; on a timeout, network or server error they move to the next one, round robin, up to `retries` more times.
 * A transaction send is the same signed bytes on either RPC (same nonce), so a resend cannot pay twice.
 */
export function createWdkProvider(chain: Pick<ChainConfig, "chainId" | "rpcUrl" | "fallbackRpcUrl">, opts: { timeoutMs?: number; retries?: number } = {}): AbstractProvider {
  const network = Network.from(chain.chainId);
  const urls = [chain.rpcUrl, ...(chain.fallbackRpcUrl && chain.fallbackRpcUrl !== chain.rpcUrl ? [chain.fallbackRpcUrl] : [])];
  const failover = new FailoverProvider<AbstractProvider>({ retries: opts.retries ?? 3, shouldRetryOn: isFailoverError });
  for (const url of urls) {
    const req = new FetchRequest(url);
    req.timeout = opts.timeoutMs ?? WDK_RPC_TIMEOUT_MS;
    // cacheTimeout -1: no short response cache, so two quick sends never reuse one nonce read.
    failover.addProvider(new JsonRpcProvider(req, network, { staticNetwork: network, cacheTimeout: -1 }));
  }
  return failover.initialize();
}

/** Which seed account each demo role uses. */
/** earnings: the Tethran earnings account (demo), where the 5% platform fee is paid; a company treasury in production. */
export const WALLET_ROLES = { client: 0, payee_amara: 1, subcontractor: 2, client_b: 3, agent_budget: 4, earnings: 5 } as const;
export type WalletRole = keyof typeof WALLET_ROLES;

export interface WdkAccountLike {
  path?: string;
  getAddress(): Promise<string>;
  getBalance(): Promise<bigint>;
  getTokenBalance(token: string): Promise<bigint>;
  quoteTransfer(o: { token: string; recipient: string; amount: bigint }): Promise<{ fee: bigint }>;
  transfer(o: { token: string; recipient: string; amount: bigint }): Promise<{ hash: string; fee: bigint }>;
  sendTransaction(tx: { to: string; value: bigint; data?: string }): Promise<{ hash: string; fee: bigint }>;
  quoteSendTransaction(tx: { to: string; value: bigint; data?: string }): Promise<{ fee: bigint }>;
  signTypedData(t: { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown> }): Promise<string>;
}

export { PolicyViolationError };

export interface WdkWallets {
  readonly chainId: number;
  account(role: WalletRole): Promise<WdkAccountLike>;
  address(role: WalletRole): Promise<string>;
  /** The account as a ChainClient sender, so the client's escrow calls are signed by WDK. */
  sender(role: WalletRole): TxSender;
  dispose(): void;
}

export function createWdkWallets(opts: {
  chain: ChainConfig;
  seed: string;
  /** Largest single USDT transfer the wallet policy allows, base units. */
  maxTransfer: bigint;
  /** Largest single EIP-3009 authorization (x402 data payment) the wallet policy allows to sign, base units. */
  maxAuthorization?: bigint;
  /** Test only: the provider to use instead of the failover provider over the chain's RPCs. */
  provider?: AbstractProvider;
}): WdkWallets {
  const maxAuthorization = opts.maxAuthorization ?? 1_000_000n; // 1 test USDT
  const { chain } = opts;
  assertTestNetwork(chain.chainId, chain.testnet, `WDK wallets on "${chain.key}"`);
  if (!chain.usdt || !chain.escrow) throw new Error(`chain "${chain.key}" has no usdt or escrow address yet`);
  if (opts.seed.trim().split(/\s+/).length < 12) throw new Error("DEMO_WALLET_SEED must be a BIP-39 phrase of 12 or more words");
  const usdt = chain.usdt.toLowerCase();
  const escrow = chain.escrow.toLowerCase();

  const wdk = new WDK(opts.seed)
    // (cast: WDK core and the EVM wallet each bundle their own copy of the base wallet types)
    .registerWallet(WALLET_ID, WalletManagerEvm as never, { provider: opts.provider ?? createWdkProvider(chain), chainId: chain.chainId } as never)
    .registerPolicy({
      id: "tethran-user-wallet",
      name: "Tethran user wallet guard (test network)",
      scope: "project",
      wallet: WALLET_ID,
      rules: [
        {
          name: "test-usdt-only-under-cap",
          reason: "user wallets may only send the configured test USDT, up to the per-transfer cap",
          operation: "transfer",
          action: "ALLOW",
          conditions: [({ args }: { args: readonly any[] }) =>
            String(args[0]?.token ?? "").toLowerCase() === usdt && BigInt(args[0]?.amount ?? 0) > 0n && BigInt(args[0].amount) <= opts.maxTransfer],
        },
        {
          name: "escrow-calls-only",
          reason: "raw transactions may only go to the escrow contract, with no ETH attached",
          operation: "sendTransaction",
          action: "ALLOW",
          conditions: [({ args }: { args: readonly any[] }) =>
            String(args[0]?.to ?? "").toLowerCase() === escrow && BigInt(args[0]?.value ?? 0) === 0n],
        },
        {
          name: "typed-data-signing",
          reason: "only escrow attestations, contract signatures, and small test-USDT x402 authorizations may be signed",
          operation: "signTypedData",
          action: "ALLOW",
          conditions: [({ args }: { args: readonly any[] }) => {
            const t = args[0] ?? {};
            const types = Object.keys(t.types ?? {}).filter((k) => k !== "EIP712Domain");
            const contract = String(t.domain?.verifyingContract ?? "").toLowerCase();
            if (types.length !== 1) return false;
            if (types[0] === "Attestation") return contract === escrow;
            if (types[0] === "ContractSignature") return t.domain?.name === "TethranContract";
            if (types[0] === "TransferWithAuthorization") {
              return contract === usdt && BigInt(t.message?.value ?? 0) > 0n && BigInt(t.message.value) <= maxAuthorization;
            }
            return false;
          }],
        },
      ],
    } as never);

  const cache = new Map<WalletRole, Promise<WdkAccountLike>>();
  const account = (role: WalletRole) => {
    if (!(role in WALLET_ROLES)) throw new Error(`unknown wallet role "${role}"`);
    if (!cache.has(role)) cache.set(role, wdk.getAccount(WALLET_ID, WALLET_ROLES[role]) as unknown as Promise<WdkAccountLike>);
    return cache.get(role)!;
  };

  return {
    chainId: chain.chainId,
    account,
    address: async (role) => (await account(role)).getAddress(),
    sender: (role) => ({
      getAddress: async () => (await account(role)).getAddress(),
      sendTransaction: async (tx) => {
        const r = await (await account(role)).sendTransaction({ to: tx.to, value: 0n, data: tx.data });
        return { hash: r.hash };
      },
    }),
    dispose: () => wdk.dispose(),
  };
}
