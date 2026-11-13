import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Coins, CreditCard, Lock, Smartphone, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api";
import { Object3D } from "@/components/tethran/Object3D";
import { Logo, PillButton, SimTag, usd } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";
import type { Invoice } from "@/api/types";

export const Route = createFileRoute("/pay/$id")({
  head: () => ({ meta: [{ title: "Pay invoice — Tethran" }, { name: "description", content: "Fund a milestone. Money waits in escrow until you approve." }] }),
  component: PayPage,
});

const METHODS = [
  { id: "card", label: "Card", icon: CreditCard }, { id: "apple", label: "Apple Pay", icon: Smartphone }, { id: "google", label: "Google Pay", icon: Smartphone },
  { id: "paypal", label: "PayPal", icon: Wallet }, { id: "cashapp", label: "Cash App Pay", icon: Wallet }, { id: "coin", label: "Tethran wallet", icon: Coins },
];

function PayPage() {
  const { id } = Route.useParams();
  const [inv, setInv] = useState<Invoice | null | undefined>(undefined);
  const [method, setMethod] = useState("card");
  const [phase, setPhase] = useState<"idle" | "paying" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [simulated, setSimulated] = useState(true);
  useEffect(() => { api.getInvoice(id).then(setInv).catch((e) => { setInv(null); setError((e as Error).message); }); }, [id]);
  // The payer's demo wallet balance, for the "Tethran wallet" choice (null when it cannot be read).
  const [wallet, setWallet] = useState<{ name: string; balance: number | null } | null>(null);
  useEffect(() => { api.payerWallet(id).then(setWallet).catch(() => setWallet(null)); }, [id, phase]);
  return (
    <main className="min-h-screen bg-background px-4 py-6">
      <div className="mx-auto max-w-md">
        <div className="flex items-center justify-between"><Link to="/"><Logo /></Link><SimTag label={method === "coin" ? "Test network" : "Simulated checkout"} className="text-muted-foreground" /></div>
        {inv === undefined ? <div className="mt-10 h-96 animate-pulse rounded-[var(--radius-sheet)] bg-line" aria-busy="true" />
        : inv === null ? <p className="mt-16 text-center text-lg">{error ?? "This pay link isn't valid. Ask the sender for a new one."}</p>
        : phase === "done" ? (
          <div className="mt-10 rounded-[var(--radius-sheet)] bg-surface p-8 text-center shadow-soft">
            <div className="mx-auto size-40 animate-seal"><Object3D name="vault" className="size-40" decorative /></div>
            <h1 className="mt-4 text-4xl">Funds locked.</h1>
            <p className="mt-2 text-muted-foreground">{usd(inv.amount)} waits in escrow until you approve the work.</p>
            <p className="mt-6 flex items-center justify-center gap-2 text-sm"><CheckCircle2 className="size-4 text-success" aria-hidden />The escrow is funded on the test network.{simulated && <SimTag label="Simulated checkout" />}</p>
          </div>
        ) : (
          <>
            <div className="dark mt-8 rounded-[var(--radius-sheet)] bg-ink p-6 text-on-dark">
              <p className="text-sm text-muted-dark">{inv.provider} is asking for</p>
              <p className="mt-2 font-display text-6xl font-semibold tracking-[-0.05em]">{usd(inv.amount)}</p>
              <p className="mt-1 text-sm text-muted-dark">Fee: {usd(inv.fee)} · Total {usd(inv.amount + inv.fee)}</p>
              <p className="mt-4 text-sm">{inv.title} · {inv.number}</p>
            </div>
            <fieldset className="mt-6">
              <legend className="mb-3 font-medium">Pay with</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {METHODS.map((m) => (
                  <label key={m.id} className={cn("flex min-h-14 cursor-pointer items-center gap-2 rounded-[var(--radius-input)] border bg-surface px-3 text-sm transition-colors", method === m.id && "border-ink ring-1 ring-ink")}>
                    <input type="radio" name="method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} className="sr-only" />
                    <m.icon className="size-4 text-forest" aria-hidden />{m.label}
                  </label>
                ))}
              </div>
            </fieldset>
            {method === "coin" && (
              <div data-testid="wallet-choice" className="mt-4 rounded-[var(--radius-input)] border border-dashed border-progress bg-progress/10 p-3 text-sm">
                <p><span className="font-medium">Tethran wallet</span>{wallet && <> · {wallet.name}</>}: {wallet?.balance === null || wallet === null ? "balance unavailable" : <span data-testid="payer-balance">{usd(wallet.balance)} test USDT</span>} <SimTag label="Demo wallet" /></p>
                {wallet && wallet.balance !== null && wallet.balance < inv.amount
                  ? <p className="mt-1 text-danger">Not enough to pay {usd(inv.amount)}. <Link to="/app/wallet" className="underline">Add funds</Link>, or pay by card.</p>
                  : <p className="mt-1 text-muted-foreground">Pays {usd(inv.amount)} in test USDT from your wallet into the escrow, after a review of network, recipient and fee.</p>}
              </div>
            )}
            <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Lock className="size-4" aria-hidden />Money waits in escrow. Released only when you approve.</p>
            <PillButton variant="ink" size="lg" className="mt-6 w-full justify-between" disabled={phase === "paying"} onClick={async () => { setPhase("paying"); try { const r = await api.payInvoice(inv.id, method); setSimulated(r.simulated); setPhase("done"); } catch (e) { setPhase("idle"); toast.error((e as Error).message); } }}>
              {phase === "paying" ? "Confirming…" : `Confirm and pay ${usd(inv.amount + inv.fee)}`}
            </PillButton>
          </>
        )}
      </div>
    </main>
  );
}
