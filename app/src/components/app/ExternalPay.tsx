import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import { usd } from "@/components/tethran/ui";
import { externalWallet, shortAddress } from "@/wallet/external";
import { reviewDeposit, sendDeposit, type DepositCall, type DepositReview } from "@/wallet/pay";
import { useExternalWallet } from "@/components/app/ConnectWallet";

const eth = (wei: string | null) => (wei === null ? "unavailable" : `${(Number(BigInt(wei)) / 1e18).toFixed(6)} Sepolia ETH (estimated)`);

/**
 * Pay a milestone from a connected wallet: review (recipient by name, network, amount, fee separate, duplicate-send
 * block, wrong-network warning; the same tx hash is rechecked on reconnect), then send test USDT from the wallet and
 * the backend confirms the deposit on-chain. Only the milestone's client address can fund it.
 */
export function ExternalPay({ milestoneId, onPaid }: { milestoneId: string; onPaid: () => void }) {
  const w = useExternalWallet();
  const [call, setCall] = useState<DepositCall | null>(null);
  const [review, setReview] = useState<DepositReview | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (!w.connected) { setReview(null); return; }
    try {
      const c = call ?? (await api.depositCall(milestoneId));
      setCall(c);
      setReview(await reviewDeposit(externalWallet.provider(), milestoneId, c, w.address, w.chainId));
    } catch (e) { toast.error((e as Error).message); }
  };
  useEffect(() => { void refresh(); }, [w.connected, w.address, w.chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!w.connected) {
    return (
      <div className="mt-4 rounded-[var(--radius-input)] border p-3 text-sm" data-testid="external-pay">
        <p>Connect the wallet that is this contract's client to pay from it.</p>
        <button onClick={() => externalWallet.connect()} className="mt-2 inline-flex min-h-11 items-center rounded-full border px-4 text-sm hover:border-ink">Connect wallet</button>
      </div>
    );
  }
  return (
    <div className="mt-4 grid gap-2 rounded-[var(--radius-input)] border p-3 text-sm" data-testid="external-pay">
      {!review ? <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" aria-hidden />Preparing the review…</p> : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">From</dt><dd className="font-mono">{shortAddress(review.from)}</dd>
            <dt className="text-muted-foreground">To</dt><dd>{review.recipientName} <span className="font-mono text-xs text-muted-foreground">{shortAddress(review.recipientAddress)}</span></dd>
            <dt className="text-muted-foreground">Network</dt><dd>{review.network}</dd>
            <dt className="text-muted-foreground">Amount</dt><dd>{usd(Number(BigInt(review.amount)) / 1e6)} test USDT</dd>
            <dt className="text-muted-foreground">Network fee</dt><dd>{eth(review.feeWei)} <span className="text-muted-foreground">(paid in ETH, not from the amount)</span></dd>
          </dl>
          {review.blocked.map((b) => <p key={b.code} className="flex items-start gap-2 text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{b.detail}</p>)}
          {review.blocked.some((b) => b.code === "WRONG_NETWORK") && <button onClick={() => externalWallet.switchToSepolia().then(refresh)} className="min-h-11 rounded-full border px-4 hover:border-ink">Switch to Sepolia</button>}
          <button data-testid="external-send" disabled={!review.canSend || busy} onClick={async () => {
            setBusy(true);
            try {
              const hash = await sendDeposit(externalWallet.provider(), milestoneId, call!, w.address!);
              await api.confirmDeposit(milestoneId, hash);
              toast.success("Paid from your wallet. The escrow is funded on Sepolia.");
              onPaid();
            } catch (e) { toast.error((e as Error).message); await refresh(); } finally { setBusy(false); }
          }} className="min-h-11 rounded-full bg-ink px-5 text-on-dark disabled:opacity-40">{busy ? "Sending and confirming…" : "Confirm and send from my wallet"}</button>
        </>
      )}
    </div>
  );
}
