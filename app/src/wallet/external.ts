// External wallets (MetaMask, Rabby, Coinbase Wallet, mobile wallets via WalletConnect) through Reown AppKit with the
// ethers adapter. Connecting is not a login: it only gives the app an EIP-1193 provider to ask for signatures and
// transactions. Sepolia only. The library is loaded on first use (dynamic import), so the landing page does not grow.
//
// The core (createExternalWallet) takes the AppKit-like client as a dependency so it can be tested with a mock.
import { ApiError } from "@/api/http";

export const SEPOLIA_ID = 11155111;
export interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

export type WalletStatus = "idle" | "loading" | "ready" | "missing-project-id" | "error";
export interface WalletState { status: WalletStatus; connected: boolean; address: string | null; chainId: number | null; error: string | null }

/** The part of the AppKit client this app uses (so tests can pass a fake). */
export interface KitLike {
  open(): Promise<unknown>;
  disconnect(): Promise<void>;
  switchNetwork(network: unknown): Promise<void>;
  getWalletProvider(): unknown;
  subscribeAccount(cb: (s: { address?: string; isConnected?: boolean }) => void): () => void;
  subscribeNetwork(cb: (s: { chainId?: string | number }) => void): () => void;
}

export const shortAddress = (a: string | null | undefined) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? "");

/** Maps a wallet error to what the app says: the person declined, the wrong network, or anything else. */
export function classifyWalletError(e: unknown): { code: "REJECTED" | "WRONG_NETWORK" | "WALLET_ERROR"; message: string } {
  const err = e as { code?: number | string; message?: string; cause?: { code?: number } } | undefined;
  const code = err?.code ?? err?.cause?.code;
  const msg = String(err?.message ?? e ?? "");
  if (code === 4001 || code === "ACTION_REJECTED" || /user (rejected|denied)|rejected the request/i.test(msg)) return { code: "REJECTED", message: "You declined the request in your wallet. Nothing was signed or sent." };
  if (code === 4902 || /chain|network/i.test(msg) && /mismatch|wrong|unrecognized|not supported/i.test(msg)) return { code: "WRONG_NETWORK", message: "Your wallet is on another network. Switch to Sepolia and try again." };
  return { code: "WALLET_ERROR", message: msg.slice(0, 200) || "The wallet returned an error." };
}

const parseChain = (c: unknown): number | null => {
  if (typeof c === "number") return c;
  if (typeof c === "string") { const n = c.startsWith("0x") ? parseInt(c, 16) : Number(c.split(":").pop()); return Number.isFinite(n) ? n : null; }
  return null;
};

export function createExternalWallet(load: () => Promise<{ kit: KitLike; sepolia: unknown } | null>) {
  let state: WalletState = { status: "idle", connected: false, address: null, chainId: null, error: null };
  const listeners = new Set<(s: WalletState) => void>();
  const set = (p: Partial<WalletState>) => { state = { ...state, ...p }; listeners.forEach((l) => l(state)); };
  let loaded: { kit: KitLike; sepolia: unknown } | null = null;

  async function ensure() {
    if (loaded) return loaded;
    set({ status: "loading", error: null });
    try {
      const k = await load();
      if (!k) { set({ status: "missing-project-id" }); return null; }
      loaded = k;
      // Account changes (switching accounts in the wallet, disconnecting from it) update the app at once.
      k.kit.subscribeAccount((s) => set({ connected: !!s.isConnected && !!s.address, address: s.isConnected ? s.address ?? null : null }));
      k.kit.subscribeNetwork((s) => set({ chainId: parseChain(s.chainId) }));
      set({ status: "ready" });
      return k;
    } catch (e) {
      set({ status: "error", error: String((e as Error)?.message ?? e).slice(0, 160) });
      return null;
    }
  }

  function provider(): Eip1193 {
    const p = loaded?.kit.getWalletProvider() as Eip1193 | undefined;
    if (!state.connected || !p) throw new ApiError("WALLET_NOT_CONNECTED", "Connect a wallet first.");
    return p;
  }

  return {
    get state() { return state; },
    subscribe(l: (s: WalletState) => void) { listeners.add(l); l(state); return () => { listeners.delete(l); }; },
    async connect() { const k = await ensure(); if (k) await k.kit.open(); },
    async disconnect() { if (loaded) await loaded.kit.disconnect(); set({ connected: false, address: null }); },
    async switchToSepolia() { const k = await ensure(); if (k) await k.kit.switchNetwork(k.sepolia); },
    wrongNetwork: () => state.connected && state.chainId !== null && state.chainId !== SEPOLIA_ID,
    /** The connected wallet's provider; throws WALLET_NOT_CONNECTED when none. */
    provider,
    /** A request through the connected wallet, refusing on the wrong network and naming a declined request plainly. */
    async request(method: string, params?: unknown[], opts: { needsSepolia?: boolean } = {}) {
      if (opts.needsSepolia !== false && state.chainId !== null && state.chainId !== SEPOLIA_ID) {
        throw new ApiError("WRONG_NETWORK", "Your wallet is on another network. Switch to Sepolia first.");
      }
      try {
        return await provider().request(params === undefined ? { method } : { method, params });
      } catch (e) {
        if (e instanceof ApiError) throw e;
        const c = classifyWalletError(e);
        throw new ApiError(c.code, c.message);
      }
    },
  };
}

/** Loads Reown AppKit on first use. Returns null when VITE_REOWN_PROJECT_ID is missing (the app then says so). */
export async function loadReown(): Promise<{ kit: KitLike; sepolia: unknown } | null> {
  const projectId = (import.meta.env?.["VITE_REOWN_PROJECT_ID"] as string | undefined)?.trim();
  if (!projectId) return null;
  const [{ createAppKit }, { EthersAdapter }, { sepolia }] = await Promise.all([
    import("@reown/appkit"), import("@reown/appkit-adapter-ethers"), import("@reown/appkit/networks"),
  ]);
  const kit = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [sepolia],
    defaultNetwork: sepolia,
    projectId,
    metadata: { name: "Tethran", description: "Milestone escrow on a test network (test tokens only)", url: location.origin, icons: [] },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false, send: false },
    themeMode: "light",
    // The app's design tokens (ink and lime) for the modal.
    themeVariables: { "--w3m-accent": "#0A1F1B", "--w3m-color-mix": "#0A1F1B", "--w3m-color-mix-strength": 8, "--w3m-border-radius-master": "4px", "--w3m-font-family": "inherit" },
  } as never);
  return { kit: kit as unknown as KitLike, sepolia };
}

/** The app's single external wallet (lazy). */
export const externalWallet = createExternalWallet(loadReown);
