// Reconciliation ledger (PRD M10): invoice <-> payment <-> escrow tx <-> release tx <-> settlement plan (+ Opik trace)
// <-> on-chain payouts <-> off-chain payout legs <-> receipt, per milestone, built from the existing tables.
// Also the failed/disputed/suspicious queue (FR-10.4) and the tax-ready CSV export (FR-10.3).
//
// SIMULATED inputs: fiat-to-USDT conversion (1:1), identity verification, mobile-money and bank legs and their fees.
// Amounts are strings in USDT base units; sums use BigInt, never floating point. The CSV prints decimals with 6
// places, derived from the base units.
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors";
import { formatMicro, legOf, migratePayouts, refreshLeg, type OffchainRow } from "./payouts";

export function migrateReconciliation(db: DatabaseSync) {
  migratePayouts(db); // the ledger reads off-chain legs; harmless if already run
  db.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_meta (
      milestone_id TEXT PRIMARY KEY, country TEXT NOT NULL, invoice_number TEXT
    );
  `);
}

/** Records the country profile (and optionally a printed invoice number) of a milestone for exports. */
export function setMilestoneCountry(db: DatabaseSync, milestoneId: string, country: string, invoiceNumber?: string) {
  db.prepare("INSERT INTO reconciliation_meta (milestone_id, country, invoice_number) VALUES (?, ?, ?) ON CONFLICT(milestone_id) DO UPDATE SET country = excluded.country, invoice_number = COALESCE(excluded.invoice_number, invoice_number)")
    .run(milestoneId, country.toUpperCase(), invoiceNumber ?? null);
}

export type GapSeverity = "problem" | "info";
export interface Gap { code: string; severity: GapSeverity; message: string; record: { table: string; id: string | number } }

type M = {
  id: string; provider_id: string; title: string; amount: string; amount_usd_cents: number; chain_id: number; state: string;
  escrow_tx: string | null; release_tx: string | null; invoice_ref: string; created_at: string; funding_source: string | null; card_funded: number;
};
type PayoutR = { id: number; plan_id: number; action_index: number; payee_id: string; rail: string; amount: string; tx: string | null; status: string; simulated: number; at: string };
type PlanR = { id: number; proposal_json: string | null; proposal_hash: string | null; trace_id: string; decision: string; reasons: string; at: string };

const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const sum = (xs: (string | bigint)[]) => xs.reduce<bigint>((a, x) => a + BigInt(x), 0n);

export interface ReconciliationDeps { db: DatabaseSync; now: () => Date }

export function createReconciliation(deps: ReconciliationDeps) {
  const { db, now } = deps;

  function countryOf(m: M, legs: OffchainRow[]): string {
    const meta = db.prepare("SELECT country FROM reconciliation_meta WHERE milestone_id = ?").get(m.id) as { country: string } | undefined;
    if (meta) return meta.country;
    return legs.find((l) => l.rail !== "usdt")?.country ?? "UNSPECIFIED";
  }

  function ledger(m: M) {
    const meta = db.prepare("SELECT invoice_number FROM reconciliation_meta WHERE milestone_id = ?").get(m.id) as { invoice_number: string | null } | undefined;
    const fundings = db.prepare("SELECT id, source, reference, amount, chain_id, escrow_tx, status, at FROM fundings WHERE milestone_id = ? ORDER BY id").all(m.id) as any[];
    const stripe = db.prepare("SELECT event_id, type, outcome, at FROM stripe_events WHERE milestone_id = ? ORDER BY at").all(m.id) as any[];
    const plans = db.prepare("SELECT * FROM settlement_plans WHERE milestone_id = ? ORDER BY id").all(m.id) as unknown as PlanR[];
    const payouts = db.prepare("SELECT id, plan_id, action_index, payee_id, rail, amount, tx, status, simulated, at FROM payouts WHERE milestone_id = ? ORDER BY action_index").all(m.id) as unknown as PayoutR[];
    const legs: OffchainRow[] = [];
    for (const p of payouts) {
      const l = legOf(db, p.id);
      if (l) legs.push(refreshLeg(db, l, now()));
    }
    const receipt = db.prepare("SELECT chain_id, token_id, mint_tx, holder, invoice_hash, settlement_hash, at FROM receipts WHERE milestone_id = ?").get(m.id) as any | undefined;
    const identity = db.prepare("SELECT payer_verified_name, customer_verified_name, simulated_id_ref FROM identity_records WHERE milestone_id = ?").get(m.id) as any | undefined;
    const funded = fundings.find((f) => f.status === "funded");
    const plan = [...plans].reverse().find((p) => p.decision === "approved" || p.decision === "paid_out") ?? plans[plans.length - 1];
    const approved = plan && (plan.decision === "approved" || plan.decision === "paid_out");

    // ---- gaps ----
    const gaps: Gap[] = [];
    const gap = (code: string, message: string, table: string, id: string | number, severity: GapSeverity = "problem") =>
      gaps.push({ code, severity, message, record: { table, id } });
    for (const f of fundings) {
      if (f.status === "failed") gap("FUNDING_FAILED", `funding ${f.reference} failed`, "fundings", f.id);
      if (f.status === "mismatch") gap("FUNDING_MISMATCH", `funding ${f.reference} does not match the milestone`, "fundings", f.id);
    }
    if (funded && !funded.escrow_tx) gap("ESCROW_TX_MISSING", "funded but no escrow transaction is recorded", "fundings", funded.id);
    const terminal = m.state === "refunded";
    if (funded && !m.release_tx && !terminal) gap("PAID_NOT_RELEASED", "paid and escrowed but not released to the vault", "milestones", m.id, "info");
    if (m.release_tx && !approved) gap("RELEASED_NOT_SETTLED", "released to the vault but no approved settlement plan", "milestones", m.id);
    if (m.release_tx && approved && payouts.length === 0) gap("RELEASED_NOT_SETTLED", "plan approved but no payouts were recorded", "settlement_plans", plan.id);
    for (const p of payouts) {
      if (p.status !== "confirmed") gap("PAYOUT_NOT_CONFIRMED", `on-chain payout ${p.id} is ${p.status}`, "payouts", p.id);
      else {
        const l = legs.find((x) => x.payout_id === p.id);
        if (!l) gap("OFFCHAIN_LEG_MISSING", `on-chain payout ${p.id} is confirmed but has no off-chain leg`, "payouts", p.id, "info");
        else if (l.status === "failed") gap("OFFCHAIN_FAILED", `payout ${p.id} was confirmed on-chain but the off-chain leg failed: ${l.reason ?? "unknown"}`, "offchain_payouts", p.id);
        else if (l.status !== "delivered") gap("OFFCHAIN_IN_FLIGHT", `off-chain leg of payout ${p.id} is ${l.status}`, "offchain_payouts", p.id, "info");
      }
    }
    const allConfirmed = payouts.length > 0 && payouts.every((p) => p.status === "confirmed");
    if (allConfirmed && !receipt) gap("SETTLED_NO_RECEIPT", "all payouts confirmed but the receipt is missing", "milestones", m.id);
    if (identity && norm(identity.payer_verified_name) !== norm(identity.customer_verified_name)) {
      gap("IDENTITY_MISMATCH", "payer and customer verified names differ (simulated check)", "identity_records", m.id);
    }
    const complete = gaps.length === 0 && (!!receipt || terminal);

    // ---- amounts ----
    const taxReserve = approved && plan.proposal_json
      ? sum(((JSON.parse(plan.proposal_json).actions ?? []) as any[]).filter((a) => a.type === "tax_reserve").map((a) => a.amount))
      : 0n;
    const confirmed = payouts.filter((p) => p.status === "confirmed");
    const fee = sum(legs.map((l) => l.fee));
    const paidGross = sum(confirmed.map((p) => p.amount));
    const country = countryOf(m, legs);

    return {
      milestone_id: m.id, state: m.state, country, complete, gaps,
      invoice: { number: meta?.invoice_number ?? m.invoice_ref, invoice_ref: m.invoice_ref, title: m.title, amount: m.amount, amount_usd_cents: m.amount_usd_cents, issued_at: m.created_at, provider_id: m.provider_id },
      payment: { funding_source: m.funding_source, card_funded: m.card_funded === 1, simulated_fiat_conversion: m.funding_source === "card", fundings, stripe_events: stripe },
      escrow_tx: m.escrow_tx ?? funded?.escrow_tx ?? null,
      release_tx: m.release_tx,
      settlement_plan: plan ? { id: plan.id, decision: plan.decision, proposal_hash: plan.proposal_hash, trace_id: plan.trace_id, reasons: JSON.parse(plan.reasons), at: plan.at } : null,
      payouts: payouts.map((p) => ({ ...p, simulated: p.simulated === 1 })),
      offchain_legs: legs.map((l) => ({ simulated: true, payout_id: l.payout_id, adapter: l.adapter, rail: l.rail, provider_ref: l.provider_ref, status: l.status, reason: l.reason, fee: l.fee, local_amount: l.local_amount, currency: l.currency, country: l.country })),
      receipt: receipt ? { token_id: receipt.token_id, mint_tx: receipt.mint_tx, holder: receipt.holder, chain_id: receipt.chain_id, at: receipt.at } : null,
      identity: identity ? { match: norm(identity.payer_verified_name) === norm(identity.customer_verified_name), simulated: true } : null,
      totals: {
        gross: m.amount, tax_reserve: taxReserve.toString(), paid_onchain: paidGross.toString(), fees: fee.toString(),
        net_paid: (paidGross - fee).toString(), fees_simulated: true,
      },
      _times: { funded_at: funded?.at ?? null, settled_at: confirmed.length ? confirmed[confirmed.length - 1].at : null },
    };
  }
  type Ledger = ReturnType<typeof ledger>;
  const publicLedger = ({ _times, ...rest }: Ledger) => rest;

  const getMilestone = (id: string) => db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as M | undefined;

  function parseDate(v: string | null, end: boolean): string | undefined {
    if (!v) return undefined;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
    const d = new Date(dateOnly ? v + (end ? "T23:59:59.999Z" : "T00:00:00.000Z") : v);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, "from and to must be ISO dates");
    return d.toISOString();
  }

  function filtered(q: { from?: string | null; to?: string | null; country?: string | null }): Ledger[] {
    const from = parseDate(q.from ?? null, false);
    const to = parseDate(q.to ?? null, true);
    const rows = db.prepare("SELECT * FROM milestones ORDER BY created_at, id").all() as unknown as M[];
    return rows
      .filter((m) => (!from || m.created_at >= from) && (!to || m.created_at <= to))
      .map(ledger)
      .filter((l) => !q.country || l.country === q.country.toUpperCase());
  }

  function queue() {
    const items: { kind: string; reason: string; milestone_id: string | null; record: { table: string; id: string | number }; at: string | null; simulated?: true }[] = [];
    const add = (kind: string, reason: string, milestone_id: string | null, table: string, id: string | number, at: string | null, simulated?: true) =>
      items.push({ kind, reason, milestone_id, record: { table, id }, at, ...(simulated ? { simulated } : {}) });
    for (const f of db.prepare("SELECT * FROM fundings WHERE status IN ('failed', 'mismatch') ORDER BY id").all() as any[]) {
      add(f.status === "mismatch" ? "funding_mismatch" : "funding_failed", `funding ${f.reference} is ${f.status}`, f.milestone_id, "fundings", f.id, f.at);
    }
    for (const s of db.prepare("SELECT * FROM stripe_events ORDER BY at").all() as any[]) {
      if (/dispute|chargeback/i.test(s.type) || /chargeback|^flagged/i.test(s.outcome)) {
        add("dispute_or_chargeback", `${s.type}: ${s.outcome}`, s.milestone_id, "stripe_events", s.event_id, s.at);
      }
    }
    for (const m of db.prepare("SELECT * FROM milestones WHERE state = 'disputed' ORDER BY created_at").all() as unknown as M[]) {
      add("disputed_milestone", "milestone is disputed", m.id, "milestones", m.id, m.created_at);
    }
    for (const p of db.prepare("SELECT * FROM settlement_plans WHERE decision IN ('rejected', 'escalated') ORDER BY id").all() as unknown as PlanR[] & { milestone_id: string }[]) {
      add(p.decision === "rejected" ? "plan_rejected" : "plan_escalated", `settlement plan ${p.decision}: ${JSON.parse(p.reasons).join(", ") || "no reason recorded"}`, (p as any).milestone_id, "settlement_plans", p.id, p.at);
    }
    for (const p of db.prepare("SELECT * FROM payouts WHERE status IN ('failed', 'expired') ORDER BY id").all() as any[]) {
      add("payout_failed", `on-chain payout ${p.id} is ${p.status}`, p.milestone_id, "payouts", p.id, p.at);
    }
    for (const l of db.prepare("SELECT * FROM offchain_payouts ORDER BY payout_id").all() as unknown as OffchainRow[]) {
      const r = refreshLeg(db, l, now());
      if (r.status === "failed") add("offchain_failed", `off-chain leg failed after the on-chain payout confirmed: ${r.reason ?? "unknown"}`, r.milestone_id, "offchain_payouts", r.payout_id, r.updated_at, true);
    }
    for (const i of db.prepare("SELECT * FROM identity_records ORDER BY milestone_id").all() as any[]) {
      if (norm(i.payer_verified_name) !== norm(i.customer_verified_name)) {
        add("identity_mismatch", "payer and customer verified names differ (simulated check)", i.milestone_id, "identity_records", i.milestone_id, null, true);
      }
    }
    return items;
  }

  const csvCell = (v: unknown, text = false): string => {
    let s = v === null || v === undefined ? "" : String(v);
    // Spreadsheet formula injection guard for free-text fields.
    if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dec = (v: string) => formatMicro(BigInt(v), 6);
  const CSV_COLUMNS = ["invoice_number", "invoice_date", "country", "funded_at", "settled_at", "gross", "fee", "tax_reserve", "net_paid", "currency",
    "chain_id", "escrow_tx", "release_tx", "payout_txs", "receipt_id", "receipt_mint_tx", "trace_id", "complete"];

  function csv(q: { from?: string | null; to?: string | null; country?: string | null }) {
    const lines = [CSV_COLUMNS.join(",")];
    for (const l of filtered(q)) {
      const m = getMilestone(l.milestone_id)!;
      lines.push([
        csvCell(l.invoice.number, true), l.invoice.issued_at.slice(0, 10), csvCell(l.country), l._times.funded_at ?? "", l._times.settled_at ?? "",
        dec(l.totals.gross), dec(l.totals.fees), dec(l.totals.tax_reserve), dec(l.totals.net_paid), "USDT",
        m.chain_id, l.escrow_tx ?? "", l.release_tx ?? "", csvCell(l.payouts.map((p) => p.tx).filter(Boolean).join(";")),
        l.receipt?.token_id ?? "", l.receipt?.mint_tx ?? "", l.settlement_plan?.trace_id ?? "", l.complete,
      ].map((x) => (typeof x === "string" ? x : String(x))).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  return {
    milestone(id: string) {
      const m = getMilestone(id);
      if (!m) throw new ApiError(404, "milestone not found");
      return { simulated_parts: ["fiat conversion", "identity check", "mobile money and bank legs"], ...publicLedger(ledger(m)) };
    },
    list(q: { from?: string | null; to?: string | null; country?: string | null }) {
      const items = filtered(q).map((l) => ({
        milestone_id: l.milestone_id, invoice_number: l.invoice.number, state: l.state, country: l.country, gross: l.totals.gross,
        complete: l.complete, gaps: l.gaps.map((g) => g.code),
      }));
      return { count: items.length, complete: items.filter((i) => i.complete).length, items };
    },
    queue,
    csv,
  };
}

type Ctx = { params: Record<string, string>; body: any; url: URL };
type Handler = (ctx: Ctx) => Promise<unknown>;

/** `{ __raw: true, ... }` tells the HTTP layer to send `body` as is with `contentType` instead of JSON. */
export interface RawResponse { __raw: true; contentType: string; body: string; filename?: string }

export function reconciliationRoutes(deps: ReconciliationDeps): [string, RegExp, Handler][] {
  const r = createReconciliation(deps);
  const q = (url: URL) => ({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), country: url.searchParams.get("country") });
  return [
    ["GET", /^\/reconciliation\/milestones\/([^/]+)$/, async ({ params }) => r.milestone(params[1])],
    ["GET", /^\/reconciliation\/queue$/, async () => { const items = r.queue(); return { count: items.length, items }; }],
    ["GET", /^\/reconciliation\/export\.csv$/, async ({ url }): Promise<RawResponse> => ({
      __raw: true, contentType: "text/csv", filename: "tethran-reconciliation.csv", body: r.csv(q(url)),
    })],
    ["GET", /^\/reconciliation$/, async ({ url }) => r.list(q(url))],
  ];
}
