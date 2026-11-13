import { createFileRoute, Link } from "@tanstack/react-router";
import { Landmark } from "lucide-react";
import { api } from "@/api";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { Card, SimTag, usd } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/earnings")({
  head: () => ({ meta: [{ title: "Earnings — Tethran" }, { name: "description", content: "Tethran's 5% platform fee: total collected, per-milestone fee lines, the earnings account." }] }),
  component: EarningsPage,
});

function EarningsPage() {
  const q = useApi(["earnings"], api.earnings);
  return (
    <div>
      <PageHead eyebrow="Operator · Earnings" light="Tethran" title="earnings." />
      <p className="mb-6 flex items-start gap-2 rounded-[var(--radius-input)] border border-dashed border-progress bg-progress/10 p-3 text-sm">
        <Landmark className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span><span className="font-medium">Tethran earnings account.</span> Tethran's platform fee is 5% of each milestone, paid by the freelancer out of the settlement and enforced by the Policy Service. A wallet on a test network holding test USDT; in production this is a company treasury.</span>
      </p>
      <Async q={q} rows={2} empty={<EmptyBlock title="No earnings yet." />}>
        {(e) => (
          <div className="grid gap-6">
            <div className="grid gap-6 grid-cols-1 md:grid-cols-2">
              <Card>
                <div className="flex items-center justify-between"><h2 className="text-xl">Total collected</h2></div>
                <p className="mt-4 font-display text-5xl font-semibold tracking-[-0.04em]" data-testid="earnings-total">{usd(e.totalCollected)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{e.lines.filter((l) => l.status === "confirmed").length} fee line(s) confirmed on-chain</p>
              </Card>
              <Card>
                <div className="flex items-center justify-between"><h2 className="text-xl">Earnings account</h2></div>
                <p className="mt-4 font-display text-5xl font-semibold tracking-[-0.04em]" data-testid="earnings-balance">{e.balance === null ? "unavailable" : usd(e.balance)}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{e.address ?? "not configured"}</p>
              </Card>
            </div>
            <section>
              <h2 className="text-2xl">Fee lines</h2>
              {e.lines.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No fee lines yet. A fee is paid when a milestone settles; refunds and disputes decided for the client pay none.</p> : (
                <div className="relative mt-4 overflow-x-auto rounded-[var(--radius-card)] border bg-surface">
                  <table className="w-full min-w-[560px] text-sm" data-testid="earnings-lines">
                    <thead><tr className="border-b text-left text-muted-foreground"><th className="p-4 font-medium">Milestone</th><th className="p-4 text-right font-medium">Gross</th><th className="p-4 text-right font-medium">Fee (5%)</th><th className="p-4 font-medium">Status</th><th className="p-4 font-medium">Transaction</th></tr></thead>
                    <tbody>
                      {e.lines.map((l, k) => (
                        <tr key={k} className="border-b last:border-0">
                          <td className="p-4"><Link to="/app/milestone/$id" params={{ id: l.milestoneId }} className="underline">{l.title}</Link></td>
                          <td className="p-4 text-right font-mono">{usd(l.gross)}</td>
                          <td className="p-4 text-right font-mono">{usd(l.fee)}</td>
                          <td className="p-4 capitalize">{l.status}</td>
                          <td className="whitespace-nowrap p-4 font-mono text-xs">{l.tx ? `${l.tx.slice(0, 14)}…` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </Async>
    </div>
  );
}
