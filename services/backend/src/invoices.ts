// Invoicing logic (PRD M2, FR-2.1 to FR-2.5). Data and rules only: no screens, no chain, no email.
// Everything is integer USD cents. Reminder delivery is SIMULATED: reminders are recorded and returned.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { requireCountryProfile } from "./countryProfiles";
import { getContractRow, milestoneState, type ContractTerms, type Recurrence } from "./contracts";
import { ApiError } from "./errors";

/**
 * Fee model (placeholder, configurable): fee = round_half_up(subtotal * bps / 10000) + fixed_cents.
 * Defaults 1% + 30 cents. FEE_BPS and FEE_FIXED_CENTS override them.
 * fee_payer "client": total = subtotal + fee, provider payout = subtotal.
 * fee_payer "provider": total = subtotal, provider payout = subtotal - fee.
 */
export interface FeeConfig { bps: number; fixed_cents: number }
export const DEFAULT_FEE: FeeConfig = { bps: 100, fixed_cents: 30 };
export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:3000";
export const REMINDER_KINDS = ["before_due", "due_today", "overdue_7"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
/** Recurring occurrences are issued this many days before their due date. */
export const RECURRING_LEAD_DAYS = 7;
const DAY = 86_400_000;

export interface EscrowMilestoneBody {
  id: string; provider_id: string; title: string; client_address: string; amount_usd_cents: number; invoice_ref: string;
}

export interface InvoiceEnv { db: DatabaseSync; now: () => Date; publicBaseUrl?: string; fee?: FeeConfig }

export function feeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeeConfig {
  const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);
  return { bps: n(env.FEE_BPS, DEFAULT_FEE.bps), fixed_cents: n(env.FEE_FIXED_CENTS, DEFAULT_FEE.fixed_cents) };
}

export function computeAmounts(subtotal: number, feePayer: "provider" | "client", cfg: FeeConfig) {
  const fee = Number((BigInt(subtotal) * BigInt(cfg.bps) + 5000n) / 10000n) + cfg.fixed_cents;
  if (feePayer === "client") return { fee_cents: fee, total_cents: subtotal + fee, payout_cents: subtotal };
  if (fee >= subtotal) throw new ApiError(400, "the fee is not smaller than the milestone amount");
  return { fee_cents: fee, total_cents: subtotal, payout_cents: subtotal - fee };
}

interface InvoiceRow {
  id: string; provider_id: string; contract_id: string; milestone_id: string; occurrence: number; escrow_milestone_id: string;
  number: string; seq: number; year: number; country: string; currency: string; provider_name: string; client_name: string;
  provider_tax_ids_json: string; missing_fields_json: string; line_items_json: string;
  subtotal_cents: number; fee_cents: number; total_cents: number; payout_cents: number; fee_payer: "provider" | "client";
  issue_date: string; due_date: string; status: string; paid_at: string | null; paid_reference: string | null; created_at: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (s: string) => Date.parse(s + "T00:00:00Z");

function getInvoiceRow(db: DatabaseSync, id: string): InvoiceRow {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
  if (!row) throw new ApiError(404, "invoice not found");
  return row;
}

/** Paid = marked paid by markInvoicePaid, or the linked escrow milestone exists in a state other than draft. */
export function isPaid(db: DatabaseSync, inv: InvoiceRow): boolean {
  return inv.status === "paid" || milestoneState(db, inv.escrow_milestone_id) !== "draft";
}

export function daysOverdue(dueDate: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - dayStart(dueDate)) / DAY));
}

