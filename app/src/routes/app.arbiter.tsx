import { createFileRoute } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError, DEMO_LABEL, type Via } from "@/api";
import { SignChoice, DemoNote } from "@/components/app/SignChoice";
import type { Dispute } from "@/api/types";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { Object3D } from "@/components/tethran/Object3D";
import { Amount, Card, StatusChip } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/arbiter")({
  head: () => ({ meta: [{ title: "Arbiter — Tethran" }, { name: "description", content: "Review a dispute and decide." }] }),
  component: Arbiter,
});

const PARTY = ["Client", "Provider", "Arbiter"];

function Case({ d, onDone }: { d: Dispute; onDone: () => void }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const vote = async (release: boolean, via: Via) => {
    setBusy(true);
    try {
      const r = await api.arbiterVote(d.milestoneId, release, via);
      const msg = (r.decided ? `Settled on-chain: ${r.outcome}.` : "Your vote is recorded. One more party with the same outcome settles the case.") + (via === "demo" ? ` ${DEMO_LABEL}.` : "");
      setResult(msg); toast.success(msg); onDone();
    } catch (e) { toast.error((e as ApiError).message); } finally { setBusy(false); }
  };
  const summarize = async () => {
    try {
      setSummary(await api.evidenceSummary(d.milestoneId));
    } catch (e) { toast.error((e as ApiError).message); }
  };
  return (
    <div className="grid gap-6 grid-cols-1 lg:grid-cols-[1.3fr_1fr] *:min-w-0">
      <div className="grid gap-4">
        <Card>
          <div className="flex items-center justify-between"><p className="font-medium">{d.title}</p><StatusChip status="Disputed" /></div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">Milestone {d.milestoneId}</p>
          <Amount value={d.amount} className="mt-6" />
          <p className="mt-2 text-sm text-muted-foreground">If nobody decides, the funds can return to the funder after {new Date(d.timeout * 1000).toLocaleString()}.</p>
        </Card>
        <Card>
          <h2 className="text-xl">Votes so far</h2>
          {d.attestations.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No votes yet. Two of client, provider and arbiter must agree.</p> : (
            <ul className="mt-3 grid gap-2 text-sm">{d.attestations.map((a) => (
              <li key={a.signer + a.at} className="flex justify-between"><span>{PARTY[a.kind] ?? "Party"} <span className="font-mono text-xs text-muted-foreground">{a.signer.slice(0, 10)}…</span></span><span>{a.releaseToProvider ? "Release to provider" : "Refund client"}</span></li>
            ))}</ul>
          )}
        </Card>
        <Card className="border-agent/30">
          <p className="flex items-center gap-2 text-sm text-agent"><Sparkles className="size-4" aria-hidden />Neutral AI summary</p>
          {summary ? <p className="mt-2 whitespace-pre-line">{summary}</p> : <button onClick={summarize} className="mt-2 min-h-11 rounded-full border px-4 text-sm hover:border-ink">Summarise the evidence</button>}
          <p className="mt-2 text-xs text-muted-foreground">Advisory only. It never decides a dispute. You decide.</p>
        </Card>
      </div>
      <div className="dark rounded-[var(--radius-sheet)] bg-ink p-6 text-on-dark">
        <Object3D name="scales" className="mx-auto size-44" decorative />
        {result ? (
          <div className="mt-4 text-center animate-stamp"><p className="inline-block rounded-xl border-2 border-lime px-4 py-2 font-display text-xl text-lime">{result}</p></div>
        ) : (
          <div className="mt-6 grid gap-3">
            <SignChoice label="Release to provider" tone="lime" busy={busy} onSign={(via) => vote(true, via)} />
            <SignChoice label="Refund client" tone="danger" busy={busy} onSign={(via) => vote(false, via)} />
            <p className="text-center text-xs text-muted-dark">Signed by the arbiter. The escrow checks the signatures itself.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Arbiter() {
  const q = useApi(["disputes"], api.listDisputes);
  return (
    <div>
      <PageHead eyebrow="Two of three decide" light="Make a" title="fair call." />
      
      <Async q={q} rows={3} empty={<EmptyBlock obj="scales" title="No open disputes." />}>
        {(ds) => <div className="grid gap-10">{ds.map((d) => <Case key={d.milestoneId} d={d} onDone={() => q.refetch()} />)}</div>}
      </Async>
    </div>
  );
}
