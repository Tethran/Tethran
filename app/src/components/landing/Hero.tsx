import { BadgeCheck, CheckCircle2, FileSignature, Lock } from "lucide-react";
import { Object3D } from "@/components/tethran/Object3D";
import { WordReveal } from "@/components/tethran/Reveal";
import { PillLink, pill } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";
import { Globe } from "./Globe";

function Chip({ icon: Icon, title, sub, className, delay }: { icon: typeof Lock; title: string; sub: string; className: string; delay: number }) {
  return (
    <div className={cn("glass absolute z-20 flex animate-drift items-center gap-3 rounded-2xl border border-line/70 py-2.5 pr-4 pl-2.5 shadow-float", className)} style={{ animationDelay: `${delay}s`, animationDuration: `${7 + delay}s` }}>
      <span className="grid size-9 place-items-center rounded-full bg-ink text-lime"><Icon className="size-4" aria-hidden /></span>
      <span className="leading-tight"><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{sub}</span></span>
    </div>
  );
}

export function Hero() {
  return (
    <section id="product" className="relative overflow-hidden px-5 pt-36 pb-20 md:pt-44 md:pb-32">
      <div className="mx-auto grid max-w-[1200px] items-center gap-12 grid-cols-1 lg:grid-cols-[1.1fr_1fr] *:min-w-0">
        <div className="relative z-10">
          <WordReveal text="Get paid for the work you deliver." heavyFrom={3} className="display-hero max-w-[11ch] text-ink" />
          <p className="mt-6 max-w-[30ch] text-lg text-muted-foreground animate-word" style={{ animationDelay: "1.4s" }}>
            Contracts that pay themselves, in dollars, to your phone.
          </p>
          <div className="mt-9 flex flex-wrap gap-3 animate-word" style={{ animationDelay: "1.6s" }}>
            <PillLink to="/app" variant="ink" size="lg">Try the demo</PillLink>
            <a href="#how" className={pill({ variant: "ghost", size: "plain" })}>See how it works</a>
          </div>
        </div>
        <div className="relative mx-auto aspect-square w-full max-w-[560px]">
          <Globe className="absolute inset-[6%]" />
          <Object3D name="invoice" className="absolute -bottom-2 left-[-4%] z-10 size-[46%]" depth={1.4} eager />
          <Object3D name="coin" className="absolute top-[4%] right-[2%] z-10 size-[22%]" depth={2} delay={1.2} decorative />
          <Chip icon={CheckCircle2} title="Payment received" sub="$650 · Brand guidelines" className="top-[10%] -left-[2%]" delay={0} />
          <Chip icon={Lock} title="Held in escrow" sub="Milestone 2 of 3" className="top-[46%] right-[-4%]" delay={1.5} />
          <Chip icon={BadgeCheck} title="Receipt minted" sub="Hashes only" className="right-[8%] bottom-[2%]" delay={3} />
          <Chip icon={FileSignature} title="Invoice signed" sub="TH-2026-0042" className="top-[30%] left-[-8%] hidden md:flex" delay={2.2} />
        </div>
      </div>
    </section>
  );
}