/** Deterministic UUID-shaped escrow id for recurring occurrence k >= 1 (occurrence 0 uses the milestone id). */
export function occurrenceEscrowId(milestoneId: string, occurrence: number): string {
  if (occurrence === 0) return milestoneId;
  const h = createHash("sha256").update(`${milestoneId}:${occurrence}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function invoiceView(env: InvoiceEnv, inv: InvoiceRow) {
  const paid = isPaid(env.db, inv);
  return {
    id: inv.id, number: inv.number, provider_id: inv.provider_id, contract_id: inv.contract_id, milestone_id: inv.milestone_id,
    occurrence: inv.occurrence, escrow_milestone_id: inv.escrow_milestone_id, country: inv.country, currency: inv.currency,
    provider_name: inv.provider_name, client_name: inv.client_name,
    provider_tax_ids: JSON.parse(inv.provider_tax_ids_json), missing_required_fields: JSON.parse(inv.missing_fields_json),
    line_items: JSON.parse(inv.line_items_json),
    subtotal_cents: inv.subtotal_cents, fee_cents: inv.fee_cents, total_cents: inv.total_cents, provider_payout_cents: inv.payout_cents,
    fee_payer: inv.fee_payer, issue_date: inv.issue_date, due_date: inv.due_date,
    status: paid ? "paid" : "unpaid", paid_at: inv.paid_at, paid_reference: inv.paid_reference,
    pay_url: payUrl(env, inv.id),
  };
}

function payUrl(env: InvoiceEnv, invoiceId: string): string {
  const base = (env.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
  return `${base}/pay/${invoiceId}`;
}

// ---------- creation ----------

function parseTaxIds(profileCode: string, v: unknown): Record<string, string> {
  const profile = requireCountryProfile(profileCode);
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ApiError(400, "provider_tax_ids must be an object");
  const allowed = new Set(profile.tax_identifiers.map((t) => t.field));
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!allowed.has(k)) throw new ApiError(400, `provider_tax_ids.${k} is not a tax identifier for ${profile.code} (allowed: ${[...allowed].join(", ")})`);
    if (typeof val !== "string" || val.trim() === "" || val.length > 64) throw new ApiError(400, `provider_tax_ids.${k} must be a non-empty string`);
    out[k] = val.trim();
  }
  return out;
}

function insertInvoice(env: InvoiceEnv, a: {
  contractId: string; milestoneId: string; occurrence: number; dueDate: string; feePayer: "provider" | "client"; taxIds: Record<string, string>; now: Date;
}): InvoiceRow {
  const { db } = env;
  const row = getContractRow(db, a.contractId);
  const terms = JSON.parse(row.terms_json) as ContractTerms;
  const m = terms.milestones.find((x) => x.id === a.milestoneId)!;
  const profile = requireCountryProfile(terms.country);
  const amounts = computeAmounts(m.amount_usd_cents, a.feePayer, env.fee ?? DEFAULT_FEE);
  const P = "provider_tax_ids.";
  const missing = profile.required_invoice_fields.filter((f) => f.startsWith(P) && !a.taxIds[f.slice(P.length)]);
  const year = a.now.getUTCFullYear();
  const id = crypto.randomUUID();
  db.exec("BEGIN");
  try {
    const last = db.prepare("SELECT last_seq FROM invoice_counters WHERE provider_id = ? AND year = ?").get(terms.provider_id, year) as { last_seq: number } | undefined;
    const seq = (last?.last_seq ?? 0) + 1;
    db.prepare("INSERT INTO invoice_counters (provider_id, year, last_seq) VALUES (?, ?, ?) ON CONFLICT (provider_id, year) DO UPDATE SET last_seq = excluded.last_seq").run(terms.provider_id, year, seq);
    const number = `INV-${year}-${String(seq).padStart(4, "0")}`;
    db.prepare(`INSERT INTO invoices (id, provider_id, contract_id, milestone_id, occurrence, escrow_milestone_id, number, seq, year, country, currency,
        provider_name, client_name, provider_tax_ids_json, missing_fields_json, line_items_json, subtotal_cents, fee_cents, total_cents, payout_cents,
        fee_payer, issue_date, due_date, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`)
      .run(id, terms.provider_id, a.contractId, a.milestoneId, a.occurrence, occurrenceEscrowId(a.milestoneId, a.occurrence), number, seq, year, terms.country,
        terms.provider_name, terms.client_name, JSON.stringify(a.taxIds), JSON.stringify(missing),
        JSON.stringify([{ description: m.title, quantity: 1, unit_amount_cents: m.amount_usd_cents, amount_cents: m.amount_usd_cents }]),
        m.amount_usd_cents, amounts.fee_cents, amounts.total_cents, amounts.payout_cents, a.feePayer, day(a.now), a.dueDate, a.now.toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getInvoiceRow(db, id);
}

/** Create the invoice for a contract milestone. Idempotent: a second call returns the same invoice. */
export function createInvoice(env: InvoiceEnv, milestoneId: string, body: any = {}) {
  const { db } = env;
  const m = db.prepare("SELECT contract_id, due_date FROM contract_milestones WHERE id = ?").get(milestoneId) as { contract_id: string; due_date: string } | undefined;
  if (!m) throw new ApiError(404, "contract milestone not found");
  const existing = db.prepare("SELECT * FROM invoices WHERE milestone_id = ? AND occurrence = 0").get(milestoneId) as InvoiceRow | undefined;
  if (existing) return { ...invoiceView(env, existing), created: false };
  const contract = getContractRow(db, m.contract_id);
  if (contract.status !== "signed") throw new ApiError(409, "contract is not signed by both parties", "NOT_SIGNED");
  const terms = JSON.parse(contract.terms_json) as ContractTerms;
  const feePayer = body?.fee_payer ?? "provider";
  if (feePayer !== "provider" && feePayer !== "client") throw new ApiError(400, 'fee_payer must be "provider" or "client"');
  const row = insertInvoice(env, {
    contractId: m.contract_id, milestoneId, occurrence: 0, dueDate: m.due_date, feePayer,
    taxIds: parseTaxIds(terms.country, body?.provider_tax_ids), now: env.now(),
  });
  return { ...invoiceView(env, row), created: true };
}

export function getInvoice(env: InvoiceEnv, id: string) {
  return invoiceView(env, getInvoiceRow(env.db, id));
}

// ---------- activation (the body for the existing POST /milestones) ----------

/**
 * The body for POST /milestones. Allowed only when the contract is signed. The contract milestone's id is the
 * escrow milestone id and its invoice number is the invoice_ref (the invoice is created, with defaults, if
 * it does not exist yet). The treasury is not called here; the main session posts this body to it.
 * amount_usd_cents is the milestone amount; how an invoice's fee is collected on top is the checkout's concern.
 */
export function activateMilestone(env: InvoiceEnv, contractId: string, milestoneId: string): EscrowMilestoneBody {
  const row = getContractRow(env.db, contractId);
  if (row.status !== "signed") throw new ApiError(409, "contract is not signed by both parties", "NOT_SIGNED");
  const terms = JSON.parse(row.terms_json) as ContractTerms;
  const m = terms.milestones.find((x) => x.id === milestoneId);
  if (!m) throw new ApiError(404, "milestone not found in this contract");
  const inv = createInvoice(env, milestoneId, {});
  return {
    id: m.id, provider_id: terms.provider_id, title: m.title, client_address: terms.client_address,
    amount_usd_cents: m.amount_usd_cents, invoice_ref: inv.number,
  };
}

/** Same body for any invoice, including a recurring occurrence (its escrow id is derived from the milestone id). */
export function activateInvoice(env: InvoiceEnv, invoiceId: string): EscrowMilestoneBody {
  const inv = getInvoiceRow(env.db, invoiceId);
  const terms = JSON.parse(getContractRow(env.db, inv.contract_id).terms_json) as ContractTerms;
  const m = terms.milestones.find((x) => x.id === inv.milestone_id)!;
  return {
    id: inv.escrow_milestone_id, provider_id: terms.provider_id, title: inv.occurrence === 0 ? m.title : `${m.title} (${inv.number})`,
    client_address: terms.client_address, amount_usd_cents: inv.subtotal_cents, invoice_ref: inv.number,
  };
}

// ---------- payment status, public payload, receipts ----------

/** For the main session's funding path: record that an invoice was paid. Idempotent; the first reference wins. */
export function markInvoicePaid(db: DatabaseSync, invoiceId: string, reference: string, now: Date = new Date()): void {
  getInvoiceRow(db, invoiceId);
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, paid_reference = ? WHERE id = ? AND status <> 'paid'").run(now.toISOString(), reference, invoiceId);
}

/** Convenience for the funding path, which knows the escrow milestone id: marks every invoice linked to it. */
export function markInvoicePaidForMilestone(db: DatabaseSync, escrowMilestoneId: string, reference: string, now: Date = new Date()): number {
  const rows = db.prepare("SELECT id FROM invoices WHERE escrow_milestone_id = ?").all(escrowMilestoneId) as { id: string }[];
  rows.forEach((r) => markInvoicePaid(db, r.id, reference, now));
  return rows.length;
}

/** Public payment payload. Never carries the client's email or wallet address. */
export function payPayload(env: InvoiceEnv, id: string) {
  const inv = getInvoiceRow(env.db, id);
  const url = payUrl(env, inv.id);
  return {
    invoice_id: inv.id, invoice_number: inv.number, provider_name: inv.provider_name,
    amount_usd_cents: inv.total_cents, currency: "USD", due_date: inv.due_date,
    status: isPaid(env.db, inv) ? "paid" : "unpaid", escrow_milestone_id: inv.escrow_milestone_id,
    pay_url: url, qr_data: url, payment_options_endpoint: "/checkout/options",
  };
}

export function receipt(env: InvoiceEnv, id: string) {
  const inv = getInvoiceRow(env.db, id);
  if (!isPaid(env.db, inv)) throw new ApiError(409, "invoice is not paid yet", "NOT_PAID");
  const onchain = env.db.prepare("SELECT token_id, chain_id FROM receipts WHERE milestone_id = ?").get(inv.escrow_milestone_id) as { token_id: number | null; chain_id: number } | undefined;
  return {
    receipt_for: inv.number, invoice_id: inv.id, provider_name: inv.provider_name, client_name: inv.client_name,
    currency: "USD", line_items: JSON.parse(inv.line_items_json),
    subtotal_cents: inv.subtotal_cents, fee_cents: inv.fee_cents, fee_payer: inv.fee_payer, total_paid_cents: inv.total_cents,
    paid_at: inv.paid_at, payment_reference: inv.paid_reference,
    escrow_milestone_id: inv.escrow_milestone_id, escrow_state: milestoneState(env.db, inv.escrow_milestone_id),
    receipt_token_id: onchain?.token_id ?? null, chain_id: onchain?.chain_id ?? null,
  };
}

// ---------- unpaid tracker, reminders ----------

export function listInvoices(env: InvoiceEnv, q: { status?: string | null; provider_id?: string | null }, now: Date = env.now()) {
  const rows = env.db.prepare("SELECT * FROM invoices ORDER BY created_at, seq").all() as unknown as InvoiceRow[];
  if (q.status && q.status !== "unpaid" && q.status !== "paid") throw new ApiError(400, "status must be unpaid or paid");
  return rows
    .filter((r) => !q.provider_id || r.provider_id === q.provider_id)
    .map((r) => ({ ...invoiceView(env, r), days_overdue: daysOverdue(r.due_date, now) }))
    .filter((v) => !q.status || v.status === q.status)
    .map((v) => (v.status === "paid" ? { ...v, days_overdue: 0 } : v));
}

const REMINDER_OFFSET_DAYS: Record<ReminderKind, number> = { before_due: -3, due_today: 0, overdue_7: 7 };

/**
 * Reminders due at `now` for unpaid invoices: 3 days before the due date, on it, and 7 days after. Each kind is
 * recorded once per invoice. If several are already past, only the latest is sent. SIMULATED: nothing is emailed.
 */
export function runReminders(env: InvoiceEnv, now: Date) {
  const out: unknown[] = [];
  const rows = env.db.prepare("SELECT * FROM invoices ORDER BY created_at, seq").all() as unknown as InvoiceRow[];
  for (const inv of rows) {
    if (isPaid(env.db, inv)) continue;
    const due = dayStart(inv.due_date);
    const passed = REMINDER_KINDS.filter((k) => now.getTime() >= due + REMINDER_OFFSET_DAYS[k] * DAY);
    const kind = passed[passed.length - 1];
    if (!kind) continue;
    const r = env.db.prepare("INSERT OR IGNORE INTO invoice_reminders (invoice_id, kind, at) VALUES (?, ?, ?)").run(inv.id, kind, now.toISOString());
    if (Number(r.changes) === 0) continue;
    const overdue = daysOverdue(inv.due_date, now);
    out.push({
      invoice_id: inv.id, invoice_number: inv.number, kind, to_client: inv.client_name, due_date: inv.due_date, days_overdue: overdue,
      amount_usd_cents: inv.total_cents, pay_url: payUrl(env, inv.id), sent_at: now.toISOString(), simulated: true,
      message: kind === "before_due" ? `Invoice ${inv.number} is due on ${inv.due_date}.`
        : kind === "due_today" ? `Invoice ${inv.number} is due today.` : `Invoice ${inv.number} is ${overdue} days overdue.`,
    });
  }
  return { now: now.toISOString(), reminders: out, simulated: true };
}

// ---------- recurring invoices ----------

function addPeriod(base: string, freq: Recurrence["frequency"], k: number): string {
  const [y, mo, d] = base.split("-").map(Number);
  if (freq === "weekly") return day(new Date(Date.UTC(y, mo - 1, d + 7 * k)));
  const total = mo - 1 + k;
  const ty = y + Math.floor(total / 12), tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return day(new Date(Date.UTC(ty, tm, Math.min(d, last))));
}

/**
 * Issue every recurring invoice that is due at `now` and not yet issued. The first occurrence is the milestone's own
 * invoice (created by createInvoice); occurrence k is due base + k periods and is issued RECURRING_LEAD_DAYS before
 * its due date. Idempotent: (milestone, occurrence) is unique.
 */
export function runRecurring(env: InvoiceEnv, now: Date) {
  const issued: unknown[] = [];
  const bases = env.db.prepare("SELECT * FROM invoices WHERE occurrence = 0 ORDER BY created_at, seq").all() as unknown as InvoiceRow[];
  for (const base of bases) {
    const contract = getContractRow(env.db, base.contract_id);
    const terms = JSON.parse(contract.terms_json) as ContractTerms;
    const m = terms.milestones.find((x) => x.id === base.milestone_id);
    const rec = m?.recurrence ?? terms.recurrence;
    if (!m || !rec) continue;
    const taxIds = JSON.parse(base.provider_tax_ids_json) as Record<string, string>;
    for (let k = 1; k < 121; k++) {
      if (rec.count !== undefined && k >= rec.count) break;
      const due = addPeriod(m.due_date, rec.frequency, k);
      if (rec.end_date !== undefined && due > rec.end_date) break;
      if (now.getTime() < dayStart(due) - RECURRING_LEAD_DAYS * DAY) break;
      if (env.db.prepare("SELECT 1 FROM invoices WHERE milestone_id = ? AND occurrence = ?").get(base.milestone_id, k)) continue;
      const row = insertInvoice(env, { contractId: base.contract_id, milestoneId: base.milestone_id, occurrence: k, dueDate: due, feePayer: base.fee_payer, taxIds, now });
      issued.push(invoiceView(env, row));
    }
  }
  return { now: now.toISOString(), issued };
}

export function parseNow(body: any, fallback: Date): Date {
  if (body?.now === undefined) return fallback;
  const d = typeof body.now === "string" ? new Date(body.now) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "now must be an ISO timestamp");
  return d;
}

