import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { OBJ, type ObjKey } from "@/lib/objects";

/** A cut-out 3D object that floats, tilts toward the pointer and shifts with scroll. */
export function Object3D({ name, className, depth = 1, delay = 0, decorative = false, eager = false }: { name: ObjKey; className?: string; depth?: number; delay?: number; decorative?: boolean; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0, px = 0, py = 0;
    const apply = () => {
      const r = el.getBoundingClientRect();
      const sc = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
      el.style.transform = `perspective(900px) translate3d(${px * 14 * depth}px, ${py * 14 * depth + sc * -30 * depth}px, 0) rotateY(${px * 12}deg) rotateX(${-py * 10}deg) rotateZ(${sc * 6 * depth}deg)`;
    };
    const onMove = (e: PointerEvent) => { px = e.clientX / window.innerWidth - 0.5; py = e.clientY / window.innerHeight - 0.5; cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); };
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    apply();
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [depth]);
  const o = OBJ[name];
  return (
    <div ref={ref} className={cn("pointer-events-none select-none transition-transform duration-500 ease-out will-change-transform", className)}>
      <img src={o.src} alt={decorative ? "" : o.alt} aria-hidden={decorative || undefined} loading={eager ? "eager" : "lazy"} draggable={false}
        className="h-full w-full animate-float object-contain drop-shadow-[0_30px_40px_oklch(0.22_0.028_179.5/0.25)]" style={{ animationDelay: `${delay}s` }} />
    </div>
  );
}
