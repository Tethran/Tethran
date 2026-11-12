import { cn } from "@/lib/utils";

const A = ["Logo design", "$400", "Mobile app", "Video edit", "$1,200", "Translation", "Site audit", "$650", "Podcast mix", "Pitch deck", "$300", "Copywriting"];
const B = ["$2,400", "UX research", "Illustration", "$180", "Data cleanup", "Brand guide", "$950", "Motion intro", "Landing page", "$520", "3D renders", "Voice-over"];

function Row({ items, reverse }: { items: string[]; reverse?: boolean }) {
  const all = [...items, ...items];
  return (
    <div className="flex w-max animate-marquee gap-3" style={{ animationDirection: reverse ? "reverse" : "normal" }}>
      {all.map((t, i) => {
        const money = t.startsWith("$");
        const hi = i % 5 === 2;
        return (
          <span key={i} aria-hidden={i >= items.length || undefined}
            className={cn("rounded-full border px-6 py-3 font-display text-xl tracking-[-0.03em] whitespace-nowrap md:text-2xl",
              money ? "border-ink bg-ink font-mono text-lg text-lime md:text-xl" : hi ? "bg-surface shadow-soft" : "border-line text-muted-foreground")}>
            {t}
          </span>
        );
      })}
    </div>
  );
}

export function Ticker() {
  return (
    <section aria-label="Example milestones" className="pause-hover relative overflow-hidden py-10 [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
      <div className="grid gap-3"><Row items={A} /><Row items={B} reverse /></div>
    </section>
  );
}
