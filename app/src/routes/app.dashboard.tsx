import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, FileText, Plus, Send } from "lucide-react";
import { api } from "@/api";
import { Async, EmptyBlock, LIVE, useApi } from "@/components/app/demo-state";
import { useRole } from "@/lib/role";
import { PageHead } from "@/components/app/AppShell";
import { Object3D } from "@/components/tethran/Object3D";
import { PillLink, SimTag, StatusChip, pill, usd } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Tethran" }, { name: "description", content: "Your balance, milestones, invoices and receipts." }] }),
  component: Dashboard,
});

/** Home follows the current role (Switch role): the freelancer's money and work, or the client's invoices and approvals. */
function Dashboard() {
  const role = useRole();
  if (role === "client") return <ClientHome />;
  if (role === "operator" || role === "arbiter") return <StaffHome role={role} />;
  return <FreelancerHome />;
}

function FreelancerHome() {
  const contracts = useApi(["contracts"], api.listContracts, LIVE);
  const invoices = useApi(["invoices"], api.listInvoices, LIVE);
  const receipts = useApi(["receipts"], api.listReceipts, LIVE);
  const balance = useApi(["balance"], api.providerBalance, LIVE);
  const paid = useApi(["wallet-activity", "payee_amara"], () => api.walletActivity("payee_amara"), LIVE);
  const earned = (paid.data ?? []).filter((i) => i.kind === "payout").reduce((n, i) => n + i.amount, 0);
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
        <p className="mt-1 text-sm text-muted-dark" data-testid="earned">{usd(earned)} paid to you so far, after the 5% platform fee and the tax reserve</p>
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

/** The client's Home: invoices to pay, milestones funded, work awaiting approval (with the AI's delivery check), wallet. */
function ClientHome() {
  const contracts = useApi(["contracts"], api.listContracts, LIVE);
  const invoices = useApi(["invoices"], api.listInvoices, LIVE);
  const balance = useApi(["wallet-balance", "client"], () => api.walletBalance("client"), LIVE);
  const ms = (contracts.data ?? []).flatMap((c) => c.milestones.map((m) => ({ ...m, client: c.client }))).filter((m) => m.live);
  const awaiting = ms.filter((m) => m.status === "In review");
  const funded = ms.filter((m) => m.status === "Funded");
  return (
    <div>
      <PageHead eyebrow="Client" light="Welcome back," title="Kofi." />
      <div className="dark relative overflow-hidden rounded-[var(--radius-sheet)] bg-ink p-6 text-on-dark md:p-10">
        <p className="text-sm text-muted-dark">Wallet balance</p>
        <p className="mt-2 font-display text-6xl font-semibold tracking-[-0.05em]" data-testid="client-balance">{balance.data == null ? (balance.isPending ? "…" : "unavailable") : usd(balance.data)}<span className="ml-2 text-xl text-muted-dark">test USDT</span></p>
        <div className="relative mt-6 flex flex-wrap gap-3"><Link to="/app/wallet" className={pill({ variant: "lime" })}>Add funds</Link></div>
      </div>
      <div className="mt-10 grid gap-8 grid-cols-1 lg:grid-cols-3 *:min-w-0">
        <section>
          <h2 className="text-2xl">To pay</h2>
          <Async q={invoices} rows={1} isEmpty={(v) => !v.some((i) => i.status === "Unpaid")} empty={<p className="mt-3 text-sm text-muted-foreground">Nothing to pay.</p>}>
            {(is) => <ul className="mt-4 grid gap-3" data-testid="client-to-pay">{is.filter((i) => i.status === "Unpaid").map((i) => (
              <li key={i.id}><Link to="/pay/$id" params={{ id: i.id }} className="flex items-center gap-3 rounded-[var(--radius-card)] border bg-surface p-4 hover:border-ink"><FileText className="size-5 text-forest" aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{i.title}</span><span className="text-sm text-muted-foreground">{i.number}</span></span><span className="font-mono">{usd(i.amount)}</span></Link></li>
            ))}</ul>}
          </Async>
        </section>
        <section>
          <h2 className="text-2xl">Awaiting your approval</h2>
          {awaiting.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No work waiting for you.</p> : (
            <ul className="mt-4 grid gap-3" data-testid="client-awaiting">{awaiting.map((m) => (
              <li key={m.id}><Link to="/app/milestone/$id" params={{ id: m.id }} className="flex items-center gap-3 rounded-[var(--radius-card)] border border-ink/40 bg-surface p-4 hover:border-ink"><span className="min-w-0 flex-1"><span className="block truncate font-medium">{m.title}</span><span className="text-sm text-muted-foreground">Work submitted: review the AI's delivery check and approve</span></span><ChevronRight className="size-4" aria-hidden /></Link></li>
            ))}</ul>
          )}
        </section>
        <section>
          <h2 className="text-2xl">Funded</h2>
          {funded.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Nothing in escrow waiting for delivery.</p> : (
            <ul className="mt-4 grid gap-3" data-testid="client-funded">{funded.map((m) => (
              <li key={m.id}><Link to="/app/milestone/$id" params={{ id: m.id }} className="flex items-center gap-3 rounded-[var(--radius-card)] border bg-surface p-4 hover:border-ink"><span className="min-w-0 flex-1 truncate font-medium">{m.title}</span><StatusChip status={m.status} /><span className="font-mono">{usd(m.amount)}</span></Link></li>
            ))}</ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** Operator and arbiter: their work lives on their own screens. */
function StaffHome({ role }: { role: "operator" | "arbiter" }) {
  const to = role === "operator" ? "/app/operator" : "/app/arbiter";
  return (
    <div>
      <PageHead eyebrow={role} light="You are the" title={role + "."} />
      <p className="text-muted-foreground">{role === "operator" ? "Limits, escalations, identity holds and the audit log are on the Operator screen; fees on Earnings." : "Open disputes wait on the Arbiter screen."}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <PillLink to={to} variant="ink">Open the {role} screen</PillLink>
        {role === "operator" && <PillLink to="/app/earnings">Earnings</PillLink>}
      </div>
    </div>
  );
}
