import { CheckCircle2, FileEdit, Lock, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Reveal } from "@/components/tethran/Reveal";
import { SimTag, StatusChip, Ticket } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";
import type { MilestoneStatus } from "@/api/types";

const STEPS: { key: string; label: string; status: MilestoneStatus; line: string; icon: typeof Lock; amount: number }[] = [
  { key: "agree", label: "Agree", status: "Draft", line: "Three milestones, one signature.", icon: FileEdit, amount: 0 },
  { key: "fund", label: "Fund", status: "Funded", line: "Client pays by card. Money locks.", icon: Lock, amount: 650 },
  { key: "paid", label: "Get paid", status: "Paid out", line: "Approved. Sent to your phone.", icon: Send, amount: 650 },
];

function CountUp({ to }: { to: number }) {
  const [v, set] = useState(0);
  useEffect(() => { let raf = 0; const t0 = performance.now(); const from = v; const tick = (t: number) => { const k = Math.min(1, (t - t0) / 600); set(Math.round(from + (to - from) * (1 - (1 - k) ** 3))); if (k < 1) raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [to]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>{"$" + v.toLocaleString()}</>;
}

export function ThreeSteps() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => { if (paused) return; const t = setInterval(() => setI((x) => (x + 1) % 3), 3200); return () => clearInterval(t); }, [paused]);
  const s = STEPS[i]!;
  return (
    <section id="how" className="section-pad -mt-[var(--radius-sheet)] relative z-10 rounded-[var(--radius-sheet)] bg-background">
      <div className="mx-auto max-w-[1100px]">
        <Reveal><h2 className="display-section text-center"><span className="weight-light">Agree.</span> <span className="weight-light">Fund.</span> Get paid.</h2></Reveal>
        <div role="tablist" aria-label="Steps" className="mx-auto mt-10 flex w-fit gap-1 rounded-full border bg-surface p-1">
          {STEPS.map((st, k) => (
            <button key={st.key} role="tab" aria-selected={k === i} onClick={() => { setI(k); setPaused(true); }}
              className={cn("min-h-11 rounded-full px-5 text-sm font-medium transition-colors", k === i ? "bg-ink text-on-dark" : "text-muted-foreground hover:text-ink")}>
              {k + 1}. {st.label}
            </button>
          ))}
        </div>
        <Reveal delay={150} className="mt-10">
          <Ticket
            main={
              <div key={s.key} className="animate-word">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Contract · Brand guidelines</p>
                  <StatusChip status={s.status} />
                </div>
                <p className="mt-8 font-display text-6xl font-semibold tracking-[-0.05em] tabular-nums md:text-7xl"><CountUp to={s.amount || 650} /></p>
                <p className="mt-1 text-sm text-muted-foreground">Fee: $6.50 · paid by client</p>
                <p className="mt-6 flex items-center gap-2 text-lg"><s.icon className="size-5 text-forest" aria-hidden />{s.line}</p>
                <div className="mt-6 flex gap-2">
                  {STEPS.map((_, k) => <span key={k} className={cn("h-1.5 flex-1 rounded-full transition-colors duration-500", k <= i ? "bg-ink" : "bg-line")} />)}
                </div>
              </div>
            }
            stub={
              <div className="flex h-full flex-col items-center justify-between gap-4 text-center">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-dark">Pay link</p>
                <QR />
                {i === 2 ? <span className="flex items-center gap-2 text-sm text-lime"><CheckCircle2 className="size-4" aria-hidden />Paid out <SimTag className="text-muted-dark" /></span> : <span className="text-sm text-muted-dark">TH-2026-0042</span>}
              </div>
            }
          />
        </Reveal>
      </div>
    </section>
  );
}

export function QR({ className }: { className?: string }) {
  // Decorative pattern, not a scannable code.
  const cells = Array.from({ length: 121 }, (_, k) => { const x = k % 11, y = Math.floor(k / 11); const corner = (x < 3 && y < 3) || (x > 7 && y < 3) || (x < 3 && y > 7); return corner || ((x * 7 + y * 13 + x * y) % 3 === 0); });
  return (
    <div className={cn("grid size-32 grid-cols-11 gap-[2px] rounded-xl bg-on-dark p-2.5", className)} aria-hidden>
      {cells.map((on, k) => <span key={k} className={cn("rounded-[1px]", on ? "bg-ink" : "bg-transparent")} />)}
    </div>
  );
}
