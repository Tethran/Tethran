import { createFileRoute } from "@tanstack/react-router";
import { Check, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/api";
import type { ApprovalItem } from "@/api/types";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { Card, DecisionChip, ReasonList, SimTag, usd } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/operator")({
  head: () => ({ meta: [{ title: "Operator console — Tethran demo" }, { name: "description", content: "Limits, approval queue and audit log." }] }),
  component: Operator,
});

const fail = (e: unknown) => toast.error((e as ApiError)?.message ?? "Something went wrong.");

function Operator() {
  const lim = useApi(["limits"], api.getLimits);
  const queue = useApi(["approvals"], api.listApprovals);
  const holds = useApi(["identity-holds"], api.listIdentityHolds);
  const log = useApi(["audit"], api.listAudit);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  const decide = async (a: ApprovalItem, decision: "approve" | "reject" | "new_plan") => {
    setBusy(a.id);
    try {
      const r = await api.decideApproval(a, decision);
      const msg = r.decision === "approved" ? "Approved. The vault paid out within its limits."
        : r.decision === "new_plan_requested" ? "New plan requested. Nothing was paid; the milestone waits for a new settlement."
        : "Rejected. Nothing was paid.";
      setDone({ ...done, [a.id]: msg });
      toast.success(msg);
      queue.refetch(); log.refetch();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const decideHold = async (milestoneId: string, decision: "release" | "hold") => {
    setBusy(milestoneId);
    try {
      await api.decideIdentity(milestoneId, decision);
      toast.success(decision === "release" ? "Released to the provider's vault." : "Kept on hold.");
      holds.refetch();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <div>
      <PageHead eyebrow="Operator" light="Rules the AI" title="can't break." />
      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
        <div className="grid content-start gap-8">
          <Card>
            <h2 className="text-2xl">Limits</h2>
            <Async q={lim} rows={2} empty={<p className="mt-3 text-sm text-muted-foreground">No limits set. Nothing can be sent until you add one.</p>}>
              {(l) => (
                <dl className="mt-5 grid gap-3 text-sm">
                  <div className="flex justify-between"><dt>The AI can send up to, per payment</dt><dd className="font-mono">{usd(l.perPayment)}</dd></div>
                  <div className="flex justify-between"><dt>A person confirms payments above</dt><dd className="font-mono">{usd(l.softLimit)}</dd></div>
                  <div className="flex justify-between"><dt>And no more than, per day</dt><dd className="font-mono">{usd(l.daily)}</dd></div>
                  <div className="flex justify-between"><dt>Set aside for tax, at least</dt><dd className="font-mono">{l.taxReservePercent}%</dd></div>
                  <div className="flex justify-between"><dt>Escalate when the AI's confidence is under</dt><dd className="font-mono">{l.confidenceThreshold}</dd></div>
                  <div>Only to these people<ul className="mt-2 flex flex-wrap gap-2">{l.approvedPayees.map((p) => <li key={p} className="rounded-full bg-muted px-3 py-1">{p}</li>)}</ul></div>
                  <p className="text-xs text-muted-foreground">Policy version {l.version}. The vault enforces the same caps on-chain. Changing them takes the operator's signature on the policy and on the vault update.</p>
                </dl>
              )}
            </Async>
          </Card>
          <Card>
            <div className="flex items-center justify-between"><h2 className="text-2xl">Identity holds</h2><SimTag label="Simulated check" className="text-muted-foreground" /></div>
            <div className="mt-4">
              <Async q={holds} rows={1} empty={<p className="text-sm text-muted-foreground">No releases on hold.</p>}>
                {(hs) => (
                  <ul className="grid gap-3">{hs.map((h) => (
                    <li key={h.milestoneId} className="rounded-[var(--radius-input)] border p-4 text-sm">
                      <p className="font-medium">Milestone {h.milestoneId.slice(0, 8)}</p>
                      <p className="mt-1 text-muted-foreground">{h.reason}</p>
                      <div className="mt-3 flex gap-2">
                        <button disabled={busy === h.milestoneId} onClick={() => decideHold(h.milestoneId, "release")} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-on-dark disabled:opacity-40"><Check className="size-4" aria-hidden />Release</button>
                        <button disabled={busy === h.milestoneId} onClick={() => decideHold(h.milestoneId, "hold")} className="inline-flex min-h-11 items-center gap-2 rounded-full border px-5 hover:border-danger"><X className="size-4" aria-hidden />Keep on hold</button>
                      </div>
                    </li>
                  ))}</ul>
                )}
              </Async>
            </div>
          </Card>
        </div>
        <section>
          <h2 className="text-2xl">Needs your decision</h2>
          <p className="mt-1 text-sm text-muted-foreground">Each decision is signed with your operator wallet. The Policy Service checks the signature, runs the rules again and only then co-signs.</p>
          <div className="mt-4">
            <Async q={queue} empty={<EmptyBlock obj="gate" title="Nothing waiting. The rules handled everything." />}>
              {(items) => (
                <ul className="grid gap-4">
                  {items.map((a) => (
                    <li key={a.id}><Card>
                      <div className="flex flex-wrap items-center justify-between gap-2"><DecisionChip decision={a.proposal.decision} /><span className="font-display text-3xl font-semibold tracking-[-0.04em]">{usd(a.amount)}</span></div>
                      <p className="mt-3">{a.proposal.summary}</p>
                      <p className="mt-2 text-sm text-muted-foreground">To {a.payee} · milestone {a.milestoneId.slice(0, 8)}</p>
                      <ReasonList codes={a.proposal.reasons} className="mt-3" />
                      {done[a.id] ? <p className="mt-4 text-sm font-medium">{done[a.id]}</p> : (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {a.movesNoMoney ? (
                            <button disabled={busy === a.id} onClick={() => decide(a, "new_plan")} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm text-on-dark disabled:opacity-40"><RefreshCw className="size-4" aria-hidden />Request a new plan</button>
                          ) : (
                            <button disabled={busy === a.id} onClick={() => decide(a, "approve")} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm text-on-dark disabled:opacity-40"><Check className="size-4" aria-hidden />Approve</button>
                          )}
                          <button disabled={busy === a.id} onClick={() => decide(a, "reject")} className="inline-flex min-h-11 items-center gap-2 rounded-full border px-5 text-sm hover:border-danger"><X className="size-4" aria-hidden />Reject</button>
                        </div>
                      )}
                      {a.movesNoMoney && !done[a.id] && <p className="mt-2 text-xs text-muted-foreground">This plan pays nobody, so it can't be approved. Ask the agent for a new plan, or reject it.</p>}
                    </Card></li>
                  ))}
                </ul>
              )}
            </Async>
          </div>
          <h2 className="mt-10 text-2xl">Audit log</h2>
          <div className="mt-4">
            <Async q={log} rows={2} empty={<p className="text-sm text-muted-foreground">No activity yet.</p>}>
              {(es) => <ol className="divide-y rounded-[var(--radius-card)] border bg-surface">{es.map((e) => <li key={e.id} className="flex flex-wrap gap-x-4 gap-y-1 p-4 text-sm"><span className="font-mono text-muted-foreground">{e.at}</span><span className="font-medium">{e.actor}</span><span className="flex-1 text-muted-foreground">{e.action}{e.reasons.length ? ` · ${e.reasons.join(", ")}` : ""}</span></li>)}</ol>}
            </Async>
          </div>
        </section>
      </div>
    </div>
  );
}
