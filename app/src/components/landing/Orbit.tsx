import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion, useScrollProgress } from "./useScrollProgress";
import { OBJ, type ObjKey } from "@/lib/objects";
import { cn } from "@/lib/utils";

const ITEMS: { eyebrow: string; light: string; heavy: string; line: string; obj: ObjKey; card: [string, string]; badge: string; hue: string }[] = [
  { eyebrow: "Freelancer", light: "Deliver once.", heavy: "Get paid.", line: "Invoices, milestones and payouts to your phone.", obj: "invoice", card: ["Next payout", "$650 · phone"], badge: "Provider", hue: "var(--accent)" },
  { eyebrow: "Agency", light: "Split the work.", heavy: "Split the pay.", line: "One contract pays every subcontractor.", obj: "contract", card: ["Milestones", "3 of 5 funded"], badge: "Provider", hue: "var(--success)" },
  { eyebrow: "Client", light: "Pay safely,", heavy: "from anywhere.", line: "Card or wallet. Money waits until you approve.", obj: "card", card: ["Held for you", "$1,200 in escrow"], badge: "No account needed", hue: "var(--progress)" },
  { eyebrow: "Operator", light: "Set the rules.", heavy: "Sleep well.", line: "Limits and payees the AI can't break.", obj: "gate", card: ["Per payment", "Up to $1,000"], badge: "Admin", hue: "var(--agent)" },
  { eyebrow: "Arbiter", light: "Fair calls,", heavy: "two of three.", line: "Evidence and a neutral summary, then you decide.", obj: "scales", card: ["Open case", "Android build"], badge: "Dispute", hue: "var(--danger)" },
];

export function Orbit() {
  const reduce = useReducedMotion();
  const [ref, p] = useScrollProgress<HTMLDivElement>(0.4);
  const [manual, setManual] = useState(0);
  const n = ITEMS.length;
  const i = reduce ? manual : Math.min(n - 1, Math.floor(p * n * 0.9999));
  const prev = useRef(i);
  const dir = i >= prev.current ? 1 : -1;
  useEffect(() => { prev.current = i; }, [i]);
  const touch = useRef(0);
  const setI = (k: number) => {
    const t = Math.max(0, Math.min(n - 1, k));
    if (reduce) return setManual(t);
    const el = ref.current; if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + ((t + 0.5) / n) * (el.offsetHeight - window.innerHeight), behavior: "smooth" });
  };
  const go = (d: number) => setI(i + d);
  const s = ITEMS[i]!;
  return (
    <div ref={ref} className={reduce ? "" : "relative h-[420vh]"}>
    <section aria-roledescription="carousel" aria-label="Built for everyone in the deal" className={cn("dark overflow-hidden rounded-[var(--radius-sheet)] bg-ink text-on-dark", reduce ? "relative section-pad" : "sticky top-0 flex h-screen items-center px-5 py-20")}
      onKeyDown={(e) => { if (e.key === "ArrowRight") go(1); if (e.key === "ArrowLeft") go(-1); }} tabIndex={-1}
      onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)} onTouchEnd={(e) => { const dx = e.changedTouches[0]!.clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); }}>
      <div className="mx-auto w-full max-w-[1200px]">
        <h2 className="display-section"><span className="weight-light">Built for everyone</span> in the deal.</h2>
        <div className="relative mt-6 md:mt-10 grid items-center gap-10 md:grid-cols-[1fr_1.1fr]">
          <div key={i} className="relative z-10">
            <p className="font-mono text-xs uppercase tracking-[0.18em] animate-word" style={{ color: s.hue }}>{s.eyebrow}</p>
            <h3 className="mt-4 text-5xl md:text-6xl">
              <span className="block weight-light [clip-path:inset(0_0_0_0)] animate-word">{s.light}</span>
              <span className="block animate-word" style={{ animationDelay: "120ms" }}>{s.heavy}</span>
            </h3>
            <p className="mt-5 max-w-[32ch] text-lg text-muted-dark animate-word" style={{ animationDelay: "220ms" }}>{s.line}</p>
            <div className="mt-8 flex w-fit items-center gap-4 rounded-[var(--radius-card)] border border-line-dark bg-ink-2 p-4 animate-word" style={{ animationDelay: "320ms" }}>
              <span className="size-10 rounded-full" style={{ background: s.hue }} aria-hidden />
              <div><p className="text-xs text-muted-dark">{s.card[0]}</p><p className="font-mono">{s.card[1]}</p></div>
              <span className="ml-4 rounded-full border border-line-dark px-2.5 py-1 text-xs">{s.badge}</span>
            </div>
          </div>
          <div className="relative mx-auto aspect-square w-full max-w-[min(460px,48vh)]">
            <div className="absolute inset-[8%] rounded-full border-[18px] transition-[border-color] duration-700" style={{ borderColor: s.hue, opacity: 0.35 }} aria-hidden />
            <div className="absolute inset-[18%] rounded-full bg-ink-2" aria-hidden />
            {ITEMS.map((it, k) => {
              const off = k - i;
              const shown = off === 0;
              return (
                <div key={it.eyebrow} aria-hidden={!shown} className="absolute inset-0 transition-all duration-700 ease-in-out" style={{ transform: `rotate(${shown ? 0 : off > 0 ? 110 : -110}deg)`, opacity: shown ? 1 : 0, transformOrigin: "50% 160%" }}>
                  <img src={OBJ[it.obj].src} alt={shown ? OBJ[it.obj].alt : ""} className="h-full w-full animate-float object-contain p-[12%]" style={{ transform: `rotate(${shown ? 0 : off > 0 ? -110 : 110}deg)` }} loading="lazy" />
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-6 md:mt-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex gap-2">
            {ITEMS.map((it, k) => (
              <button key={it.eyebrow} onClick={() => setI(k)} aria-label={it.eyebrow} aria-current={k === i || undefined}
                className={cn("grid size-14 place-items-center rounded-2xl border transition-all", k === i ? "border-lime bg-ink-2" : "border-line-dark opacity-60 hover:opacity-100")}>
                <img src={OBJ[it.obj].src} alt="" className="size-10 object-contain" loading="lazy" />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-muted-dark">{String(i + 1).padStart(2, "0")} / {String(ITEMS.length).padStart(2, "0")}</span>
            <button onClick={() => go(-1)} disabled={i === 0} aria-label="Previous" className="grid size-12 place-items-center rounded-full disabled:opacity-30 border border-line-dark hover:bg-ink-2"><ChevronLeft className="size-5" /></button>
            <button onClick={() => go(1)} disabled={i === n - 1} aria-label="Next" className="grid size-12 place-items-center rounded-full bg-lime text-lime-ink disabled:opacity-30"><ChevronRight className="size-5" /></button>
          </div>
        </div>
      </div>
    </section>
    </div>
  );
}
