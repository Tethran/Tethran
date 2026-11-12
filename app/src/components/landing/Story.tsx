import { Object3D } from "@/components/tethran/Object3D";
import type { ObjKey } from "@/lib/objects";
import { cn } from "@/lib/utils";
import { useReducedMotion, useScrollProgress } from "./useScrollProgress";

const SCENES: { chapter: string; title: string; line: string; objs: ObjKey[] }[] = [
  { chapter: "Agree", title: "Evidence arrives.", line: "The work lands against the milestone you both signed.", objs: ["contract"] },
  { chapter: "Approve", title: "An AI proposes.", line: "It reads the evidence and suggests who gets what. It holds no keys.", objs: ["agent"] },
  { chapter: "Approve", title: "Rules decide.", line: "A separate rules engine checks limits and payees. Two keys, not one.", objs: ["gate"] },
  { chapter: "Fund", title: "The guard enforces.", line: "On-chain limits stop anything outside the rules. A human has the last word.", objs: ["guard"] },
  { chapter: "Deliver", title: "Money arrives.", line: "To a phone, a bank, or a wallet.", objs: ["wallet", "bank"] },
];

export function Story() {
  const reduce = useReducedMotion();
  const [ref, p] = useScrollProgress<HTMLDivElement>(0.8);
  const n = SCENES.length;
  const active = Math.min(n - 1, Math.floor(p * n * 0.9999));
  const jump = (k: number) => {
    const el = ref.current; if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + ((k + 0.5) / n) * (el.offsetHeight - window.innerHeight), behavior: "smooth" });
  };

  if (reduce) {
    return (
      <section className="dark bg-ink text-on-dark section-pad rounded-[var(--radius-sheet)]">
        <div className="mx-auto grid max-w-[1000px] gap-20">
          <h2 className="display-section"><span className="weight-light">An AI proposes.</span> <span className="text-lime">Rules decide.</span></h2>
          {SCENES.map((s) => (
            <div key={s.title} className="grid items-center gap-6 md:grid-cols-2">
              <div><p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-dark">{s.chapter}</p><h3 className="mt-3 text-4xl">{s.title}</h3><p className="mt-3 text-muted-dark">{s.line}</p></div>
              <div className="flex gap-4">{s.objs.map((o) => <Object3D key={o} name={o} className="size-48" />)}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div ref={ref} className="relative h-[380vh] md:h-[480vh]">
      <section aria-label="An AI proposes. Rules decide." className="dark sticky top-0 h-screen overflow-hidden rounded-[var(--radius-sheet)] bg-ink text-on-dark">
        {/* Ribbon */}
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden>
          <path d="M-20 480 C 180 380, 260 140, 420 220 S 680 520, 820 300 S 980 120, 1040 160" fill="none" stroke="var(--forest)" strokeWidth="2" />
          <path d="M-20 480 C 180 380, 260 140, 420 220 S 680 520, 820 300 S 980 120, 1040 160" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} style={{ filter: "drop-shadow(0 0 6px var(--accent))" }} />
        </svg>
        <div className="relative mx-auto flex h-full max-w-[1200px] flex-col justify-center px-5 pt-20 md:pt-0">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-dark">An AI proposes. Rules decide.</p>
          <div className="relative mt-6 grid min-h-[60vh] items-center md:grid-cols-[1fr_1fr]">
            {SCENES.map((s, k) => (
              <div key={s.title} aria-hidden={k !== active} className={cn("absolute inset-0 grid items-center gap-6 transition-all duration-500 ease-out md:grid-cols-[1fr_1fr]", k === active ? "translate-y-0 opacity-100" : k < active ? "-translate-y-10 opacity-0" : "translate-y-10 opacity-0")}>
                <div>
                  <p className="text-sm text-lime">{String(k + 1).padStart(2, "0")} · {s.chapter}</p>
                  <h2 className="display-section mt-3">{s.title}</h2>
                  <p className="mt-4 max-w-[34ch] text-lg text-muted-dark">{s.line}</p>
                </div>
                <div className="relative flex items-center justify-center gap-2">
                  {s.objs.map((o, j) => <Object3D key={o} name={o} depth={1 + j * 0.5} delay={j} className={cn(s.objs.length > 1 ? "size-40 md:size-64" : "size-56 md:size-[380px]", j === 1 && "mt-24")} />)}
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Rail */}
        <nav aria-label="Story scenes" className="absolute top-1/2 right-4 flex -translate-y-1/2 flex-col items-center gap-1 md:right-8">
          {SCENES.map((s, k) => (
            <button key={k} onClick={() => jump(k)} aria-label={`Scene ${k + 1}: ${s.title}`} aria-current={k === active || undefined} className="grid size-11 place-items-center">
              <span className={cn("block rounded-full transition-all duration-300", k === active ? "size-3.5 bg-lime" : k < active ? "size-2.5 bg-on-dark" : "size-2.5 bg-forest")} />
            </button>
          ))}
        </nav>
      </section>
    </div>
  );
}
