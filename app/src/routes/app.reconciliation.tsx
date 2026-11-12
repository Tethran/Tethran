import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Check, Download, Minus } from "lucide-react";
import { api, reasonInfo } from "@/api";
import { toast } from "sonner";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { pill, usd } from "@/components/tethran/ui";
import type { ReconRow } from "@/api/types";

export const Route = createFileRoute("/app/reconciliation")({
  head: () => ({ meta: [{ title: "Reconciliation — Tethran demo" }, { name: "description", content: "Every invoice linked to payment, escrow, payout and receipt." }] }),
  component: Recon,
});

const COLS: (keyof ReconRow)[] = ["payment", "escrow", "payout", "receipt"];
function issues(rows: ReconRow[]) {
  const out: { id: string; text: string }[] = [];
  for (const r of rows) for (const g of r.gaps) { const i = reasonInfo(g); out.push({ id: r.id + g, text: `${r.invoice}: ${i.title}. ${i.plain}` }); }
  return out;
}
async function csv() {
  // The backend's tax export. It refuses with a plain reason if a row has no contract country profile.
  const res = await fetch(api.reconCsvUrl());
  if (!res.ok) { const j = await res.json().catch(() => ({})); toast.error(j.error ?? "The export is not available."); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = "tethran-reconciliation.csv"; a.click(); URL.revokeObjectURL(url);
}

function Recon() {
  const q = useApi(["recon"], api.listRecon);
  return (
    <div>
      <PageHead eyebrow="Reconciliation" light="Every dollar," title="traced.">
        {q.data && q.data.length > 0 && <button onClick={() => csv()} className={pill({ variant: "ghost", size: "plain" })}><Download className="size-4" aria-hidden />Export CSV</button>}
      </PageHead>
      <Async q={q} empty={<EmptyBlock obj="ledger" title="No payments to reconcile yet." />}>
        {(rows) => (
          <div className="grid gap-8 grid-cols-1 lg:grid-cols-[1.6fr_1fr] *:min-w-0">
            <div className="relative overflow-x-auto rounded-[var(--radius-card)] border bg-surface">
              <table className="w-full min-w-[620px] text-sm">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="p-4 font-medium">Invoice</th>{COLS.map((c) => <th key={c} className="p-4 font-medium capitalize">{c}</th>)}<th className="p-4 font-medium">Country</th><th className="p-4 text-right font-medium">Amount</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="whitespace-nowrap p-4 font-mono">{r.invoice}</td>
                      {COLS.map((c) => <td key={c} className="p-4">{r[c] ? <span className="inline-flex items-center gap-1 font-mono text-xs"><Check className="size-3.5 text-success" aria-hidden />{r[c]}</span> : <span className="inline-flex items-center gap-1 text-muted-foreground"><Minus className="size-3.5" aria-hidden /><span className="sr-only">missing</span></span>}</td>)}
                      <td className="p-4">{r.country ?? <span className="inline-flex items-center gap-1 rounded-full bg-progress/15 px-2 py-0.5 text-xs font-medium"><AlertTriangle className="size-3" aria-hidden />No profile</span>}</td>
                      <td className="p-4 text-right font-mono">{usd(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <section>
              <h2 className="text-2xl">Issues</h2>
              {issues(rows).length === 0 && <p className="mt-4 text-sm text-muted-foreground">No gaps. Every record is joined.</p>}<ul className="mt-4 grid gap-3">{issues(rows).map((i) => <li key={i.id} className="flex gap-3 rounded-[var(--radius-card)] border border-progress/40 bg-surface p-4 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-progress" aria-hidden />{i.text}</li>)}</ul>
            </section>
          </div>
        )}
      </Async>
    </div>
  );
}
