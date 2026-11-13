import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, type WalletUser } from "@/api";
import { useExternalWallet } from "@/components/app/ConnectWallet";
import { shortAddress } from "@/wallet/external";
import type { Country } from "@/api/types";
import { SignChoice } from "@/components/app/SignChoice";
import { PageHead } from "@/components/app/AppShell";
import { Object3D } from "@/components/tethran/Object3D";
import { PillButton, usd } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/contracts/new")({
  head: () => ({ meta: [{ title: "New contract — Tethran" }, { name: "description", content: "Set parties, milestones and sign." }] }),
  component: Builder,
});

const STEPS = ["Parties", "Milestones", "Review", "Sign"];
type M = { title: string; amount: string; criteria: string };
const input = "h-12 w-full rounded-[var(--radius-input)] border bg-surface px-4 focus:border-ink focus:outline-none";

function Builder() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [client, setClient] = useState("Kofi Mensah Ltd");
  const [email, setEmail] = useState("client@example.com");
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState("NG");
  // Which demo wallet is the client: Kofi Mensah Ltd, or the freelancer's own Tethran wallet (hiring someone else).
  const [payer, setPayer] = useState<WalletUser | "external">("client");
  const extW = useExternalWallet();
  const [ms, setMs] = useState<M[]>([{ title: "Logo design", amount: "400", criteria: "Three concepts, one refined" }]);
  const [signed, setSigned] = useState(false);
  const total = ms.reduce((a, m) => a + (Number(m.amount) || 0), 0);
  const valid = [client.trim() && /\S+@\S+/.test(email), ms.length > 0 && ms.every((m) => m.title.trim() && Number(m.amount) > 0), true, signed][step];
  return (
    <div className="mx-auto max-w-2xl">
      <PageHead eyebrow={`Step ${step + 1} of 4`} light="New" title="contract" />
      <ol className="mb-8 flex gap-2" aria-label="Progress">
        {STEPS.map((s, k) => <li key={s} className="flex-1"><span className={cn("block h-1.5 rounded-full", k <= step ? "bg-ink" : "bg-line")} /><span className={cn("mt-2 block text-xs", k === step ? "font-medium" : "text-muted-foreground")}>{s}</span></li>)}
      </ol>
      <div className="rounded-[var(--radius-sheet)] border bg-surface p-6 shadow-soft md:p-8">
        {step === 0 && (
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm font-medium">Client name<input className={input} value={client} onChange={(e) => setClient(e.target.value)} /></label>
            <label className="grid gap-1.5 text-sm font-medium">Client email<input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="grid gap-1.5 text-sm font-medium">Client pays from
              <select aria-label="Client pays from" className={input} value={payer} onChange={(e) => { const v = e.target.value as WalletUser; setPayer(v); if (v === "payee_amara") setClient("Amara Studio"); else if (client === "Amara Studio") setClient("Kofi Mensah Ltd"); }}>
                <option value="client">Kofi Mensah Ltd's wallet</option>
                <option value="payee_amara">My own wallet (I am the client here)</option>
                {extW.connected && <option value="external">Connected wallet ({shortAddress(extW.address)})</option>}
              </select>
              <span className="text-xs font-normal text-muted-foreground">Wallets on a test network (test USDT). The client's wallet signs the contract, pays, and approves the work.</span>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">Your country profile
              <select className={input} value={country} onChange={(e) => setCountry(e.target.value)}><option value="NG">Nigeria</option><option value="KE">Kenya</option><option value="ZA">South Africa</option><option value="GH">Ghana</option></select>
            </label>
          </div>
        )}
        {step === 1 && (
          <div className="grid gap-4">
            {ms.map((m, k) => (
              <fieldset key={k} className="grid gap-3 rounded-[var(--radius-card)] border p-4">
                <legend className="px-1 font-mono text-xs text-muted-foreground">Milestone {k + 1}</legend>
                <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                  <input aria-label="Title" className={input} placeholder="Title" value={m.title} onChange={(e) => setMs(ms.map((x, j) => j === k ? { ...x, title: e.target.value } : x))} />
                  <input aria-label="Amount in dollars" className={input + " font-mono"} inputMode="decimal" placeholder="$" value={m.amount} onChange={(e) => setMs(ms.map((x, j) => j === k ? { ...x, amount: e.target.value.replace(/[^\d.]/g, "") } : x))} />
                </div>
                <input aria-label="Acceptance criteria" className={input} placeholder="Done when… (separate criteria with ;)" value={m.criteria} onChange={(e) => setMs(ms.map((x, j) => j === k ? { ...x, criteria: e.target.value } : x))} />
                {ms.length > 1 && <button onClick={() => setMs(ms.filter((_, j) => j !== k))} className="inline-flex min-h-11 w-fit items-center gap-1 text-sm text-muted-foreground hover:text-danger"><Trash2 className="size-4" aria-hidden />Remove</button>}
              </fieldset>
            ))}
            <button onClick={() => setMs([...ms, { title: "", amount: "", criteria: "" }])} className="flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed text-sm hover:border-ink"><Plus className="size-4" aria-hidden />Add milestone</button>
          </div>
        )}
        {step === 2 && (
          <div>
            <p className="text-sm text-muted-foreground">With {client} · {country}</p>
            <ul className="mt-4 divide-y">{ms.map((m, k) => <li key={k} className="flex justify-between py-3"><span>{m.title}<span className="block text-sm text-muted-foreground">{m.criteria}</span></span><span className="font-mono">{usd(Number(m.amount))}</span></li>)}</ul>
            <div className="mt-4 flex items-baseline justify-between border-t pt-4"><span className="font-medium">Total</span><span className="font-display text-4xl font-semibold tracking-[-0.04em]">{usd(total)}</span></div>
            <p className="mt-1 text-right text-sm text-muted-foreground">Platform fee 5%: {usd(Math.round(total * 5) / 100)}, deducted from your payout · the client pays exactly the total</p>
          </div>
        )}
        {step === 3 && (
          <div className="text-center">
            <Object3D name="contract" className="mx-auto size-40" decorative />
            <p className="mt-2 text-lg">Sign to send this contract to {client}.</p>
            <p className="mt-2 text-sm text-muted-foreground">You sign the contract hash with your provider wallet; the client signs with its own wallet. Only the hash and the two signatures are stored.</p>
            <label className="mx-auto mt-6 flex w-fit min-h-11 cursor-pointer items-center gap-3 rounded-full border px-5">
              <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} className="size-5 accent-[var(--ink)]" />I agree to these milestones
            </label>
          </div>
        )}
      </div>
      <div className="mt-6 flex justify-between">
        <button disabled={step === 0} onClick={() => setStep(step - 1)} className="min-h-11 rounded-full px-5 text-sm disabled:opacity-40">Back</button>
        {step < 3 ? <PillButton disabled={!valid} onClick={() => setStep(step + 1)}>Continue</PillButton>
          : <SignChoice label={busy ? "Signing…" : "Sign and send"} busy={!valid || busy} onSign={async (via) => {
            setBusy(true);
            try {
              const r = await api.createContract({ clientName: client, clientEmail: email, country: country as Country, milestones: ms.map((m) => ({ title: m.title, amountUsd: Number(m.amount), criteria: m.criteria })), clientWallet: payer }, via);
              toast.success("Contract signed by both parties", { description: via === "demo" ? "Signed with a test key. The invoice is ready to share." : "The invoice is ready to share.", icon: <Check className="size-4" /> });
              if (r.invoiceId) nav({ to: "/app/invoice/$id", params: { id: r.invoiceId } }); else nav({ to: "/app/dashboard" });
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }} />}
      </div>
    </div>
  );
}
