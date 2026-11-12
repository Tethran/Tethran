import { Link } from "@tanstack/react-router";
import { EyeOff, FlaskConical, Tag } from "lucide-react";
import { Object3D } from "@/components/tethran/Object3D";
import { Reveal } from "@/components/tethran/Reveal";
import { pill } from "@/components/tethran/ui";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export const FAQ = [
  ["Is this real money?", "No. Tethran is a demo on test networks. Card payments run in a sandbox; conversion, identity checks, mobile-money and bank payouts are simulated and labelled."],
  ["Can the AI spend my money?", "No. The AI only proposes. A separate rules engine and an on-chain spending guard decide, and a human has the final say above the limits."],
  ["What if a client disputes?", "Two of three decide: client, provider and arbiter."],
  ["Who sees my data?", "Receipts store hashes only. No personal data goes on-chain."],
  ["Which payment methods work?", "Card, Apple Pay, Google Pay, PayPal, Cash App Pay (where supported) and stablecoin, in sandbox mode."],
  ["Which countries?", "Nigeria, Kenya, South Africa and Ghana first; more through configuration."],
] as const;

export function Trust() {
  return (
    <section className="section-pad bg-background">
      <div className="mx-auto grid max-w-[1200px] items-center gap-14 md:grid-cols-2">
        <Reveal className="relative">
          <div className="relative mx-auto aspect-square max-w-[440px] rounded-[var(--radius-sheet)] bg-surface shadow-float">
            <Object3D name="receipt" className="absolute inset-[10%]" depth={1.6} />
            <Link to="/receipt/$id" params={{ id: "r_01" }} className={pill({ variant: "ink", size: "plain", className: "absolute bottom-6 left-1/2 -translate-x-1/2" })}>Verify a receipt</Link>
          </div>
        </Reveal>
        <div>
          <Reveal><h2 className="display-section"><span className="weight-light">Receipts you</span> can check.</h2></Reveal>
          <ul className="mt-10 grid gap-5">
            {[[EyeOff, "Hashes only, no personal data"], [FlaskConical, "Runs on test networks"], [Tag, "Simulated parts are labelled"]].map(([I, t], k) => {
              const Icon = I as typeof EyeOff;
              return <Reveal key={t as string} delay={k * 120}><li className="flex items-center gap-4 text-xl"><span className="grid size-11 place-items-center rounded-full bg-ink text-lime"><Icon className="size-5" aria-hidden /></span>{t as string}</li></Reveal>;
            })}
          </ul>
          <p className="mt-8 text-sm text-muted-foreground">Built on Tether's WDK and USDT.</p>
        </div>
      </div>
      <div id="faq" className="mx-auto mt-28 max-w-[760px] scroll-mt-28">
        <h2 className="text-4xl md:text-5xl">Questions</h2>
        <Accordion type="single" collapsible className="mt-8">
          {FAQ.slice(0, 5).map(([q, a]) => (
            <AccordionItem key={q} value={q}>
              <AccordionTrigger className="min-h-14 text-left text-lg">{q}</AccordionTrigger>
              <AccordionContent className="max-w-[520px] text-base text-muted-foreground">{a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
