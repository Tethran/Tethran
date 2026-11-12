import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { api } from "@/api";
import { useApi } from "@/components/app/demo-state";
import { Object3D } from "@/components/tethran/Object3D";
import type { ObjKey } from "@/lib/objects";

export const Route = createFileRoute("/app/")({
  head: () => ({ meta: [{ title: "Choose a role — Tethran demo" }, { name: "description", content: "Pick a role to explore the Tethran demo." }] }),
  component: RolePicker,
});

const ROLES: { to: "/app/dashboard" | "/pay/$id" | "/app/operator" | "/app/arbiter"; label: string; line: string; obj: ObjKey; params?: { id: string } }[] = [
  { to: "/app/dashboard", label: "Freelancer", line: "Create contracts, get paid to your phone.", obj: "invoice" },
  { to: "/pay/$id", label: "Client", line: "Fund a milestone. No account needed.", obj: "card" },
  { to: "/app/operator", label: "Operator", line: "Set limits. Approve what the rules escalate.", obj: "gate" },
  { to: "/app/arbiter", label: "Arbiter", line: "Decide disputes, two of three.", obj: "scales" },
];

function RolePicker() {
  // The client opens the first unpaid invoice's pay link (the seed creates them).
  const invoices = useApi(["invoices"], api.listInvoices);
  const unpaid = invoices.data?.find((i) => i.status === "Unpaid");
  const roles = ROLES.map((r) => (r.to === "/pay/$id" ? (unpaid ? { ...r, params: { id: unpaid.id } } : { ...r, to: "/app/dashboard" as const, line: "No unpaid invoice right now. Seed the demo to get one." }) : r));
  return (
    <div>
      <h1 className="display-section max-w-[14ch]"><span className="weight-light">Who are</span> you today?</h1>
      <p className="mt-4 text-muted-foreground">Everything here is a demo on test networks.</p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {roles.map((r, k) => (
          <Link key={r.label} to={r.to} params={r.params as never}
            className={"group relative flex min-h-56 flex-col justify-between overflow-hidden rounded-[var(--radius-sheet)] p-6 transition-transform duration-300 hover:-translate-y-1 " + (k === 0 ? "dark bg-ink text-on-dark" : "border bg-surface shadow-soft")}>
            <Object3D name={r.obj} className="absolute -top-2 -right-4 size-40 md:size-48" depth={0.8} delay={k * 0.6} decorative />
            <span className="grid size-10 place-items-center rounded-full border border-current/20 transition-transform group-hover:rotate-45"><ArrowUpRight className="size-5" aria-hidden /></span>
            <div className="relative"><h2 className="text-4xl">{r.label}</h2><p className="mt-2 max-w-[26ch] text-muted-foreground">{r.line}</p></div>
          </Link>
        ))}
      </div>
    </div>
  );
}
