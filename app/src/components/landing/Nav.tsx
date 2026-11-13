import { Link } from "@tanstack/react-router";
import { Logo, PillLink } from "@/components/tethran/ui";

export function Nav() {
  return (
    <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-3">
      <nav aria-label="Main" className="glass flex w-full max-w-3xl items-center justify-between gap-2 rounded-full border border-line/70 py-1.5 pr-1.5 pl-5 shadow-soft">
        <Link to="/" aria-label="Tethran home"><Logo /></Link>
        <div className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#product" className="hover:text-ink">Product</a>
          <a href="#how" className="hover:text-ink">How it works</a>
          <Link to="/trust" className="hover:text-ink">Trust</Link>
          <a href="#faq" className="hover:text-ink">FAQ</a>
        </div>
        <PillLink to="/app" variant="ink">Open the app</PillLink>
      </nav>
    </header>
  );
}
