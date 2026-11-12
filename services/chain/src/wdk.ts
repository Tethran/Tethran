// User wallets on Tether's Wallet Development Kit (WDK): client, provider-side payees and subcontractors.
//
// WDK modules used:
//   @tetherto/wdk             the WDK core: seed-based wallet registry and its transaction-policy engine
//   @tetherto/wdk-wallet-evm  the EVM wallet: BIP-44 account derivation, native and token balances, fee quotes,
//                             token transfers, transaction sending, typed-data signing, receipts
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
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { assertTestNetwork } from "./config";
import type { TxSender } from "./evmChainClient";
import type { ChainConfig } from "./types";

export const WALLET_ID = "tethran-evm";

/** Which seed account each demo role uses. */
export const WALLET_ROLES = { client: 0, payee_amara: 1, subcontractor: 2, client_b: 3 } as const;
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
}): WdkWallets {
  const { chain } = opts;
  assertTestNetwork(chain.chainId, chain.testnet, `WDK wallets on "${chain.key}"`);
  if (!chain.usdt || !chain.escrow) throw new Error(`chain "${chain.key}" has no usdt or escrow address yet`);
  if (opts.seed.trim().split(/\s+/).length < 12) throw new Error("DEMO_WALLET_SEED must be a BIP-39 phrase of 12 or more words");
  const usdt = chain.usdt.toLowerCase();
  const escrow = chain.escrow.toLowerCase();

  const wdk = new WDK(opts.seed)
    // (cast: WDK core and the EVM wallet each bundle their own copy of the base wallet types)
    .registerWallet(WALLET_ID, WalletManagerEvm as never, { provider: chain.rpcUrl, chainId: chain.chainId, retries: 3 } as never)
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
          reason: "dispute attestations are EIP-712 signatures",
          operation: "signTypedData",
          action: "ALLOW",
          conditions: [() => true],
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
