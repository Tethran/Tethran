import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, FileText, Plus, Send } from "lucide-react";
import { api } from "@/api";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { PageHead } from "@/components/app/AppShell";
import { Object3D } from "@/components/tethran/Object3D";
import { PillLink, SimTag, StatusChip, pill, usd } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Tethran demo" }, { name: "description", content: "Your balance, milestones, invoices and receipts." }] }),
  component: Dashboard,
});

function Dashboard() {
  const contracts = useApi(["contracts"], api.listContracts);
  const invoices = useApi(["invoices"], api.listInvoices);
  const receipts = useApi(["receipts"], api.listReceipts);
  const balance = useApi(["balance"], api.providerBalance);
  const name = contracts.data?.[0]?.provider ?? "Provider";
  const held = (contracts.data ?? []).flatMap((c) => c.milestones).filter((m) => ["Funded", "In review", "Approved", "Disputed", "Released"].includes(m.status)).reduce((n, m) => n + m.amount, 0);
  return (
    <div>
      <PageHead eyebrow={name} light="Welcome back," title={name + "."}>
        <PillLink to="/app/contracts/new" variant="ink">Create contract</PillLink>
      </PageHead>
      <div className="dark relative overflow-hidden rounded-[var(--radius-sheet)] bg-ink p-6 text-on-dark md:p-10">
        <Object3D name="coin" className="absolute -right-6 -bottom-6 size-44 md:size-64" decorative />
        <p className="text-sm text-muted-dark">Available balance</p>
        <p className="mt-2 font-display text-6xl font-semibold tracking-[-0.05em] md:text-8xl">{balance.data !== undefined ? usd(balance.data) : balance.isError ? "unavailable" : "…"}<span className="ml-2 text-xl text-muted-dark">test USDT</span></p>
        <p className="mt-2 text-sm text-muted-dark">{usd(held)} more held in escrow or the vault</p>
        <div className="relative mt-8 flex flex-wrap gap-3">
          <Link to="/app/send" className={pill({ variant: "lime" })}>Send to phone<span className="grid size-8 place-items-center rounded-full bg-lime-ink text-lime"><Send className="size-4" aria-hidden /></span></Link>
          <SimTag className="self-center text-muted-dark" label="Test network" />
        </div>
      </div>

      <div className="mt-10 grid gap-8 grid-cols-1 lg:grid-cols-[1.5fr_1fr] *:min-w-0">
        <section>
          <h2 className="text-2xl">Active milestones</h2>
          <div className="mt-4">
            <Async q={contracts} empty={<EmptyBlock title="No milestones yet. Create a contract to start."><PillLink to="/app/contracts/new">Create contract</PillLink></EmptyBlock>}>
              {(cs) => (
                <ul className="grid gap-3">
                  {cs.flatMap((c) => c.milestones.filter((m) => m.live).map((m) => (
                    <li key={m.id}>
                      <Link to="/app/milestone/$id" params={{ id: m.id }} className="flex items-center gap-4 rounded-[var(--radius-card)] border bg-surface p-4 shadow-soft transition-colors hover:border-ink">
                        <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.title}</p><p className="truncate text-sm text-muted-foreground">{c.client}</p></div>
                        <StatusChip status={m.status} />
                        <span className="hidden font-mono sm:block">{usd(m.amount)}</span>
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  )))}
                </ul>
              )}
            </Async>
          </div>
        </section>
        <aside className="grid content-start gap-8">
          <section>
            <h2 className="text-2xl">Unpaid invoices</h2>
            <div className="mt-4">
              <Async q={invoices} rows={1} isEmpty={(v) => !v.some((i) => i.status === "Unpaid")} empty={<EmptyBlock obj="invoice" title="All invoices are paid." />}>
                {(is) => <ul className="grid gap-3">{is.filter((i) => i.status === "Unpaid").map((i) => (
                  <li key={i.id}><Link to="/app/invoice/$id" params={{ id: i.id }} className="flex items-center gap-3 rounded-[var(--radius-card)] border bg-surface p-4 hover:border-ink"><FileText className="size-5 text-forest" aria-hidden /><span className="flex-1 font-mono text-sm">{i.number}</span><span className="font-mono">{usd(i.amount)}</span></Link></li>
                ))}</ul>}
              </Async>
            </div>
          </section>
          <section>
            <h2 className="text-2xl">Recent receipts</h2>
            <div className="mt-4">
              <Async q={receipts} rows={1} empty={<EmptyBlock obj="receipt" title="Receipts appear after a payout." />}>
                {(rs) => <ul className="grid gap-3">{rs.map((r) => (
                  <li key={r.id}><Link to="/receipt/$id" params={{ id: r.id }} className="flex items-center gap-3 rounded-[var(--radius-card)] border bg-surface p-3 hover:border-ink"><Object3D name="receipt" className="size-12" decorative /><span className="flex-1"><span className="block font-medium">{r.milestoneTitle}</span><span className="text-sm text-muted-foreground">{r.date}</span></span><span className="font-mono">{usd(r.amount)}</span></Link></li>
                ))}</ul>}
              </Async>
            </div>
          </section>
          <Link to="/app/contracts/new" className="flex min-h-14 items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed text-muted-foreground hover:border-ink hover:text-ink"><Plus className="size-4" aria-hidden />New contract</Link>
        </aside>
      </div>
    </div>
  );
}
