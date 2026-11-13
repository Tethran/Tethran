import { Link, useRouterState } from "@tanstack/react-router";
import { Gavel, Landmark, LayoutGrid, Settings, ShieldCheck, Table2, Users, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Logo, SimTag } from "@/components/tethran/ui";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/app/dashboard", label: "Home", icon: LayoutGrid },
  { to: "/app/wallet", label: "Wallet", icon: Wallet },
  { to: "/app/operator", label: "Operator", icon: ShieldCheck },
  { to: "/app/earnings", label: "Earnings", icon: Landmark },
  { to: "/app/arbiter", label: "Arbiter", icon: Gavel },
  { to: "/app/reconciliation", label: "Ledger", icon: Table2 },
  { to: "/app/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="min-h-screen bg-background pb-28 lg:pb-10">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-3"><Link to="/" aria-label="Tethran home"><Logo /></Link><SimTag label="Test network" className="text-muted-foreground" /></div>
          <nav aria-label="App" className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} className={cn("inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm", path.startsWith(n.to) ? "bg-ink text-on-dark" : "text-muted-foreground hover:text-ink")}>
                <n.icon className="size-4" aria-hidden />{n.label}
              </Link>
            ))}
          </nav>
          <Link to="/app" className="inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm hover:border-ink"><Users className="size-4" aria-hidden /><span className="hidden sm:inline">Switch role</span></Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 py-6 md:py-10">{children}</main>
      <nav aria-label="App" className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-full border bg-ink p-1 text-on-dark shadow-float lg:hidden">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={cn("flex min-h-12 flex-col items-center justify-center rounded-full text-[0.65rem]", path.startsWith(n.to) ? "bg-lime text-lime-ink" : "text-muted-dark")}>
            <n.icon className="size-4" aria-hidden />{n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHead({ eyebrow, title, light, children }: { eyebrow?: string; title: string; light?: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>}
        <h1 className="mt-2 text-4xl md:text-5xl">{light && <span className="weight-light">{light} </span>}{title}</h1>
      </div>
      {children}
    </div>
  );
}
