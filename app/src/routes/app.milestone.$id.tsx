import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Clock, FlaskConical, Link2, ListChecks, Paperclip, Sparkles } from "lucide-react";
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
  head: () => ({ meta: [{ title: "Milestone — Tethran" }, { name: "description", content: "Timeline, evidence, approval or dispute." }] }),
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

const ACCEPT = ".txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif,.zip";
const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Which agent answered: a live model call, or a saved answer (replay). */
function ModeTag({ mode }: { mode: string | null | undefined }) {
  if (!mode) return null;
  const live = mode === "live";
  return <span data-testid="agent-mode" className={cn("inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[0.68rem] uppercase tracking-wider", live ? "border-success/40 text-success" : "border-dashed border-progress")} title={live ? "A model answered this time (Groq, Gemini fallback)" : mode}>{live ? "Live model" : "Replay"}</span>;
}

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
  const [link, setLink] = useState("");
  const [files, setFiles] = useState<File[]>([]);
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
                        {p.local && (
                          <span className="basis-full text-xs text-muted-foreground" data-testid="payout-local">
                            ≈ {Number(p.local.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} {p.local.currency} on the simulated payout · {p.local.rateLabel}
                            {p.local.attribution && <> · <a href={p.local.attribution.url} target="_blank" rel="noopener noreferrer" className="underline">{p.local.attribution.text}</a></>}
                          </span>
                        )}
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
                {m.evidence?.length ? (
                  <ul className="mt-3 grid gap-3" data-testid="evidence-list">
                    {m.evidence.map((e) => (
                      <li key={e.id} className="rounded-[var(--radius-input)] border p-3 text-sm">
                        <p className="font-mono text-xs text-muted-foreground">{e.at.slice(0, 16).replace("T", " ")}</p>
                        {e.note && <p className="mt-1 whitespace-pre-wrap break-words">{e.note}</p>}
                        {e.link && <p className="mt-1 flex items-center gap-1 break-all"><Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden /><a href={e.link} target="_blank" rel="noopener noreferrer nofollow" className="underline">{e.link}</a></p>}
                        {e.files.length > 0 && (
                          <ul className="mt-2 grid gap-1">
                            {e.files.map((f) => (
                              <li key={f.id} className="flex items-center gap-2"><Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                <a href={f.url} download={f.name} className="break-all underline">{f.name}</a>
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">{fileSize(f.size)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-2 text-sm text-muted-foreground">Nothing submitted yet.</p>}
                {m.live && st !== "Paid out" && (
                  <form className="mt-4 grid gap-2" data-testid="evidence-form" onSubmit={(e) => {
                    e.preventDefault();
                    if (!note.trim() && !link.trim() && files.length === 0) return;
                    run(() => api.addEvidence(m.id, { note: note.trim(), link: link.trim(), files }), "Delivery submitted. The AI checked it against the criteria.").then(() => { setNote(""); setLink(""); setFiles([]); });
                  }}>
                    <textarea aria-label="Delivery note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was delivered, and where" className="min-h-24 rounded-[var(--radius-input)] border bg-background p-3 text-sm" />
                    <input aria-label="Delivery link" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link (optional), https://…" className="h-11 rounded-[var(--radius-input)] border bg-background px-3 text-sm" />
                    <label className="grid gap-1 text-sm">
                      <span className="text-muted-foreground">Files (optional): up to 5, 10 MB each; txt, md, csv, json, pdf, png, jpg, webp, gif, zip</span>
                      <input aria-label="Delivery files" type="file" multiple accept={ACCEPT} onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        const bad = picked.find((f) => f.size > 10 * 1024 * 1024);
                        if (picked.length > 5) { toast.error("At most 5 files."); e.target.value = ""; return; }
                        if (bad) { toast.error(`${bad.name} is larger than 10 MB.`); e.target.value = ""; return; }
                        setFiles(picked);
                      }} className="text-sm file:mr-3 file:rounded-full file:border file:bg-surface file:px-3 file:py-1.5" />
                    </label>
                    {files.length > 0 && <p className="text-xs text-muted-foreground">{files.map((f) => f.name).join(", ")}</p>}
                    <button data-testid="submit-delivery" disabled={busy || (!note.trim() && !link.trim() && files.length === 0)} className="min-h-11 rounded-full border text-sm hover:border-ink disabled:opacity-40">{busy ? "Submitting and checking…" : "Submit delivery"}</button>
                    <p className="text-xs text-muted-foreground">Evidence is data for the AI, never instructions. Files are stored for download only, never opened or run.</p>
                  </form>
                )}
              </Card>
              {m.deliveryCheck && m.deliveryCheck.checks.length > 0 && (
                <div data-testid="delivery-check"><Card className="border-agent/30">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm text-agent"><ListChecks className="size-4" aria-hidden />The AI's delivery check</p>
                    <ModeTag mode={m.deliveryCheck.agentMode} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Advisory: checked against the milestone's acceptance criteria. You decide whether to approve.</p>
                  <ul className="mt-3 grid gap-2">
                    {m.deliveryCheck.checks.map((c, k) => (
                      <li key={k} className="text-sm">
                        <span className={cn("mr-2 inline-flex rounded-full px-2 py-0.5 font-mono text-[0.68rem] uppercase", c.status === "met" ? "bg-success/15 text-success" : c.status === "unmet" ? "bg-danger/15 text-danger" : "bg-progress/20")}>{c.status}</span>
                        <span className="font-medium">{c.criterion}</span>
                        <span className="block text-muted-foreground">{c.reason}</span>
                      </li>
                    ))}
                  </ul>
                  {m.deliveryCheck.error && <p className="mt-2 text-xs text-muted-foreground">The check could not finish ({m.deliveryCheck.error}); each criterion is shown as unclear.</p>}
                </Card></div>
              )}
              {proposal && (
                <Card className="border-agent/30">
                  <p className="flex items-center gap-2 text-sm text-agent"><Sparkles className="size-4" aria-hidden />The AI's plan <ModeTag mode={proposal.agentMode} /></p>
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
                  <p className="flex items-center gap-2 text-sm font-medium"><FlaskConical className="size-4" aria-hidden />Platform step</p>
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
