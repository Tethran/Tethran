import { Building2, Smartphone, Wallet } from "lucide-react";
import { Object3D } from "@/components/tethran/Object3D";
import { Reveal, useInView } from "@/components/tethran/Reveal";
import { SimTag } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";

const DEST = [
  { icon: Smartphone, label: "Phone wallet", amount: "$400", obj: "wallet" as const },
  { icon: Building2, label: "Bank account", amount: "$150", obj: "bank" as const },
  { icon: Wallet, label: "Stablecoin wallet", amount: "$100", obj: "coin" as const },
];

export function Anywhere() {
  const [ref, v] = useInView<HTMLDivElement>(0.3);
  return (
    <section className="section-pad bg-background">
      <div className="mx-auto max-w-[1200px]">
        <Reveal className="flex flex-wrap items-end justify-between gap-6">
          <h2 className="display-section max-w-[12ch]"><span className="weight-light">Get paid</span> anywhere.</h2>
          <div className="text-right"><p className="text-lg text-muted-foreground">Send to a phone number.</p><SimTag className="mt-2 text-muted-foreground" label="Simulated in the demo" /></div>
        </Reveal>
        <div ref={ref} className="relative mt-14 grid gap-6 md:grid-cols-[1fr_1.6fr]">
          <div className="relative flex flex-col items-center justify-center rounded-[var(--radius-sheet)] bg-ink p-8 text-on-dark">
            <Object3D name="transfer" className="size-48 md:size-60" />
            <p className="mt-2 font-display text-5xl font-semibold tracking-[-0.05em]">$650</p>
            <p className="text-sm text-muted-dark">One payment</p>
          </div>
          <svg className="pointer-events-none absolute top-0 left-[38%] hidden h-full w-[8%] md:block" viewBox="0 0 100 300" preserveAspectRatio="none" aria-hidden>
            {[50, 150, 250].map((y, k) => (
              <path key={y} d={`M0 150 C 50 150, 50 ${y}, 100 ${y}`} fill="none" stroke="var(--accent)" strokeWidth="3" pathLength={1} strokeDasharray="1" strokeDashoffset={v ? 0 : 1} style={{ transition: `stroke-dashoffset 900ms ease-out ${k * 180}ms` }} />
            ))}
          </svg>
          <div className="grid gap-4">
            {DEST.map((d, k) => (
              <div key={d.label} className={cn("flex items-center gap-5 rounded-[var(--radius-card)] border bg-surface p-4 pr-6 shadow-soft transition-all duration-700", v ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0")} style={{ transitionDelay: `${400 + k * 180}ms` }}>
                <Object3D name={d.obj} className="size-20 shrink-0" decorative />
                <div className="flex-1"><p className="flex items-center gap-2 font-medium"><d.icon className="size-4 text-forest" aria-hidden />{d.label}</p><p className="text-sm text-muted-foreground">Arrives as local money</p></div>
                <span className="font-mono text-xl">{d.amount}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
