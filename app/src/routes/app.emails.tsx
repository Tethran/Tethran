import { createFileRoute } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { api } from "@/api";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/emails")({
  head: () => ({ meta: [{ title: "Emails — Tethran" }, { name: "description", content: "Every invoice email: status, provider message id and time." }] }),
  component: EmailsPage,
});

const TONE: Record<string, string> = { sent: "bg-success/15 text-success", failed: "bg-danger/15 text-danger", capped: "bg-danger/15 text-danger", blocked: "bg-progress/20", skipped: "bg-progress/20", not_configured: "bg-progress/20", invalid_address: "bg-danger/15 text-danger", sending: "bg-line" };

function EmailsPage() {
  const q = useApi(["emails"], api.emails);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHead eyebrow="Emails" light="Invoice" title="emails." />
      <Async q={q} rows={2} empty={<EmptyBlock title="No emails yet." />}>
        {(e) => (
          <>
            {!e.configured && (
              <p className="mb-6 flex items-start gap-2 rounded-[var(--radius-input)] border border-dashed border-progress bg-progress/10 p-3 text-sm" data-testid="email-outbox-note">
                <Mail className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span><span className="font-medium">Outbox only.</span> Email is not configured (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM), so nothing is sent. Each invoice email is kept here with its pay link.</span>
              </p>
            )}
            {e.configured && <p className="mb-6 text-sm text-muted-foreground">Sent through {e.provider}. {e.sentToday} of {e.dailyCap} today.</p>}
            {e.items.length === 0 ? <EmptyBlock title="No invoice emails yet." /> : (
              <ul className="grid gap-2" data-testid="email-list">
                {e.items.map((m) => (
                  <li key={m.id} className="rounded-[var(--radius-card)] border bg-surface p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded-full px-2 py-0.5 font-mono text-[0.68rem] uppercase", TONE[m.status] ?? "bg-line")}>{m.status.replace(/_/g, " ")}</span>
                      <span className="font-medium">{m.subject}</span>
                    </div>
                    <p className="mt-1 text-muted-foreground">To {m.to} · {m.createdAt.slice(0, 16).replace("T", " ")}{m.providerMessageId && <> · message <span className="font-mono">{m.providerMessageId}</span></>}</p>
                    {m.error && <p className="mt-1 text-muted-foreground">{m.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Async>
    </div>
  );
}
