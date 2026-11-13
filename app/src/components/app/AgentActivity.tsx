// The agent's activity for one milestone, built only from the records: what it was given (the milestone, its criteria,
// the delivery and its files), its per-criterion check, the payouts it proposed with its confidence, and then the
// Policy Service's decision and the two signatures the vault requires on every transfer. Nothing here is invented:
// each line maps to a stored field. The lines appear one after another the first time the panel mounts.
import { useEffect, useState, type ReactNode } from "react";
import { Check, FileText, ListChecks, PenLine, ShieldCheck, Sparkles } from "lucide-react";
import type { Proposal } from "@/api/types";
import { Card, ReasonList, usd } from "@/components/tethran/ui";

type Evidence = { note?: string | null; link?: string | null; files: { name: string }[] };
type CheckItem = { criterion: string; status: "met" | "unmet" | "unclear" };

export interface AgentActivityProps {
  title: string;
  amount: number;
  criteria: string;
  evidence: Evidence[];
  checks: CheckItem[];
  proposal: Proposal;
}

/** The rules the Policy Service runs on a proposal that moves money (services/policy/src/engine.ts, in order). */
const RULES = [
  "Schema valid", "Milestone matches", "Not settled before", "Escrow released", "No hold", "Payee on the allowlist",
  "Per-payment cap", "Daily cap", "Vault reserve", "Within the milestone amount", "Platform fee 5%", "Tax reserve",
];

/** When each proposal was first shown: the 2-second refresh can remount the panel, and the reveal must not restart. */
const firstSeen = new Map<string, number>();
function useReveal(key: string, count: number, stepMs = 650) {
  if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
  const shownAt = () => Math.min(count, Math.floor((Date.now() - firstSeen.get(key)! + stepMs - 150) / stepMs));
  const [shown, setShown] = useState(shownAt);
  useEffect(() => {
    if (shown >= count) return;
    const t = setTimeout(() => setShown(shownAt()), 120);
    return () => clearTimeout(t);
  });
  return shown;
}

export function AgentActivity({ title, amount, criteria, evidence, checks, proposal, modeTag }: AgentActivityProps & { modeTag?: ReactNode }) {
  const files = evidence.flatMap((e) => e.files.map((f) => f.name));
  const notes = evidence.filter((e) => e.note || e.link).length;
  const criteriaCount = criteria.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).length || 1;
  const met = checks.filter((c) => c.status === "met").length;
  const lines = [
    { icon: FileText, label: "Read the milestone", detail: `${title}, ${usd(amount)}, ${criteriaCount} acceptance ${criteriaCount === 1 ? "criterion" : "criteria"}` },
    { icon: FileText, label: "Read the delivery", detail: [notes ? `${notes} note${notes === 1 ? "" : "s"} and link` : null, files.length ? `file${files.length === 1 ? "" : "s"}: ${files.join(", ")}` : null].filter(Boolean).join("; ") || "nothing submitted" },
    { icon: ListChecks, label: "Checked each criterion", detail: checks.length ? `${met} of ${checks.length} met` : "no check recorded" },
    { icon: Sparkles, label: "Proposed the payout", detail: "" },
  ];
  const shown = useReveal(proposal.id, lines.length + 1);
  const conf = proposal.confidence;
  return (
    <div data-testid="agent-activity"><Card className="border-agent/30">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-agent"><Sparkles className="size-4" aria-hidden />AI activity</p>
        {modeTag}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">The agent only proposes. It holds no key that can pay; the Policy Service decides.</p>
      <ol className="mt-3 grid gap-2">
        {lines.map((l, k) => (
          <li key={l.label} className={`flex gap-3 text-sm transition-opacity duration-300 ${k < shown ? "opacity-100" : "opacity-0"}`}>
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-agent/15 text-agent"><l.icon className="size-3" aria-hidden /></span>
            <span className="min-w-0"><span className="font-medium">{l.label}</span>{l.detail && <span className="block break-words text-muted-foreground">{l.detail}</span>}</span>
          </li>
        ))}
      </ol>
      <div data-testid="agent-proposal" className={`mt-3 rounded-[var(--radius-input)] border p-3 transition-opacity duration-300 ${shown > lines.length - 1 ? "opacity-100" : "opacity-0"}`}>
        <ul className="grid gap-1 text-sm">
          {proposal.payouts.map((p, k) => (
            <li key={k} className="flex justify-between gap-3"><span>{p.to}</span><span className="font-mono">{usd(p.amount)}</span></li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">The rest of the milestone stays in the vault as the tax reserve.</p>
        {conf !== null && <p className="mt-2 text-sm" data-testid="agent-confidence">Confidence <span className="font-mono font-semibold">{Math.round(conf * 100)}%</span></p>}
      </div>
    </Card></div>
  );
}

/** The Policy Service's decision and the two signatures on each transfer (vault: agentSigner + policySigner, 2 of 2). */
export function PolicySignatures({ proposal, paidTxs }: { proposal: Proposal; paidTxs: string[] }) {
  if (proposal.decision !== "APPROVED") return null;
  return (
    <div data-testid="policy-signatures"><Card>
      <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" aria-hidden />Policy Service: approved</p>
      {proposal.reasons.length > 0 && <ReasonList codes={proposal.reasons} className="mt-2" />}
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {RULES.map((r) => <li key={r} className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success"><Check className="size-3" aria-hidden />{r}</li>)}
      </ul>
      <p className="mt-4 flex items-center gap-2 text-sm font-medium"><PenLine className="size-4" aria-hidden />Two signatures on every transfer</p>
      <ol className="mt-2 grid gap-1 text-sm">
        <li className="flex items-center gap-2"><Check className="size-4 text-success" aria-hidden />1. Agent signer (signs the proposal hash)</li>
        <li className="flex items-center gap-2"><Check className="size-4 text-success" aria-hidden />2. Policy Service (co-signs after every rule passed)</li>
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">The vault contract checks both signatures (two of two) and its own limits before it pays.{paidTxs.length > 0 && <> Paid in {paidTxs.length} transfer{paidTxs.length === 1 ? "" : "s"}: <span className="font-mono">{paidTxs.map((t) => t.slice(0, 10) + "…").join(", ")}</span></>}</p>
    </Card></div>
  );
}
