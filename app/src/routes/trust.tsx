import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, FlaskConical, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { Nav } from "@/components/landing/Nav";
import { Object3D } from "@/components/tethran/Object3D";
import { PillLink, SimTag } from "@/components/tethran/ui";

export const Route = createFileRoute("/trust")({
  head: () => ({
    meta: [
      { title: "Trust — What's real in Tethran" },
      { name: "description", content: "What is real, what is simulated, and how Tethran keeps an AI from spending your money." },
    ],
  }),
  component: TrustPage,
});

const REAL = ["Milestone escrow in USDT on a test network", "Spending limits enforced by the contract", "Receipts as non-transferable tokens (hashes only)", "The rules engine that approves or rejects proposals"];
const SIM = ["Card checkout", "Mobile-money and bank payouts"];
const LAYERS = [
  { icon: UserRound, t: "The AI proposes", d: "It reads evidence and suggests a split. It holds no keys." },
  { icon: CheckCircle2, t: "Rules decide", d: "A separate engine checks limits, payees and inputs." },
  { icon: ShieldCheck, t: "The guard enforces", d: "On-chain limits refuse anything outside the rules." },
  { icon: KeyRound, t: "A human signs", d: "Above the limits, nothing moves without a person." },
];

function TrustPage() {
  return (
    <main>
      <Nav />
      <section className="section-pad pt-40">
        <div className="mx-auto grid max-w-[1100px] items-center gap-10 md:grid-cols-[1.3fr_1fr]">
          <div>
            <h1 className="display-hero"><span className="weight-light">Nothing here</span> is hidden.</h1>
            <p className="mt-6 max-w-[40ch] text-lg text-muted-foreground">Tethran is a hackathon prototype on test networks. No real money moves.</p>
          </div>
          <Object3D name="gate" className="mx-auto size-64 md:size-80" />
        </div>
      </section>
      <section className="px-5 pb-24">
        <div className="mx-auto grid max-w-[1100px] gap-6 md:grid-cols-2">
          <div className="rounded-[var(--radius-sheet)] bg-surface p-8 shadow-soft">
            <h2 className="flex items-center gap-3 text-3xl"><CheckCircle2 className="size-7 text-success" aria-hidden />Real, on test networks</h2>
            <ul className="mt-6 grid gap-3">{REAL.map((r) => <li key={r} className="border-t pt-3">{r}</li>)}</ul>
          </div>
          <div className="dark rounded-[var(--radius-sheet)] bg-ink p-8 text-on-dark">
            <h2 className="flex items-center gap-3 text-3xl"><FlaskConical className="size-7 text-progress" aria-hidden />Simulated</h2>
            <ul className="mt-6 grid gap-3">{SIM.map((r) => <li key={r} className="flex items-center justify-between gap-3 border-t border-line-dark pt-3">{r}<SimTag className="text-muted-dark" /></li>)}</ul>
          </div>
        </div>
      </section>
      <section className="dark section-pad rounded-t-[var(--radius-sheet)] bg-ink text-on-dark">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="display-section"><span className="weight-light">Four locks</span> on every payment.</h2>
          <ol className="mt-12 grid gap-4 md:grid-cols-4">
            {LAYERS.map((l, k) => (
              <li key={l.t} className="rounded-[var(--radius-card)] border border-line-dark bg-ink-2 p-6">
                <span className="font-mono text-xs text-lime">0{k + 1}</span>
                <l.icon className="mt-4 size-6 text-lime" aria-hidden />
                <h3 className="mt-4 text-2xl">{l.t}</h3>
                <p className="mt-2 text-sm text-muted-dark">{l.d}</p>
              </li>
            ))}
          </ol>
          <div className="mt-14"><PillLink to="/app" variant="lime" size="lg">Open the app</PillLink></div>
        </div>
      </section>
    </main>
  );
}
