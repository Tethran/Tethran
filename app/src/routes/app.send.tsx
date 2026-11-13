import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Loader2, Network, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, reasonInfo } from "@/api";
import type { WalletReview } from "@/api/types";
import { PageHead } from "@/components/app/AppShell";
import { useApi } from "@/components/app/demo-state";
import { Object3D } from "@/components/tethran/Object3D";
import { Details, PillButton, SimTag, usd } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/send")({
  head: () => ({ meta: [{ title: "Review and send — Tethran" }, { name: "description", content: "Review a payment before it moves." }] }),
  component: SendReview,
});

const AMOUNT_BASE_UNITS = "5000000"; // 5 test USDT
const OTHER_TEST_CHAIN: Record<number, { id: number; name: string }> = {
  11155111: { id: 84532, name: "Base Sepolia (test)" },
  84532: { id: 11155111, name: "Sepolia (test)" },
  31337: { id: 11155111, name: "Sepolia (test)" },
};
type Phase = "review" | "sending" | "pending" | "sent" | "failed";

function SendReview() {
  const w = useApi(["wallets"], api.wallets);
  const client = w.data?.wallets?.find((x: any) => x.role === "client");
  const payee = w.data?.wallets?.find((x: any) => x.role === "payee_amara");
  const walletChain: number | undefined = client?.chain_id;
  const [chainId, setChainId] = useState<number | null>(null);
  const [ref] = useState(() => `send:${Date.now()}`);
  const [review, setReview] = useState<WalletReview | null>(null);
  const [phase, setPhase] = useState<Phase>("review");
  const [tx, setTx] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const other = walletChain ? OTHER_TEST_CHAIN[walletChain] : undefined;
  // Start on the other test network so the wrong-network check is visible, as a real wallet can be.
  useEffect(() => { if (chainId === null && other) setChainId(other.id); }, [other, chainId]);
  const transfer = useMemo(() => payee && chainId ? { to: payee.address, amount: AMOUNT_BASE_UNITS, chainId, reference: ref } : null, [payee, chainId, ref]);

  useEffect(() => {
    if (!transfer || phase !== "review") return;
    api.reviewTransfer(transfer).then((r) => { setReview(r); setError(null); }).catch((e) => setError((e as ApiError).message));
  }, [transfer, phase]);

  const send = async () => {
    if (!transfer) return;
    if (phase === "pending" || phase === "sending") {
      // The same payment reference again: the wallet layer refuses before anything is signed.
      try { await api.sendTransfer(transfer); } catch (e) { setNotice(reasonInfo((e as ApiError).code).plain); }
      return;
    }
    setPhase("sending");
    try { const r = await api.sendTransfer(transfer); setTx(r.tx_hash); setPhase("pending"); }
    catch (e) { setError((e as ApiError).message); setPhase("review"); }
  };
  const recheck = async () => {
    try {
      const s = await api.transferStatus(ref);
      if (s.status === "confirmed") setPhase("sent");
      else if (s.status === "failed") setPhase("failed");
      else setNotice("Still on its way. Checked the same payment again; it was not resent.");
    } catch (e) { setError((e as ApiError).message); }
  };

  const wrong = review ? review.blocked.includes("WRONG_NETWORK") : false;
  return (
    <div className="mx-auto max-w-lg">
      <PageHead eyebrow="Send" light="Review" title="and send." />
      <div className="rounded-[var(--radius-sheet)] border bg-surface p-6 shadow-soft">
        <div className="flex items-center gap-4">
          <Object3D name="phone" className="size-16" decorative />
          <div><p className="text-sm text-muted-foreground">To</p><p className="text-xl font-medium">{review?.recipient.savedName ?? "Amara Studio"}</p><p className="font-mono text-xs text-muted-foreground">{payee?.address ?? "…"}</p></div>
        </div>
        <dl className="mt-6 grid gap-3 border-t pt-5">
          <div className="flex justify-between"><dt className="text-muted-foreground">Amount</dt><dd className="font-mono">{usd(5)} test USDT</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Network fee (separate)</dt><dd className="font-mono text-sm">{review?.feeDisplay ?? "not available yet"}</dd></div>
          <div className="flex items-center justify-between"><dt className="text-muted-foreground">Network</dt>
            <dd><select value={chainId ?? ""} onChange={(e) => { setChainId(Number(e.target.value)); setPhase("review"); }} className="h-11 rounded-full border bg-background px-3 text-sm" aria-label="Network">
              {walletChain && <option value={walletChain}>{review?.network.chainId === walletChain ? review.network.name : "Wallet's network"} (test)</option>}
              {other && <option value={other.id}>{other.name}</option>}
            </select></dd></div>
        </dl>
        {wrong && phase === "review" && (
          <div role="alert" className="mt-5 rounded-[var(--radius-input)] border border-progress/50 bg-progress/10 p-4 text-sm">
            <p className="flex items-center gap-2 font-medium"><Network className="size-4" aria-hidden />{reasonInfo("WRONG_NETWORK").title}.</p>
            <p className="mt-1 text-muted-foreground">{reasonInfo("WRONG_NETWORK").plain}</p>
            {walletChain && <button onClick={() => setChainId(walletChain)} className="mt-3 min-h-11 rounded-full bg-ink px-4 text-on-dark">Switch to the wallet's network</button>}
          </div>
        )}
        {review && review.blocked.filter((b) => b !== "WRONG_NETWORK").map((b) => <p key={b} className="mt-3 text-sm text-muted-foreground">{reasonInfo(b).title}. {reasonInfo(b).plain}</p>)}
        <div className="mt-5"><Details rows={[["From (your WDK wallet)", review?.from ?? "…"], ["Token", "Test USDT"], ["Payment reference", ref], ["Custody", review?.custody ?? "…"]]} /></div>
        <div aria-live="polite" className="mt-5 grid gap-3">
          {error && <p className="rounded-[var(--radius-input)] border border-danger/40 p-4 text-sm">{error}</p>}
          {(phase === "sending" || phase === "pending") && <p className="flex items-center gap-2 rounded-[var(--radius-input)] bg-progress/10 p-4 text-sm"><Loader2 className="size-4 animate-spin" aria-hidden />Sent to the network, waiting for confirmation{tx ? ` (${tx.slice(0, 12)}…)` : ""}.</p>}
          {notice && <p className="flex items-center gap-2 rounded-[var(--radius-input)] border border-progress/50 p-4 text-sm"><AlertTriangle className="size-4 text-progress" aria-hidden />{notice}</p>}
          {phase === "pending" && <button onClick={recheck} className="inline-flex min-h-11 w-fit items-center gap-2 rounded-full border px-4 text-sm hover:border-ink"><RefreshCw className="size-4" aria-hidden />Check again</button>}
          {phase === "sent" && <p className="flex items-center gap-2 rounded-[var(--radius-input)] bg-lime p-4 text-lime-ink animate-lime-pulse"><CheckCircle2 className="size-5" aria-hidden />Confirmed on the test network.</p>}
          {phase === "failed" && <p className="rounded-[var(--radius-input)] border border-danger/40 p-4 text-sm">The transfer failed on the network. Nothing was sent twice.</p>}
        </div>
        {phase !== "sent" && (
          <PillButton variant="ink" size="lg" className="mt-6 w-full justify-between" disabled={!review || (!review.canSign && phase === "review")} onClick={send}>
            {phase === "pending" || phase === "sending" ? "Send again (it won't be sent twice)" : "Confirm and send"}
          </PillButton>
        )}
      </div>
      <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">Test network only.</p>
    </div>
  );
}
