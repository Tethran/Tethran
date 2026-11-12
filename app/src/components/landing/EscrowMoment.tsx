import { Lock } from "lucide-react";
import { Object3D } from "@/components/tethran/Object3D";
import { cn } from "@/lib/utils";
import { useScrollProgress } from "./useScrollProgress";

export function EscrowMoment() {
  const [ref, p] = useScrollProgress<HTMLDivElement>(0.5);
  const rise = Math.min(1, p / 0.6);
  const locked = p > 0.62;
  return (
    <div ref={ref} className="relative h-[170vh]">
      <section className="dark sticky top-0 flex h-screen items-center overflow-hidden rounded-t-[var(--radius-sheet)] bg-ink text-on-dark">
        <div className="mx-auto grid w-full max-w-[1200px] items-center gap-8 px-5 md:grid-cols-[1.4fr_1fr]">
          <h2 className="display-giant">
            <span className="weight-light">Funds wait in escrow,</span> <span className="text-lime">not in hope.</span>
          </h2>
          <div className="relative mx-auto w-[70%] max-w-[380px] md:w-full" style={{ transform: `translateY(${(1 - rise) * 180}px) scale(${0.75 + rise * 0.25})`, opacity: 0.2 + rise * 0.8 }}>
            <Object3D name="vault" className="aspect-square w-full" depth={0.6} />
            <div className={cn("absolute -bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line-dark bg-ink-2 py-2 pr-5 pl-2 transition-all duration-500", locked ? "animate-lime-pulse" : "opacity-60")}>
              <span className={cn("grid size-9 place-items-center rounded-full transition-colors", locked ? "bg-lime text-lime-ink" : "bg-forest text-muted-dark")}><Lock className="size-4" aria-hidden /></span>
              <span className="font-mono text-lg tabular-nums">${Math.round(650 * Math.min(1, p / 0.62)).toLocaleString()}</span>
              <span className="text-sm text-muted-dark">{locked ? "Locked" : "Locking…"}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
