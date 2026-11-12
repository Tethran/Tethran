import { FlaskConical, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { api, DEMO_LABEL, type Via } from "@/api";
import { useApi } from "@/components/app/demo-state";
import { cn } from "@/lib/utils";

/** Is the demo signer running (DEMO_MODE)? Checked once and cached by the query client. */
export function useDemoSigner() {
  const q = useApi(["demo-signer"], api.demoSigner);
  return q.data ?? null;
}

/**
 * The two ways to sign an action. "Sign with your wallet" is the real path (the person's own key). In demo mode only,
 * "Sign with demo key" signs with that role's test key in the presenter's process, and the result says so.
 */
export function SignChoice({ label, onSign, busy, tone = "ink", className, children }: {
  label: string;
  onSign: (via: Via) => void;
  busy?: boolean;
  tone?: "ink" | "danger" | "lime";
  className?: string;
  children?: ReactNode;
}) {
  const demo = useDemoSigner();
  const primary = tone === "lime" ? "bg-lime text-lime-ink" : tone === "danger" ? "border border-danger text-danger" : "bg-ink text-on-dark";
  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex flex-wrap gap-2">
        {demo && (
          <button disabled={busy} onClick={() => onSign("demo")} data-testid={`demo-${label}`} title={DEMO_LABEL}
            className={cn("inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-medium disabled:opacity-40", primary)}>
            <FlaskConical className="size-4" aria-hidden />{label}
          </button>
        )}
        <button disabled={busy} onClick={() => onSign("wallet")}
          className={cn("inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm disabled:opacity-40", demo ? "border hover:border-ink" : primary)}>
          <Wallet className="size-4" aria-hidden />{demo ? "Sign with your wallet" : label}
        </button>
      </div>
      {children}
    </div>
  );
}

/** The label shown on anything signed with a demo key. */
export function DemoSigned({ via }: { via: Via | null }) {
  if (via !== "demo") return null;
  return <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-progress px-2 py-0.5 font-mono text-[0.68rem] uppercase tracking-wider"><FlaskConical className="size-3" aria-hidden />{DEMO_LABEL}</span>;
}

/** One note per page when demo signing is on: which button is the test key and which is the real path. */
export function DemoNote() {
  const demo = useDemoSigner();
  if (!demo) return null;
  return (
    <p className="mb-6 flex items-start gap-2 rounded-[var(--radius-input)] border border-dashed border-progress bg-progress/10 p-3 text-sm">
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span><span className="font-medium">Demo mode.</span> Buttons with the flask sign with a test key ({DEMO_LABEL.toLowerCase()}). "Sign with your wallet" is the real path.</span>
    </p>
  );
}
