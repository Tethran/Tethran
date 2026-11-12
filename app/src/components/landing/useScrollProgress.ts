import { useEffect, useRef, useState } from "react";

/** 0..1 progress of a tall wrapper scrolling past a sticky stage. Uses GSAP ScrollTrigger with smoothing. */
export function useScrollProgress<T extends HTMLElement>(scrub: number | boolean = 0.6) {
  const ref = useRef<T>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let kill = () => {};
    (async () => {
      const { gsap } = await import("gsap");
      const { ScrollTrigger } = await import("gsap/ScrollTrigger");
      gsap.registerPlugin(ScrollTrigger);
      const o = { v: 0 };
      const tween = gsap.to(o, { v: 1, ease: "none", onUpdate: () => setP(o.v), scrollTrigger: { trigger: el, start: "top top", end: "bottom bottom", scrub } });
      kill = () => { tween.scrollTrigger?.kill(); tween.kill(); };
    })();
    return () => kill();
  }, [scrub]);
  return [ref, p] as const;
}

export function useReducedMotion() {
  const [r, set] = useState(false);
  useEffect(() => { const m = window.matchMedia("(prefers-reduced-motion: reduce)"); set(m.matches); const f = () => set(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  return r;
}
