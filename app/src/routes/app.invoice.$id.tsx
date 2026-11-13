import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import { PageHead } from "@/components/app/AppShell";
import { Async, EmptyBlock, useApi } from "@/components/app/demo-state";
import { QR } from "@/components/landing/ThreeSteps";
import { Amount, pill, StatusChip, Ticket } from "@/components/tethran/ui";

export const Route = createFileRoute("/app/invoice/$id")({
  head: () => ({ meta: [{ title: "Invoice — Tethran" }, { name: "description", content: "Invoice and pay link." }] }),
  component: InvoicePage,
});

function InvoicePage() {
  const { id } = Route.useParams();
  const q = useApi(["invoice", id], () => api.getInvoice(id));
  return (
    <div className="mx-auto max-w-3xl">
      <PageHead eyebrow="Invoice" light="Share your" title="pay link." />
      <Async q={q} rows={2} empty={<EmptyBlock obj="invoice" title="This invoice doesn't exist." />}>
        {(inv) => (
          <>
            <Ticket
              main={
                <div>
                  <div className="flex items-center justify-between"><p className="font-mono text-sm">{inv.number}</p><StatusChip status={inv.status === "Paid" ? "Funded" : "Draft"} /></div>
                  <p className="mt-2 text-sm text-muted-foreground">{inv.client} · {inv.title}</p>
                  <Amount value={inv.amount} fee={inv.fee} className="mt-8" />
                  <p className="mt-1 text-sm text-muted-foreground">Fee paid by: {inv.feePaidBy}</p>
                  <dl className="mt-6 grid grid-cols-2 gap-3 border-t pt-4 text-sm">
                    <div><dt className="text-muted-foreground">Issued</dt><dd>{inv.issuedAt}</dd></div>
                    <div><dt className="text-muted-foreground">Tax ID</dt><dd className="font-mono">{inv.taxId ?? "—"}</dd></div>
                  </dl>
                </div>
              }
              stub={
                <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                  <QR /><p className="font-mono text-xs text-muted-dark break-all">{inv.payLink}</p>
                </div>
              }
            />
            <div className="mt-6 flex flex-wrap gap-3">
              <button className={pill({ variant: "ink", size: "plain" })} onClick={() => { navigator.clipboard?.writeText(inv.payLink); toast.success("Pay link copied"); }}><Copy className="size-4" aria-hidden />Copy link</button>
              <button className={pill({ variant: "ghost", size: "plain" })} onClick={() => (navigator.share ? navigator.share({ url: inv.payLink, title: inv.number }).catch(() => {}) : toast("Sharing isn't available here. Copy the link instead."))}><Share2 className="size-4" aria-hidden />Share</button>
              <Link to="/pay/$id" params={{ id: inv.id }} className={pill({ variant: "ghost", size: "plain" })}>Preview as client</Link>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
