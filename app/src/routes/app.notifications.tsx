import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { api } from "@/api";
import { PageHead } from "@/components/app/AppShell";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/app/demo-state";
import { ROLES, setRole, useRole } from "@/lib/role";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/notifications")({
  head: () => ({ meta: [{ title: "Notifications — Tethran" }, { name: "description", content: "Your notifications: invoices, payments, deliveries, settlements, receipts." }] }),
  component: NotificationsPage,
});

/** Same-origin links open in the app; anything else (an email preview) opens as a normal link. */
function inApp(link: string) {
  try { const u = new URL(link, location.origin); return u.origin === location.origin ? u.pathname + u.search : null; } catch { return null; }
}

function NotificationsPage() {
  const role = useRole();
  const q = useQuery({ queryKey: ["notifications", role], queryFn: () => api.notifications(role), refetchInterval: 2000 });
  const open = async (id: number, link: string, read: boolean) => {
    if (!read) await api.markNotificationRead(id, role).catch(() => {});
    const path = inApp(link);
    if (path) location.assign(path); else window.open(link, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="mx-auto max-w-3xl">
      <PageHead eyebrow="Notifications" light="What's" title="new." >
        {q.data && q.data.unread > 0 && (
          <button data-testid="mark-all-read" onClick={async () => { await api.markAllNotificationsRead(role); q.refetch(); }} className="inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm hover:border-ink">
            <CheckCheck className="size-4" aria-hidden />Mark all read
          </button>
        )}
      </PageHead>
      <div role="tablist" aria-label="Whose notifications" className="mb-6 inline-flex flex-wrap rounded-full border bg-surface p-1">
        {ROLES.map((r) => (
          <button key={r} role="tab" aria-selected={role === r} onClick={() => setRole(r)} className={cn("min-h-10 rounded-full px-4 text-sm capitalize", role === r ? "bg-ink text-on-dark" : "hover:bg-line/60")}>{r}</button>
        ))}
      </div>
      {q.isPending ? <LoadingBlock rows={3} /> : q.isError ? <ErrorBlock onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? (
        <EmptyBlock obj="receipt" title={`Nothing for the ${role} yet.`} />
      ) : (
        <ul className="grid gap-2" data-testid="notif-list">
          {q.data.items.map((n) => (
            <li key={n.id}>
              <button onClick={() => open(n.id, n.link, !!n.read_at)} data-testid={`notif-${n.type}`}
                className={cn("flex w-full items-start gap-3 rounded-[var(--radius-card)] border bg-surface p-4 text-left text-sm hover:border-ink", !n.read_at && "border-ink/40")}>
                <Bell className={cn("mt-0.5 size-4 shrink-0", n.read_at ? "text-muted-foreground" : "text-ink")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn("block", !n.read_at && "font-medium")}>{n.title}</span>
                  <span className="mt-0.5 block text-muted-foreground">{n.body}</span>
                  <span className="mt-1 block font-mono text-xs text-muted-foreground">{n.created_at.slice(0, 16).replace("T", " ")}{!n.read_at && " · unread"}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
