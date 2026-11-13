import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Coins, LogOut, Wallet } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import { externalWallet, shortAddress, type WalletState } from "@/wallet/external";
import { cn } from "@/lib/utils";

/** The connected wallet's state, following connect, account and network changes. */
export function useExternalWallet(): WalletState {
  const [s, set] = useState<WalletState>(externalWallet.state);
  useEffect(() => externalWallet.subscribe(set), []);
  return s;
}

/**
 * Connect wallet (MetaMask, Rabby, Coinbase Wallet, or a mobile wallet via WalletConnect), Sepolia only. Not a login:
 * it only lets this browser ask the wallet for signatures and transactions. The library loads on the first click.
 */
export function ConnectWallet() {
  const s = useExternalWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const wrong = s.connected && s.chainId !== null && s.chainId !== 11155111;

  if (!s.connected) {
    return (
      <button data-testid="connect-wallet" disabled={s.status === "loading"} title={s.status === "missing-project-id" ? "Wallet connection is not configured (VITE_REOWN_PROJECT_ID is missing)" : "Connect a wallet (test networks only)"}
        onClick={async () => {
          await externalWallet.connect().catch((e) => toast.error((e as Error).message));
          if (externalWallet.state.status === "missing-project-id") toast.error("Wallet connection is not configured: VITE_REOWN_PROJECT_ID is missing.");
          if (externalWallet.state.status === "error") toast.error(`The wallet could not load: ${externalWallet.state.error}`);
        }}
        className="inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm hover:border-ink disabled:opacity-50">
        <Wallet className="size-4" aria-hidden /><span className="hidden md:inline">{s.status === "loading" ? "Loading…" : "Connect wallet"}</span>
      </button>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button data-testid="wallet-connected" onClick={() => setOpen(!open)} aria-expanded={open}
        className={cn("inline-flex min-h-11 items-center gap-2 rounded-full border px-4 font-mono text-sm hover:border-ink", wrong && "border-danger text-danger")}>
        {wrong ? <AlertTriangle className="size-4" aria-hidden /> : <Wallet className="size-4" aria-hidden />}{shortAddress(s.address)}<ChevronDown className="size-3" aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-[var(--radius-card)] border bg-surface p-2 text-sm shadow-float">
          <p className="px-2 py-1 text-xs text-muted-foreground">{wrong ? "Wrong network: Tethran runs on Sepolia (test network)." : "Sepolia (test network). Not a login."}</p>
          {wrong && <button onClick={() => externalWallet.switchToSepolia().catch((e) => toast.error((e as Error).message))} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-line/60"><AlertTriangle className="size-4" aria-hidden />Switch to Sepolia</button>}
          <button data-testid="get-test-usdt" onClick={async () => {
            try { const r = await api.getTestUsdt(s.address!); toast.success(`100 test USDT sent to ${shortAddress(s.address)}`, { description: `${r.note} Tx ${String(r.tx_hash).slice(0, 12)}…` }); }
            catch (e) { toast.error((e as Error).message); }
          }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-line/60"><Coins className="size-4" aria-hidden />Get test USDT</button>
          <p className="px-2 pb-1 text-xs text-muted-foreground">You need Sepolia ETH for gas to send it.</p>
          <button onClick={() => { void externalWallet.disconnect(); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-line/60"><LogOut className="size-4" aria-hidden />Disconnect</button>
        </div>
      )}
    </div>
  );
}
