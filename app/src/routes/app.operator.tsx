import { createFileRoute } from "@tanstack/react-router";
import { Ban, CheckCircle2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, DEMO_LABEL, reasonInfo, type Via } from "@/api";
import type { ApprovalItem } from "@/api/types";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { DemoSigned, SignChoice, useDemoSigner, DemoNote } from "@/components/app/SignChoice";
import { Card, DecisionChip, ReasonList, SimTag, usd } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/operator")({
  head: () => ({ meta: [{ title: "Operator console — Tethran" }, { name: "description", content: "Limits, approval queue and audit log." }] }),
  component: Operator,
});

const fail = (e: unknown) => toast.error((e as ApiError)?.message ?? "Something went wrong.");
const signedNote = (via: Via) => (via === "demo" ? ` (${DEMO_LABEL})` : "");

function Limits() {
  const lim = useApi(["limits"], api.getLimits);
  const provider = useApi(["provider"], api.provider);
  const demo = useDemoSigner();
  const [cap, setCap] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState<{ txs: string[]; via: Via } | null>(null);
  const [testUsd, setTestUsd] = useState("6");
  const [check, setCheck] = useState<{ ok: boolean; reason: string; perTxCap: number; amount: number } | null>(null);
  useEffect(() => { if (lim.data && cap === "") setCap(String(lim.data.perPayment)); }, [lim.data, cap]);
  const firstPayee = provider.data?.payees[0];

  const change = async () => {
    setBusy(true);
    try {
      const r = await api.setLimits({ perPayment: Number(cap) });
      setChanged({ txs: r.vault_transactions.map((t) => t.tx), via: "demo" });
      toast.success(`Limit changed. The vault enforces ${usd(Number(cap))} per payment now.`, { description: DEMO_LABEL });
      setCheck(null);
      await lim.refetch();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const test = async () => {
    if (!firstPayee) return;
    try {
      const amount = Number(testUsd);
      const r = await api.vaultCheck(firstPayee.payee_id, amount);
      setCheck({ ...r, amount });
    } catch (e) { fail(e); }
  };

  return (
    <Card>
      <h2 className="text-2xl">Limits</h2>
      <Async q={lim} rows={2} empty={<p className="mt-3 text-sm text-muted-foreground">No limits set. Nothing can be sent until you add one.</p>}>
        {(l) => (
          <div className="mt-5 grid gap-4 text-sm">
            <dl className="grid gap-3">
              <div className="flex justify-between"><dt>The AI can send up to, per payment</dt><dd className="font-mono" data-testid="per-tx-cap">{usd(l.perPayment)}</dd></div>
              <div className="flex justify-between"><dt>A person confirms payments above</dt><dd className="font-mono">{usd(l.softLimit)}</dd></div>
              <div className="flex justify-between"><dt>And no more than, per day</dt><dd className="font-mono">{usd(l.daily)}</dd></div>
              <div className="flex justify-between"><dt>Set aside for tax, at least</dt><dd className="font-mono">{l.taxReservePercent}%</dd></div>
              <div className="flex justify-between"><dt>Escalate when the AI's confidence is under</dt><dd className="font-mono">{l.confidenceThreshold}</dd></div>
              <div>Only to these people<ul className="mt-2 flex flex-wrap gap-2">{l.approvedPayees.map((p) => <li key={p} className="rounded-full bg-muted px-3 py-1">{p}</li>)}</ul></div>
            </dl>
            {demo ? (
              <div className="grid gap-2 rounded-[var(--radius-input)] border p-4">
                <label className="grid gap-1.5">New per-payment limit
                  <span className="flex items-center gap-2 font-mono">$<input aria-label="New per-payment limit" type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} className="h-11 w-full rounded-[var(--radius-input)] border bg-background px-3" /></span>
                </label>
                <button data-testid="change-limit" disabled={busy || !(Number(cap) > 0)} onClick={change} className="min-h-11 rounded-full bg-ink px-5 text-on-dark disabled:opacity-40">{busy ? "Signing and relaying to the vault…" : "Change limit"}</button>
                <p className="text-xs text-muted-foreground">Signs the policy and the vault update with the operator's test key ({DEMO_LABEL.toLowerCase()}). The Policy Service checks both signatures and relays the vault update on-chain.</p>
                {changed && <p className="text-xs"><DemoSigned via={changed.via} /> {changed.txs.length > 0 && <span className="font-mono">vault update {changed.txs[0]!.slice(0, 14)}…</span>}</p>}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Policy version {l.version}. Changing the limits takes the operator's signature on the policy and on the vault update.</p>
            )}
            <div className="grid gap-2 rounded-[var(--radius-input)] bg-muted p-4">
              <p className="font-medium">Would the vault pay this?</p>
              <div className="flex items-center gap-2 font-mono">$<input aria-label="Test payout amount" type="number" min={1} value={testUsd} onChange={(e) => setTestUsd(e.target.value)} className="h-11 w-28 rounded-[var(--radius-input)] border bg-background px-3" />
                <button data-testid="vault-check" onClick={test} disabled={!firstPayee} className="min-h-11 rounded-full border bg-surface px-4 font-sans hover:border-ink">Ask the vault</button>
              </div>
              {firstPayee && <p className="text-xs text-muted-foreground">To {firstPayee.name}. The vault contract answers with the same rule it applies to every payout.</p>}
              {check && (check.ok ? (
                <p data-testid="vault-check-result" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-success" aria-hidden />The vault would pay {usd(check.amount)} (cap {usd(check.perTxCap)}).</p>
              ) : (
                <p data-testid="vault-check-result" className="flex items-start gap-2 text-sm"><Ban className="mt-0.5 size-4 text-danger" aria-hidden /><span><span className="font-medium">Refused by the vault, on-chain:</span> {reasonInfo(check.reason).title}. {reasonInfo(check.reason).plain} <span className="font-mono text-xs">{check.reason}</span> (cap {usd(check.perTxCap)})</span></p>
              ))}
            </div>
          </div>
        )}
      </Async>
    </Card>
  );
}

function Approval({ a, onDone }: { a: ApprovalItem; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ msg: string; via: Via } | null>(null);
  const decide = async (decision: "approve" | "reject" | "new_plan", via: Via) => {
    setBusy(true);
    try {
      const r = await api.decideApproval(a, decision, via);
      const msg = r.decision === "approved" ? "Approved. The vault paid out within its limits."
        : r.decision === "new_plan_requested" ? "New plan requested. Nothing was paid; the milestone waits for a new settlement."
        : "Rejected. Nothing was paid.";
      setDone({ msg, via }); toast.success(msg + signedNote(via)); onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2"><DecisionChip decision={a.proposal.decision} /><span className="font-display text-3xl font-semibold tracking-[-0.04em]">{usd(a.amount)}</span></div>
      <p className="mt-3">{a.proposal.summary}</p>
      <p className="mt-2 text-sm text-muted-foreground">{a.payee ? `To ${a.payee}` : "Pays no one"} · milestone {a.milestoneId.slice(0, 8)}</p>
      <ReasonList codes={a.proposal.reasons} className="mt-3" />
      {done ? <p className="mt-4 text-sm font-medium">{done.msg} <DemoSigned via={done.via} /></p> : (
        <div className="mt-4 grid gap-3">
          {a.movesNoMoney
            ? <SignChoice label="Request a new plan" busy={busy} onSign={(via) => decide("new_plan", via)} />
            : <SignChoice label="Approve" busy={busy} onSign={(via) => decide("approve", via)} />}
          <SignChoice label="Reject" tone="danger" busy={busy} onSign={(via) => decide("reject", via)} />
          {a.movesNoMoney && <p className="text-xs text-muted-foreground">This plan pays nobody, so it can't be approved. Ask the agent for a new plan, or reject it.</p>}
        </div>
      )}
    </Card>
  );
}

function Operator() {
  const queue = useApi(["approvals"], api.listApprovals);
  const holds = useApi(["identity-holds"], api.listIdentityHolds);
  const log = useApi(["audit"], api.listAudit);
  const [busy, setBusy] = useState<string | null>(null);
  const decideHold = async (milestoneId: string, decision: "release" | "hold", via: Via) => {
    setBusy(milestoneId);
    try {
      await api.decideIdentity(milestoneId, decision, via);
      toast.success((decision === "release" ? "Released to the provider's vault." : "Kept on hold.") + signedNote(via));
      holds.refetch();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <div>
      <PageHead eyebrow="Operator" light="Rules the AI" title="can't break." />
      
      <div className="grid gap-8 grid-cols-1 lg:grid-cols-[1fr_1.4fr] *:min-w-0">
        <div className="grid content-start gap-8">
          <Limits />
          <Card>
            <div className="flex items-center justify-between"><h2 className="text-2xl">Identity holds</h2></div>
            <div className="mt-4">
              <Async q={holds} rows={1} empty={<p className="text-sm text-muted-foreground">No releases on hold.</p>}>
                {(hs) => (
                  <ul className="grid gap-3">{hs.map((h) => (
                    <li key={h.milestoneId} className="rounded-[var(--radius-input)] border p-4 text-sm">
                      <p className="font-medium">Milestone {h.milestoneId.slice(0, 8)}</p>
                      <p className="mt-1 text-muted-foreground">{h.reason}</p>
                      <div className="mt-3 grid gap-2">
                        <SignChoice label="Release" busy={busy === h.milestoneId} onSign={(via) => decideHold(h.milestoneId, "release", via)} />
                        <SignChoice label="Keep on hold" tone="danger" busy={busy === h.milestoneId} onSign={(via) => decideHold(h.milestoneId, "hold", via)} />
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
          <p className="mt-1 flex items-start gap-2 text-sm text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />Each decision is signed by the operator. The Policy Service checks the signature, runs the rules again and only then co-signs.</p>
          <div className="mt-4">
            <Async q={queue} empty={<EmptyBlock obj="gate" title="Nothing waiting. The rules handled everything." />}>
              {(items) => <ul className="grid gap-4">{items.map((a) => <li key={a.id}><Approval a={a} onDone={() => { queue.refetch(); log.refetch(); }} /></li>)}</ul>}
            </Async>
          </div>
          <h2 className="mt-10 text-2xl">Audit log</h2>
          <div className="mt-4">
            <Async q={log} rows={2} empty={<p className="text-sm text-muted-foreground">No activity yet.</p>}>
              {(es) => <ol className="divide-y rounded-[var(--radius-card)] border bg-surface">{es.slice(0, 12).map((e) => <li key={e.id} className="flex flex-wrap gap-x-4 gap-y-1 p-4 text-sm"><span className="font-mono text-muted-foreground">{e.at}</span><span className="font-medium">{e.actor}</span><span className="min-w-0 flex-1 text-muted-foreground">{e.action}{e.reasons.length ? ` · ${e.reasons.join(", ")}` : ""}</span></li>)}</ol>}
            </Async>
          </div>
        </section>
      </div>
    </div>
  );
}
