import { Link, type LinkProps } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import {
  ArrowUpRight, Ban, CheckCircle2, ChevronDown, CircleDashed, FileEdit, Gavel, Lock, RotateCcw, Search, Send, type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { reasonInfo } from "@/api/reasons";
import type { MilestoneStatus } from "@/api/types";

export const pill = cva(
  "group inline-flex min-h-11 items-center gap-3 rounded-full font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2",
  {
    variants: {
      variant: {
        ink: "bg-ink text-on-dark hover:bg-forest",
        lime: "bg-lime text-lime-ink hover:brightness-95",
        ghost: "border border-line bg-surface text-ink hover:border-ink",
        ghostDark: "border border-line-dark text-on-dark hover:bg-ink-2",
        danger: "bg-danger text-on-dark hover:brightness-95",
      },
      size: { md: "py-2 pl-5 pr-2 text-[0.95rem]", lg: "py-2.5 pl-6 pr-2.5 text-base", plain: "px-5 py-2.5 text-[0.95rem]" },
    },
    defaultVariants: { variant: "ink", size: "md" },
  },
);
type PillVariant = VariantProps<typeof pill>;

function ArrowChip({ variant }: { variant: PillVariant["variant"] }) {
  const chip = variant === "lime" ? "bg-lime-ink text-lime" : variant === "ink" ? "bg-lime text-lime-ink" : variant === "danger" ? "bg-on-dark text-danger" : "bg-ink text-on-dark";
  return (
    <span className={cn("grid size-8 place-items-center rounded-full transition-transform duration-200 group-hover:rotate-45", chip)} aria-hidden>
      <ArrowUpRight className="size-4" />
    </span>
  );
}

export function PillButton({ variant, size, arrow = true, className, children, ...rest }: PillVariant & { arrow?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cn(pill({ variant, size: arrow ? size : "plain" }), className)} {...rest}>
      {children}
      {arrow && <ArrowChip variant={variant} />}
    </button>
  );
}

export function PillLink({ variant, size, arrow = true, className, children, ...rest }: PillVariant & { arrow?: boolean; className?: string; children: ReactNode } & LinkProps) {
  return (
    <Link className={cn(pill({ variant, size: arrow ? size : "plain" }), className)} {...rest}>
      {children}
      {arrow && <ArrowChip variant={variant} />}
    </Link>
  );
}

const STATUS: Record<MilestoneStatus, { icon: LucideIcon; cls: string }> = {
  Draft: { icon: FileEdit, cls: "bg-muted text-muted-foreground" },
  Funded: { icon: Lock, cls: "bg-progress/15 text-ink border-progress/40" },
  "In review": { icon: Search, cls: "bg-agent/10 text-ink border-agent/40" },
  Approved: { icon: CheckCircle2, cls: "bg-success/12 text-ink border-success/40" },
  Released: { icon: Lock, cls: "bg-success/12 text-ink border-success/40" },
  Disputed: { icon: Gavel, cls: "bg-danger/10 text-ink border-danger/40" },
  "Paid out": { icon: Send, cls: "bg-lime text-lime-ink border-lime" },
  Refunded: { icon: RotateCcw, cls: "bg-muted text-ink" },
};
export function StatusChip({ status }: { status: MilestoneStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs font-medium whitespace-nowrap", s.cls)}>
      <Icon className="size-3.5" aria-hidden />
      {status}
    </span>
  );
}

export function DecisionChip({ decision }: { decision: "APPROVED" | "REJECTED" | "ESCALATED" }) {
  const map = {
    APPROVED: { icon: CheckCircle2, label: "Approved", cls: "bg-success/12 border-success/40" },
    REJECTED: { icon: Ban, label: "Rejected", cls: "bg-danger/10 border-danger/40" },
    ESCALATED: { icon: CircleDashed, label: "Escalated to a human", cls: "bg-progress/15 border-progress/40" },
  }[decision];
  const Icon = map.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-foreground", map.cls)}>
      <Icon className="size-3.5" aria-hidden /> {map.label}
    </span>
  );
}

export function SimTag({ label = "Simulated", className }: { label?: "Simulated" | "Demo" | string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border border-dashed border-current/40 px-2 py-0.5 font-mono text-[0.68rem] uppercase tracking-wider opacity-80", className)}>
      <span className="size-1.5 rounded-full bg-progress" aria-hidden />
      {label}
    </span>
  );
}

export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n % 1 ? 2 : 0 });

export function Amount({ value, fee, unit = "USDT", size = "lg", className }: { value: number; fee?: number; unit?: string; size?: "md" | "lg" | "xl"; className?: string }) {
  const sz = { md: "text-3xl", lg: "text-5xl", xl: "text-6xl md:text-7xl" }[size];
  return (
    <div className={className}>
      <div className="flex items-baseline gap-2">
        <span className={cn("font-display font-semibold tracking-[-0.04em] tabular-nums", sz)}>{usd(value)}</span>
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {fee !== undefined && <div className="mt-1 text-sm text-muted-foreground">Platform fee 5%: {usd(fee)}, deducted from the freelancer's payout</div>}
    </div>
  );
}

export function Details({ rows, label = "Details" }: { rows: [string, string][]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[var(--radius-input)] border">
      <button className="flex min-h-11 w-full items-center justify-between px-4 text-sm font-medium" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <dl className="grid gap-2 border-t px-4 py-3 font-mono text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Signature ticket shape: light main part, notch, dark stub. */
export function Ticket({ main, stub, className }: { main: ReactNode; stub: ReactNode; className?: string }) {
  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-[var(--radius-card)] shadow-float md:flex-row", className)}>
      <div className="flex-1 bg-surface p-6 text-ink md:p-8">{main}</div>
      <div className="relative border-t-2 border-dashed border-line md:border-t-0 md:border-l-2" aria-hidden>
        <span className="absolute -top-3.5 -left-3.5 hidden size-7 rounded-full bg-background md:block" />
        <span className="absolute -bottom-3.5 -left-3.5 hidden size-7 rounded-full bg-background md:block" />
      </div>
      <div className="bg-ink p-6 text-on-dark md:w-64 md:p-8">{stub}</div>
    </div>
  );
}

export function Card({ className, dark, children }: { className?: string; dark?: boolean; children: ReactNode }) {
  return <div className={cn("rounded-[var(--radius-card)] border p-5 md:p-6", dark ? "border-line-dark bg-ink text-on-dark" : "bg-surface shadow-soft", className)}>{children}</div>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground", className)}>{children}</p>;
}

export function Logo({ dark }: { dark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display text-xl font-semibold tracking-[-0.04em]", dark ? "text-on-dark" : "text-ink")}>
      <span className="relative grid size-7 place-items-center rounded-full bg-ink" aria-hidden>
        <span className="size-2.5 rounded-full bg-lime" />
      </span>
      Tethran
    </span>
  );
}

/** Reason codes from the Policy Service (docs/INTERFACES.md v0.8) and the other services, in plain language. */
export function ReasonList({ codes, className }: { codes: string[]; className?: string }) {
  if (codes.length === 0) return null;
  return (
    <ul className={cn("grid gap-2", className)}>
      {codes.map((c) => {
        const r = reasonInfo(c);
        return (
          <li key={c} className="rounded-[var(--radius-input)] bg-muted px-3 py-2 text-sm">
            <span className="font-medium">{r.title}.</span> <span className="text-muted-foreground">{r.plain}</span>
            <span className="ml-2 font-mono text-[0.68rem] text-muted-foreground">{c}</span>
          </li>
        );
      })}
    </ul>
  );
}
