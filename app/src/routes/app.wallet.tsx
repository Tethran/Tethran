import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowUpRight, CreditCard, Wallet } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api, WALLET_USERS, type WalletUser } from "@/api";
import { PageHead } from "@/components/app/AppShell";
import { Async, useApi } from "@/components/app/demo-state";
import { Card, SimTag, usd } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/wallet")({
  head: () => ({ meta: [{ title: "Wallet — Tethran demo" }, { name: "description", content: "Your Tethran demo wallet: balance, add funds, activity." }] }),
  component: WalletPage,
});

const newKey = () => `topup-${crypto.randomUUID()}`;

function WalletPage() {
  const [who, setWho] = useState<WalletUser>("client");
  const balance = useApi(["wallet-balance", who], () => api.walletBalance(who));
  const activity = useApi(["wallet-activity", who], () => api.walletActivity(who));
  const [amount, setAmount] = useState("500");
  const [busy, setBusy] = useState(false);
  // One idempotency key per top-up attempt: a double click or a retry after a timeout is the same top-up.
  const key = useRef(newKey());
  const add = async () => {
    const usdAmount = Number(amount);
    if (!(usdAmount >= 1)) return;
    setBusy(true);
    try {
      await api.addFunds(who, usdAmount, key.current);
      key.current = newKey();
      toast.success(`Added ${usd(usdAmount)} to your demo wallet`, { description: "Simulated card. Test USDT minted on Sepolia (1 USD = 1 test USDT)." });
      await Promise.all([balance.refetch(), activity.refetch()]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const person = WALLET_USERS.find((u) => u.role === who)!;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHead eyebrow="Tethran wallet" light="Your" title="wallet." />
      <p className="mb-6 flex items-start gap-2 rounded-[var(--radius-input)] border border-dashed border-progress bg-progress/10 p-3 text-sm">
        <Wallet className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span><span className="font-medium">Demo wallet.</span> Simulated: test USDT on a test network (Sepolia). One demo seed holds the keys. Not real money.</span>
      </p>
      <div role="tablist" aria-label="Whose wallet" className="mb-6 inline-flex rounded-full border bg-surface p-1">
        {WALLET_USERS.map((u) => (
          <button key={u.role} role="tab" aria-selected={who === u.role} data-testid={`wallet-user-${u.role}`} onClick={() => setWho(u.role)}
            className={cn("min-h-10 rounded-full px-4 text-sm", who === u.role ? "bg-ink text-on-dark" : "hover:bg-line/60")}>
            {u.name} <span className="opacity-70">({u.as})</span>
          </button>
        ))}
      </div>
      <div className="grid gap-6 grid-cols-1 md:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between"><h2 className="text-xl">Balance</h2><SimTag label="Demo wallet" className="text-muted-foreground" /></div>
          <p className="mt-4 font-display text-5xl font-semibold tracking-[-0.04em]" data-testid="wallet-balance">
            {balance.isPending ? "…" : balance.data === null || balance.data === undefined ? "unavailable" : usd(balance.data)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">test USDT · {person.name}</p>
          <p className="mt-4 text-sm text-muted-foreground">Payouts for your work arrive here, and you can pay a milestone from it when you are the client.</p>
        </Card>
        <Card>
          <div className="flex items-center justify-between"><h2 className="text-xl">Add funds</h2><SimTag className="text-muted-foreground" /></div>
          <label className="mt-4 grid gap-1.5 text-sm font-medium">Amount in dollars
            <input aria-label="Amount to add" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, "")); key.current = newKey(); }}
              className="h-12 w-full rounded-[var(--radius-input)] border bg-background px-4 font-mono focus:border-ink focus:outline-none" />
          </label>
          <button data-testid="add-funds" disabled={busy || !(Number(amount) >= 1)} onClick={add}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-on-dark disabled:opacity-40">
            <CreditCard className="size-4" aria-hidden />{busy ? "Adding…" : `Add ${Number(amount) >= 1 ? usd(Number(amount)) : ""} by card`}
          </button>
          <p className="mt-2 text-xs text-muted-foreground">Simulated card. The treasury mints the same amount of test USDT to this wallet (1 USD = 1 test USDT), up to $10,000 at a time.</p>
        </Card>
      </div>
      <section className="mt-8">
        <h2 className="text-2xl">Recent activity</h2>
        <Async q={activity} rows={2} isEmpty={(v) => v.length === 0} empty={<p className="mt-3 text-sm text-muted-foreground">Nothing yet. Add funds, pay a milestone or receive a payout.</p>}>
          {(items) => (
            <ul className="mt-4 grid gap-2" data-testid="wallet-activity">
              {items.map((i, k) => (
                <li key={k} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border bg-surface p-3 text-sm">
                  {i.direction === "in" ? <ArrowDownLeft className="size-4 text-success" aria-hidden /> : <ArrowUpRight className="size-4 text-muted-foreground" aria-hidden />}
                  <span className="flex-1">{i.detail}{i.simulated && <SimTag className="ml-2" />}<span className="block text-xs text-muted-foreground">{i.at.slice(0, 16).replace("T", " ")}{i.txHash && <> · <span className="font-mono">{i.txHash.slice(0, 12)}…</span></>}</span></span>
                  <span className={cn("font-mono", i.direction === "in" ? "text-success" : "")}>{i.direction === "in" ? "+" : "−"}{usd(i.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </section>
    </div>
  );
}
