import { Link } from "@tanstack/react-router";
import { Object3D } from "@/components/tethran/Object3D";
import { Logo, PillLink } from "@/components/tethran/ui";

export function Closing() {
  return (
    <section className="dark relative overflow-hidden rounded-t-[var(--radius-sheet)] bg-ink text-on-dark">
      <div className="section-pad relative mx-auto max-w-[1200px] text-center">
        <Object3D name="vault" className="absolute top-10 -left-10 size-40 opacity-60 md:size-56" decorative depth={1.5} />
        <Object3D name="coin" className="absolute right-0 bottom-24 size-28 opacity-70 md:size-40" decorative depth={2} delay={1} />
        <h2 className="display-giant relative mx-auto max-w-[12ch]"><span className="weight-light">Start your first</span> <span className="text-lime">milestone.</span></h2>
        <div className="relative mt-10 flex justify-center"><PillLink to="/app" variant="lime" size="lg">Try the demo</PillLink></div>
      </div>
      <footer className="border-t border-line-dark">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-muted-dark">
          <Logo dark />
          <nav aria-label="Footer" className="flex flex-wrap gap-6">
            <a href="#" className="hover:text-on-dark">Docs</a>
            <Link to="/trust" className="hover:text-on-dark">Trust</Link>
            <a href="#" className="hover:text-on-dark">GitHub</a>
            <a href="#" className="hover:text-on-dark">Contact</a>
          </nav>
          <p>Demo on test networks. No real money moves.</p>
        </div>
      </footer>
    </section>
  );
}
