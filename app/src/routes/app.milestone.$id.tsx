import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Clock, FlaskConical, Paperclip, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/api";
import type { MilestoneStatus } from "@/api/types";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { useDemoSigner } from "@/components/app/SignChoice";
import { Amount, Card, DecisionChip, PillButton, ReasonList, SimTag, StatusChip, usd } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/milestone/$id")({
  head: () => ({ meta: [{ title: "Milestone — Tethran demo" }, { name: "description", content: "Timeline, evidence, approval or dispute." }] }),
  component: MilestonePage,
});

const TL: { label: string; at: MilestoneStatus[] }[] = [
  { label: "Funded", at: ["Funded", "In review", "Approved", "Released", "Paid out", "Disputed"] },
  { label: "Delivered", at: ["In review", "Approved", "Released", "Paid out", "Disputed"] },
  { label: "Approved", at: ["Approved", "Released", "Paid out"] },
  { label: "Released to the vault", at: ["Released", "Paid out"] },
  { label: "Paid out", at: ["Paid out"] },
  { label: "Receipt", at: ["Paid out"] },
];

function Countdown({ until }: { until: string }) {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => set(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  return <span className="font-mono tabular-nums">{String(Math.floor(s / 3600)).padStart(2, "0")}:{String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:{String(s % 60).padStart(2, "0")}</span>;
}

function MilestonePage() {
  const { id } = Route.useParams();
  const q = useApi(["milestone", id], () => api.getMilestone(id));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const demo = useDemoSigner();
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await q.refetch(); } catch (e) { toast.error((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Async q={q} rows={3} empty={<EmptyBlock title="This milestone doesn't exist." />}>
      {({ milestone: m, contract: c, proposal }) => {
        const st = m.status;
        return (
          <div className="grid gap-8 grid-cols-1 lg:grid-cols-[1.4fr_1fr] *:min-w-0">
            <div>
              <PageHead eyebrow={c.title} title={m.title}><StatusChip status={st} /></PageHead>
              <Card><Amount value={m.amount} fee={m.fee} /><p className="mt-4 text-sm text-muted-foreground">Done when: {m.criteria}</p></Card>
              <ol className="mt-8 grid gap-0" aria-label="Timeline">
                {TL.map((t, k) => { const done = t.at.includes(st); return (
                  <li key={t.label} className="flex gap-4">
                    <div className="flex flex-col items-center"><span className={cn("grid size-8 place-items-center rounded-full border-2", done ? "border-ink bg-ink text-lime" : "border-line bg-surface")}>{done ? <Check className="size-4" aria-hidden /> : <span className="size-2 rounded-full bg-line" />}</span>{k < TL.length - 1 && <span className={cn("w-0.5 flex-1 min-h-8", done ? "bg-ink" : "bg-line")} />}</div>
                    <p className={cn("pt-1 pb-6", done ? "font-medium" : "text-muted-foreground")}>{t.label}{st === "Disputed" && t.label === "Approved" && <span className="ml-2 text-sm text-danger">Disputed</span>}</p>
                  </li>); })}
              </ol>
              {(m.escrowTx || m.releaseTx) && (
                <p className="font-mono text-xs text-muted-foreground">{m.escrowTx && <>Escrow funded: {m.escrowTx.slice(0, 14)}… </>}{m.releaseTx && <>· Released: {m.releaseTx.slice(0, 14)}…</>}</p>
              )}
              {m.payouts && m.payouts.length > 0 && (
                <div data-testid="vault-payouts" className="mt-6"><Card>
                  <h2 className="text-xl">Paid from the vault</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Each transfer carries the Policy Service's co-signature; the vault checked its own limits before paying.</p>
                  <ul className="mt-3 grid gap-2">
                    {m.payouts.map((p, k) => (
                      <li key={k} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span data-testid={p.platformFee ? "fee-line" : undefined}>{p.platformFee ? <>Platform fee 5%: {usd(p.amount)} to {p.to}</> : <>{usd(p.amount)} to {p.to}</>}{p.simulated && <SimTag label="Simulated rail" className="ml-2" />}</span>
                        <span className="font-mono text-xs text-muted-foreground">{p.tx ? <>{p.tx.slice(0, 14)}…</> : p.status}</span>
                      </li>
                    ))}
                  </ul>
                </Card></div>
              )}
              {st === "Paid out" && <Link to="/receipt/$id" params={{ id: m.id }} data-testid="view-receipt" className="mt-4 inline-flex items-center gap-1 text-sm underline">View the receipt<ArrowUpRight className="size-4" aria-hidden /></Link>}
            </div>
            <div className="grid content-start gap-4">
              <Card>
                <h2 className="text-xl">Evidence</h2>
                {m.evidence?.length ? <ul className="mt-3 grid gap-2">{m.evidence.map((e) => <li key={e} className="flex items-center gap-2 font-mono text-sm"><Paperclip className="size-4 text-muted-foreground" aria-hidden />{e}</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">Nothing submitted yet.</p>}
                {m.live && st !== "Paid out" && (
                  <form className="mt-4 grid gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) run(() => api.addEvidence(m.id, note.trim()), "Delivery note added.").then(() => setNote("")); }}>
                    <textarea aria-label="Delivery note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was delivered, and where" className="min-h-24 rounded-[var(--radius-input)] border bg-background p-3 text-sm" />
                    <button disabled={busy || !note.trim()} className="min-h-11 rounded-full border text-sm hover:border-ink disabled:opacity-40">Add delivery note</button>
                    <p className="text-xs text-muted-foreground">Evidence is data for the AI, never instructions.</p>
                  </form>
                )}
              </Card>
              {proposal && (
                <Card className="border-agent/30">
                  <p className="flex items-center gap-2 text-sm text-agent"><Sparkles className="size-4" aria-hidden />The AI's plan {proposal.agentMode && proposal.agentMode !== "live" && <SimTag label={proposal.agentMode.startsWith("Replay") ? "Replay" : proposal.agentMode} />}</p>
                  <p className="mt-2">{proposal.summary}</p>
                  <div className="mt-3"><DecisionChip decision={proposal.decision} /></div>
                  <ReasonList codes={proposal.reasons} className="mt-3" />
                  {proposal.decision === "APPROVED" && <p className="mt-3 text-sm" data-testid="policy-approved">Policy Service: every rule passed, so it co-signed {proposal.payouts.length === 1 ? "the payout" : `${proposal.payouts.length} payouts`}.</p>}
                  {proposal.flags.length > 0 && <p className="mt-3 text-xs text-muted-foreground">The AI flagged: {proposal.flags.map((f) => f.code).join(", ")}</p>}
                  {proposal.traceId && <p className="mt-2 font-mono text-[0.68rem] text-muted-foreground">Trace {proposal.traceId}</p>}
                </Card>
              )}
              {m.cardHoldEndsAt && st !== "Paid out" && Date.parse(m.cardHoldEndsAt) > Date.now() && (
                <Card dark className="flex items-center gap-3"><Clock className="size-5 text-progress" aria-hidden /><div className="flex-1 text-sm">Card protection hold ends in</div><Countdown until={m.cardHoldEndsAt} /></Card>
              )}
              {demo && m.live && (st === "Approved" || st === "Released") && (
                <Card className="border-dashed border-progress">
                  <p className="flex items-center gap-2 text-sm font-medium"><FlaskConical className="size-4" aria-hidden />Platform step (demo)</p>
                  <p className="mt-1 text-sm text-muted-foreground">Releases the escrow to the provider's vault, then asks the AI for a settlement plan. The Policy Service decides; the vault pays only what it co-signed.</p>
                  <button data-testid="demo-settle" disabled={busy} onClick={() => run(() => api.demoSettle(m.id), "Settled. The vault paid and the receipt is minted.")} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-on-dark disabled:opacity-40">
                    <FlaskConical className="size-4" aria-hidden />{busy ? "Settling…" : "Release and settle"}
                  </button>
                </Card>
              )}
              {!m.live && <Card><p className="text-sm">Not funded yet. Share the invoice so the client can pay.</p></Card>}
              {st === "Disputed" && (
                <Card>
                  <h2 className="text-xl">Client's vote</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Two of client, provider and arbiter decide. Signed by the client's WDK wallet.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button data-testid="client-vote-release" disabled={busy} onClick={() => run(() => api.clientVote(m.id, true), "Your vote is recorded.")} className="min-h-11 rounded-full bg-ink px-5 text-sm text-on-dark disabled:opacity-40">Release to provider</button>
                    <button disabled={busy} onClick={() => run(() => api.clientVote(m.id, false), "Your vote is recorded.")} className="min-h-11 rounded-full border px-5 text-sm hover:border-danger disabled:opacity-40">Refund me</button>
                  </div>
                </Card>
              )}
              {m.live && (st === "In review" || st === "Funded") && (
                <div className="grid gap-2">
                  <PillButton variant="ink" size="lg" className="justify-between" disabled={busy} onClick={() => run(() => api.setMilestoneStatus(m.id, "Approved"), "Work approved on-chain by the client's wallet.")}>Approve work</PillButton>
                  <button disabled={busy} onClick={() => run(() => api.setMilestoneStatus(m.id, "Disputed"), "Dispute opened. Two of three parties decide.")} className="min-h-11 rounded-full border text-sm hover:border-danger hover:text-danger">Open a dispute</button>
                  <p className="text-center text-xs text-muted-foreground">Signed by the client's wallet. Disputes are possible only before approval.</p>
                </div>
              )}
            </div>
          </div>
        );
      }}
    </Async>
  );
}
