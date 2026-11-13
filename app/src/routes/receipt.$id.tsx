import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api";
import { Object3D } from "@/components/tethran/Object3D";
import { Details, Logo, PillButton, Ticket, usd } from "@/components/tethran/ui";
import type { Receipt } from "@/api/types";

export const Route = createFileRoute("/receipt/$id")({
  head: () => ({ meta: [{ title: "Verify receipt — Tethran" }, { name: "description", content: "A verifiable milestone receipt. Hashes only, no personal data." }] }),
  component: ReceiptPage,
});

function ReceiptPage() {
  const { id } = Route.useParams();
  const [r, setR] = useState<Receipt | null | undefined>(undefined);
  const [v, setV] = useState<"idle" | "checking" | "valid" | "invalid">("idle");
  useEffect(() => { api.getReceipt(id).then(setR); }, [id]);
  return (
    <main className="min-h-screen bg-background px-4 py-6">
      <div className="mx-auto max-w-3xl">
        <Link to="/"><Logo /></Link>
        {r === undefined ? <div className="mt-12 h-80 animate-pulse rounded-[var(--radius-card)] bg-line" aria-busy="true" />
        : r === null ? <p className="mt-16 text-center text-lg">No receipt with this ID. Check the link.</p>
        : (
          <>
            <h1 className="display-section mt-12"><span className="weight-light">Milestone</span> receipt.</h1>
            <Ticket className="mt-8"
              main={
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Receipt {r.tokenId}</p>
                  <p className="mt-4 text-2xl font-medium">{r.milestoneTitle}</p>
                  <p className="mt-6 font-display text-6xl font-semibold tracking-[-0.05em]">{usd(r.amount)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{r.date} · {r.network}</p>
                </div>
              }
              stub={<div className="flex h-full items-center justify-center"><div className="animate-seal"><Object3D name="receipt" className="size-36" decorative /></div></div>}
            />
            <div className="mt-6 flex flex-wrap items-center gap-4" aria-live="polite">
              <PillButton variant="ink" disabled={v === "checking"} onClick={async () => { setV("checking"); const res = await api.verifyReceipt(r.id); setV(res.valid ? "valid" : "invalid"); }}>{v === "checking" ? "Checking…" : "Verify"}</PillButton>
              {v === "checking" && <Loader2 className="size-5 animate-spin" aria-hidden />}
              {v === "valid" && <span className="flex items-center gap-2 rounded-full bg-lime px-4 py-2 text-lime-ink animate-lime-pulse"><CheckCircle2 className="size-4" aria-hidden />Matches the record on the test network</span>}
              {v === "invalid" && <span className="text-danger">This receipt doesn't match. Don't trust it.</span>}
            </div>
            <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck className="size-4" aria-hidden />Hashes only. No personal data is stored.</p>
            <div className="mt-6"><Details rows={[["Token ID", r.tokenId], ...(r.platformFee !== undefined ? [["Platform fee (5%, paid by the freelancer)", usd(r.platformFee)] as [string, string]] : []), ["Content hash", r.contentHash], ["Transaction", r.txHash], ["Network", r.network]]} /></div>
          </>
        )}
      </div>
    </main>
  );
}
