import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Anywhere } from "@/components/landing/Anywhere";
import { Closing } from "@/components/landing/Closing";
import { EscrowMoment } from "@/components/landing/EscrowMoment";
import { Hero } from "@/components/landing/Hero";
import { Nav } from "@/components/landing/Nav";
import { Orbit } from "@/components/landing/Orbit";
import { Overspend } from "@/components/landing/Overspend";
import { Story } from "@/components/landing/Story";
import { ThreeSteps } from "@/components/landing/ThreeSteps";
import { Ticker } from "@/components/landing/Ticker";
import { Trust } from "@/components/landing/Trust";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tethran — Get paid for the work you deliver" },
      { name: "description", content: "Contracts that pay themselves, in dollars, to your phone. Milestone escrow with an AI that proposes and rules that decide. Demo on test networks." },
    ],
  }),
  component: Landing,
});

function useLenis() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let stop = () => {};
    (async () => {
      const [{ default: Lenis }, { gsap }, { ScrollTrigger }] = await Promise.all([import("lenis"), import("gsap"), import("gsap/ScrollTrigger")]);
      gsap.registerPlugin(ScrollTrigger);
      const lenis = new Lenis({ lerp: 0.12 });
      lenis.on("scroll", ScrollTrigger.update);
      const tick = (t: number) => lenis.raf(t * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      stop = () => { gsap.ticker.remove(tick); lenis.destroy(); };
    })();
    return () => stop();
  }, []);
}

function Landing() {
  useLenis();
  return (
    <main className="overflow-x-clip">
      <Nav />
      <Hero />
      <Ticker />
      <EscrowMoment />
      <ThreeSteps />
      <Story />
      <Overspend />
      <Anywhere />
      <Orbit />
      <Trust />
      <Closing />
    </main>
  );
}
