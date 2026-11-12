import { createFileRoute } from "@tanstack/react-router";
import { Building2, Coins, Smartphone } from "lucide-react";
import { useState } from "react";
import { api } from "@/api";
import { PageHead } from "@/components/app/AppShell";
import { Async, useApi } from "@/components/app/demo-state";
import { Card, SimTag } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/settings")({
  head: () => ({ meta: [{ title: "Settings — Tethran demo" }, { name: "description", content: "Country profile and payout methods." }] }),
  component: SettingsPage,
});

const RAIL_ICON = { usdt: Coins, evm: Coins, bank: Building2 } as Record<string, typeof Coins>;

function SettingsPage() {
  const profiles = useApi(["country-profiles"], api.countryProfiles);
  const provider = useApi(["provider"], api.provider);
  const [code, setCode] = useState("KE");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHead eyebrow="Settings" light="Your" title="profile." />
      <div className="grid gap-6">
        <Card>
          <div className="flex items-center justify-between"><h2 className="text-2xl">Country profiles</h2><SimTag label="Rates unverified" className="text-muted-foreground" /></div>
          <Async q={profiles} rows={1} empty={<p className="mt-3 text-sm text-muted-foreground">No country profiles.</p>}>
            {(ps) => {
              const p = ps.find((x: any) => x.code === code) ?? ps[0];
              return (
                <>
                  <select value={p.code} onChange={(e) => setCode(e.target.value)} className="mt-4 h-12 w-full rounded-[var(--radius-input)] border bg-background px-3" aria-label="Country">
                    {ps.map((x: any) => <option key={x.code} value={x.code}>{x.name}</option>)}
                  </select>
                  <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                    <div><dt className="text-muted-foreground">Currency</dt><dd className="font-mono">{p.currency}</dd></div>
                    <div><dt className="text-muted-foreground">Tax field</dt><dd>{p.tax_identifiers.map((t: any) => t.label).join(", ") || "—"}</dd></div>
                    <div><dt className="text-muted-foreground">Tax rates</dt><dd>{p.tax_rates.map((t: any) => `${t.name} ${t.rate_bps / 100}%`).join(", ") || "—"}</dd></div>
                  </dl>
                  <p className="mt-3 text-xs text-muted-foreground">Payout rails: {p.payout_rails.join(", ")}. Tax rates are placeholders to verify against current local rules. Each contract carries its country profile; the tax export uses it.</p>
                </>
              );
            }}
          </Async>
        </Card>
        <Card>
          <h2 className="text-2xl">Payout methods</h2>
          <Async q={provider} rows={1} empty={<p className="mt-3 text-sm text-muted-foreground">No payees.</p>}>
            {(pr) => (
              <ul className="mt-4 divide-y">
                {pr.payees.map((p) => { const Icon = RAIL_ICON[p.rail] ?? Smartphone; return (
                  <li key={p.payee_id} className="flex items-center gap-3 py-3"><Icon className="size-5 text-forest" aria-hidden /><span className="flex-1"><span className="block">{p.name}</span><span className="font-mono text-xs text-muted-foreground">{p.rail}</span></span>{p.simulated && <SimTag label="Simulated rail" className="text-muted-foreground" />}</li>
                ); })}
              </ul>
            )}
          </Async>
          <p className="mt-3 text-xs text-muted-foreground">Only these payees can be paid: the vault holds the same allowlist on-chain.</p>
        </Card>
      </div>
    </div>
  );
}
