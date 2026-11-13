// Payout adapters for the OFF-CHAIN leg of a payout (PRD M8, INTERFACES section 6).
//
// SIMULATED: everything about mobile money (M-Pesa, MTN MoMo, Airtel), bank transfers, fees, FX rates and delivery
// times in this file is simulated. No external call is made, no real money moves. The on-chain leg (the vault pays
// the rail's deposit wallet) is done by the orchestrator, which writes `payouts` rows. The adapters here take over
// after that and report a deterministic confirmation status: pending -> processing -> delivered | failed.
//
// Determinism: the status is a pure function of the injected clock and the reference (plus a demo "advance" bonus),
// so the demo and the tests repeat exactly. A failure can be forced with `fail: "timeout" | "rejected"` or with a
// magic amount (MAGIC_FAIL_TIMEOUT / MAGIC_FAIL_REJECTED).
import { fxLabel, SAMPLE_RATES_MICRO, type FxService } from "./fx";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError, bad } from "./errors";

export type Rail = "usdt" | "mpesa" | "mtn_momo" | "airtel" | "bank";
export const RAILS: Rail[] = ["usdt", "mpesa", "mtn_momo", "airtel", "bank"];
export type FailMode = "timeout" | "rejected";
export type LegStatus = "pending" | "processing" | "delivered" | "failed";

/** Demo triggers: paying exactly these base-unit amounts forces a failure (13.13 and 13.14 test USDT). */
export const MAGIC_FAIL_TIMEOUT = "13130000";
export const MAGIC_FAIL_REJECTED = "13140000";

/** Seconds after initiation at which a leg moves from pending to processing (simulated). */
export const PROCESSING_AFTER_SECONDS = 5;

export interface PayoutRequest {
  rail: Rail;
  /** Base units of USDT (6 decimals), as a string. */
  amount: string;
  country?: string;
  /** Free text label of the destination (never a secret); simulated rails do not use it. */
  destination?: string;
  fail?: FailMode;
  /** The milestone this payout settles: its exchange rate is the one locked when the milestone was created (fx.ts). */
  milestone_id?: string;
}

export interface Quote {
  simulated: true;
  rail: Rail;
  country: string;
  amount: string;
  /** Simulated fee, shown separately and deducted from the amount. Base units. */
  fee: string;
  net_amount: string;
  /**
   * The rate is an indicative market rate (fx.ts: ExchangeRate-API, cached, locked per milestone), not simulated; the
   * conversion and the payout leg remain SIMULATED. source "sample" means no real rate was available.
   */
  fx: { simulated: false; indicative: boolean; label: string; source: string; last_updated: string | null; attribution: { text: string; url: string } | null; base: "USDT"; quote: string; rate: string };
  /** What the recipient receives in local currency, 2 decimals (simulated FX on net_amount). */
  local_amount: string;
  currency: string;
  expected_seconds: number;
  expected: string;
}

export interface PayoutRef {
  simulated: true;
  adapter: string;
  rail: Rail;
  reference: string;
  initiated_at: string;
  amount: string;
  fee: string;
  net_amount: string;
  local_amount: string;
  currency: string;
  country: string;
  fx_rate: string;
  expected_seconds: number;
  fail?: FailMode;
  /** Demo accelerator: seconds added to the elapsed time (see advanceBonus). */
  bonus_seconds?: number;
}

export interface PayoutStatus {
  simulated: true;
  status: LegStatus;
  reason?: string;
  delivered_at?: string;
}

export interface PayoutAdapter {
  quote(req: PayoutRequest): Promise<Quote>;
  initiate(req: PayoutRequest, idempotencyKey: string): Promise<PayoutRef>;
  status(ref: PayoutRef): Promise<PayoutStatus>;
}

// ---- simulated price list ----

/** The local currency of each corridor. The rate comes from fx.ts (indicative rates, or the sample table without it). */
const CURRENCY: Record<string, string> = { KE: "KES", GH: "GHS", UG: "UGX", NG: "NGN", TZ: "TZS", ZA: "ZAR" };

interface RailSpec {
  adapter: string;
  label: string;
  countries: string[]; // first is the default
  feeBps: bigint;
  minFee: bigint;
  expectedSeconds: number;
}
const SPECS: Record<Exclude<Rail, "usdt">, RailSpec> = {
  mpesa: { adapter: "MobileMoneySim", label: "M-Pesa (simulated)", countries: ["KE", "TZ"], feeBps: 150n, minFee: 0n, expectedSeconds: 30 },
  mtn_momo: { adapter: "MobileMoneySim", label: "MTN MoMo (simulated)", countries: ["GH", "UG"], feeBps: 100n, minFee: 0n, expectedSeconds: 60 },
  airtel: { adapter: "MobileMoneySim", label: "Airtel Money (simulated)", countries: ["UG", "KE", "TZ"], feeBps: 120n, minFee: 0n, expectedSeconds: 60 },
  bank: { adapter: "BankSim", label: "Bank transfer (simulated)", countries: ["NG", "KE", "GH", "UG", "TZ", "ZA"], feeBps: 50n, minFee: 1_000_000n, expectedSeconds: 600 },
};

export function validAmount(amount: unknown): string {
  if (typeof amount !== "string" || !/^[1-9]\d{0,29}$/.test(amount)) return bad("amount must be a string of base units (6 decimals), greater than zero");
  return amount;
}

/** Truncates a 6-decimal fixed-point bigint to a 2-decimal string. */
export function formatMicro(v: bigint, places = 2): string {
  const s = v.toString().padStart(7, "0");
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).slice(0, places);
  return places > 0 ? `${whole}.${frac}` : whole;
}

function secondsText(s: number): string {
  if (s === 0) return "immediate, once the on-chain transfer confirms";
  if (s < 120) return `about ${s} seconds (simulated)`;
  return `about ${Math.round(s / 60)} minutes (simulated)`;
}

function quoteFor(req: PayoutRequest, fx?: FxService): Quote {
  const amount = validAmount(req.amount);
  const a = BigInt(amount);
  if (req.rail === "usdt") {
    return {
      simulated: true, rail: "usdt", country: (req.country ?? "").toUpperCase() || "ANY", amount, fee: "0", net_amount: amount,
      fx: { simulated: false, indicative: false, label: "USDT is delivered as USDT; no conversion", source: "none", last_updated: null, attribution: null, base: "USDT", quote: "USDT", rate: "1.000000" },
      local_amount: formatMicro(a), currency: "USDT", expected_seconds: 0, expected: secondsText(0),
    };
  }
  const spec = SPECS[req.rail];
  if (!spec) return bad(`unknown rail "${String(req.rail)}"`);
  const country = (req.country ?? spec.countries[0]).toUpperCase();
  if (!spec.countries.includes(country)) return bad(`${req.rail} is not available in ${country} (simulated: ${spec.countries.join(", ")})`);
  const currency = CURRENCY[country];
  const r = fx ? fx.rateFor(currency, req.milestone_id) : { rateMicro: SAMPLE_RATES_MICRO[currency], label: fxLabel("sample", null), source: "sample", lastUpdated: null, attribution: null };
  let fee = (a * spec.feeBps) / 10_000n;
  if (fee < spec.minFee) fee = spec.minFee;
  if (fee >= a) return bad("amount is not enough to cover the simulated fee");
  const net = a - fee;
  const local = (net * r.rateMicro) / 1_000_000n;
  return {
    simulated: true, rail: req.rail, country, amount, fee: fee.toString(), net_amount: net.toString(),
    fx: { simulated: false, indicative: r.source !== "sample", label: `${r.label}: 1 USDT = ${formatMicro(r.rateMicro, 2)} ${currency}`, source: r.source, last_updated: r.lastUpdated, attribution: r.attribution ? { ...r.attribution } : null, base: "USDT", quote: currency, rate: formatMicro(r.rateMicro, 6) },
    local_amount: formatMicro(local), currency, expected_seconds: spec.expectedSeconds, expected: secondsText(spec.expectedSeconds),
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Seconds elapsed since initiation, including the demo bonus. */
function elapsedSeconds(ref: PayoutRef, now: Date): number {
  return Math.floor((now.getTime() - new Date(ref.initiated_at).getTime()) / 1000) + (ref.bonus_seconds ?? 0);
}

/** Pure status function: same reference and clock give the same status. */
export function statusOf(ref: PayoutRef, now: Date): PayoutStatus {
  if (ref.rail === "usdt") return { simulated: true, status: "delivered", delivered_at: ref.initiated_at };
  const e = elapsedSeconds(ref, now);
  if (e < PROCESSING_AFTER_SECONDS) return { simulated: true, status: "pending" };
  if (e < ref.expected_seconds) return { simulated: true, status: "processing" };
  const doneAt = new Date(new Date(ref.initiated_at).getTime() + Math.max(0, ref.expected_seconds - (ref.bonus_seconds ?? 0)) * 1000).toISOString();
  if (ref.fail === "timeout") return { simulated: true, status: "failed", reason: "provider timeout (simulated)" };
  if (ref.fail === "rejected") return { simulated: true, status: "failed", reason: "rejected by the recipient's provider (simulated)" };
  return { simulated: true, status: "delivered", delivered_at: doneAt };
}

/** The bonus (seconds) that moves a leg one step forward: pending -> processing -> terminal. Terminal: unchanged. */
export function advanceBonus(ref: PayoutRef, now: Date): number {
  const current = ref.bonus_seconds ?? 0;
  const base = elapsedSeconds(ref, now) - current;
  const s = statusOf(ref, now).status;
  if (s === "pending") return PROCESSING_AFTER_SECONDS - base;
  if (s === "processing") return ref.expected_seconds - base;
  return current;
}

function makeAdapter(rail: Rail, now: () => Date, fx?: FxService): PayoutAdapter {
  const seen = new Map<string, PayoutRef>();
  const adapterName = rail === "usdt" ? "UsdtSim" : SPECS[rail].adapter;
  return {
    async quote(req) {
      return quoteFor({ ...req, rail }, fx);
    },
    async initiate(req, idempotencyKey) {
      if (!idempotencyKey) return bad("idempotency key is required");
      const prior = seen.get(idempotencyKey);
      if (prior) return prior;
      const q = quoteFor({ ...req, rail }, fx);
      const fail = rail === "usdt" ? undefined
        : req.fail ?? (req.amount === MAGIC_FAIL_TIMEOUT ? "timeout" : req.amount === MAGIC_FAIL_REJECTED ? "rejected" : undefined);
      const ref: PayoutRef = {
        simulated: true, adapter: adapterName, rail,
        reference: `SIM-${rail.toUpperCase()}-${sha(`${rail}:${idempotencyKey}`).slice(0, 12).toUpperCase()}`,
        initiated_at: now().toISOString(), amount: q.amount, fee: q.fee, net_amount: q.net_amount, local_amount: q.local_amount,
        currency: q.currency, country: q.country, fx_rate: q.fx.rate, expected_seconds: q.expected_seconds, ...(fail ? { fail } : {}),
      };
      seen.set(idempotencyKey, ref);
      return ref;
    },
    async status(ref) {
      return statusOf(ref, now());
    },
  };
}

/** One adapter per rail: MobileMoneySim (mpesa, mtn_momo, airtel), BankSim, UsdtSim. All simulated. */
/** The rate service the payout quotes use (fx.ts). Set once by main.ts; without it quotes use the sample table. */
let defaultFx: FxService | undefined;
export function usePayoutFx(fx: FxService | undefined) { defaultFx = fx; }

export function createAdapters(now: () => Date, fx: FxService | undefined = defaultFx): Record<Rail, PayoutAdapter> {
  return {
    usdt: makeAdapter("usdt", now, fx), mpesa: makeAdapter("mpesa", now, fx), mtn_momo: makeAdapter("mtn_momo", now, fx),
    airtel: makeAdapter("airtel", now, fx), bank: makeAdapter("bank", now, fx),
  };
}
export const MobileMoneySim = (rail: "mpesa" | "mtn_momo" | "airtel", now: () => Date) => makeAdapter(rail, now);
export const BankSim = (now: () => Date) => makeAdapter("bank", now);
export const UsdtSim = (now: () => Date) => makeAdapter("usdt", now);

// ---- storage of the off-chain legs ----

export function migratePayouts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS offchain_payouts (
      payout_id INTEGER PRIMARY KEY, milestone_id TEXT NOT NULL, adapter TEXT NOT NULL, rail TEXT NOT NULL,
      provider_ref TEXT NOT NULL UNIQUE, status TEXT NOT NULL, reason TEXT, amount TEXT NOT NULL, fee TEXT NOT NULL,
      net_amount TEXT NOT NULL, local_amount TEXT NOT NULL, currency TEXT NOT NULL, country TEXT NOT NULL, fx_rate TEXT NOT NULL,
      expected_seconds INTEGER NOT NULL, fail_mode TEXT, bonus_seconds INTEGER NOT NULL DEFAULT 0,
      initiated_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT, simulated INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS offchain_payouts_milestone ON offchain_payouts (milestone_id);
  `);
}

export interface OffchainRow {
  payout_id: number; milestone_id: string; adapter: string; rail: Rail; provider_ref: string; status: LegStatus;
  reason: string | null; amount: string; fee: string; net_amount: string; local_amount: string; currency: string; country: string;
  fx_rate: string; expected_seconds: number; fail_mode: FailMode | null; bonus_seconds: number; initiated_at: string;
  updated_at: string; delivered_at: string | null; simulated: number;
}
interface PayoutRow {
  id: number; plan_id: number; milestone_id: string; action_index: number; action_id: string; payee_id: string; rail: string;
  to_address: string; amount: string; chain_id: number; tx: string | null; status: string; simulated: number; at: string;
}

const refOf = (r: OffchainRow): PayoutRef => ({
  simulated: true, adapter: r.adapter, rail: r.rail, reference: r.provider_ref, initiated_at: r.initiated_at, amount: r.amount, fee: r.fee,
  net_amount: r.net_amount, local_amount: r.local_amount, currency: r.currency, country: r.country, fx_rate: r.fx_rate,
  expected_seconds: r.expected_seconds, ...(r.fail_mode ? { fail: r.fail_mode } : {}), bonus_seconds: r.bonus_seconds,
});

export interface ProcessOptions {
  adapters?: Record<Rail, PayoutAdapter>;
  /** Demo hook: force a failure for a given on-chain payout row. */
  fail?: (p: { id: number; rail: string; amount: string }) => FailMode | undefined;
}

export function legOf(db: DatabaseSync, payoutId: number): OffchainRow | undefined {
  return db.prepare("SELECT * FROM offchain_payouts WHERE payout_id = ?").get(payoutId) as OffchainRow | undefined;
}

/** Re-reads the status from the adapter rule and stores it. Terminal statuses never change. */
export function refreshLeg(db: DatabaseSync, row: OffchainRow, now: Date): OffchainRow {
  if (row.status === "delivered" || row.status === "failed") return row;
  const s = statusOf(refOf(row), now);
  if (s.status !== row.status) {
    db.prepare("UPDATE offchain_payouts SET status = ?, reason = ?, delivered_at = ?, updated_at = ? WHERE payout_id = ?")
      .run(s.status, s.reason ?? null, s.delivered_at ?? null, now.toISOString(), row.payout_id);
  }
  return legOf(db, row.payout_id)!;
}

/**
 * For every CONFIRMED on-chain payout without an off-chain leg: initiates the adapter for its rail and records the
 * leg (simulated). Idempotent: a payout gets one leg, keyed by the payout id. Also refreshes legs still in flight.
 */
export async function processConfirmedPayouts(db: DatabaseSync, now: () => Date, opts: ProcessOptions = {}) {
  const adapters = opts.adapters ?? createAdapters(now);
  const todo = db.prepare(
    `SELECT p.* FROM payouts p LEFT JOIN offchain_payouts o ON o.payout_id = p.id
     WHERE p.status = 'confirmed' AND o.payout_id IS NULL AND p.payee_id != 'tethran_earnings' ORDER BY p.id`,
  ).all() as unknown as PayoutRow[];
  const initiated: number[] = [];
  for (const p of todo) {
    const rail = p.rail as Rail;
    const adapter = adapters[rail];
    if (!adapter) continue; // unknown rail: left for the failure queue (no off-chain leg)
    const ref = await adapter.initiate({ rail, amount: p.amount, fail: opts.fail?.(p), milestone_id: p.milestone_id }, `offchain:${p.id}`);
    const t = now().toISOString();
    const r = db.prepare(
      `INSERT OR IGNORE INTO offchain_payouts (payout_id, milestone_id, adapter, rail, provider_ref, status, amount, fee, net_amount, local_amount,
         currency, country, fx_rate, expected_seconds, fail_mode, bonus_seconds, initiated_at, updated_at, simulated)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`,
    ).run(p.id, p.milestone_id, ref.adapter, rail, ref.reference, ref.amount, ref.fee, ref.net_amount, ref.local_amount, ref.currency,
      ref.country, ref.fx_rate, ref.expected_seconds, ref.fail ?? null, ref.initiated_at, t);
    if (Number(r.changes) > 0) initiated.push(p.id);
  }
  const inFlight = db.prepare("SELECT * FROM offchain_payouts WHERE status IN ('pending', 'processing')").all() as unknown as OffchainRow[];
  for (const row of inFlight) refreshLeg(db, row, now());
  return { initiated, count: initiated.length, simulated: true as const };
}

// ---- views and routes ----

function view(db: DatabaseSync, p: PayoutRow, now: Date) {
  let leg = legOf(db, p.id);
  if (leg) leg = refreshLeg(db, leg, now);
  return {
    id: p.id, milestone_id: p.milestone_id, payee_id: p.payee_id, rail: p.rail, amount: p.amount, to_address: p.to_address,
    chain_id: p.chain_id, tx: p.tx, onchain_status: p.status, onchain_simulated: p.simulated === 1, at: p.at,
    offchain: leg ? {
      simulated: true, adapter: leg.adapter, provider_ref: leg.provider_ref, status: leg.status, reason: leg.reason,
      fee: leg.fee, net_amount: leg.net_amount, local_amount: leg.local_amount, currency: leg.currency, country: leg.country,
      fx_rate: leg.fx_rate, expected_seconds: leg.expected_seconds, initiated_at: leg.initiated_at, updated_at: leg.updated_at,
      delivered_at: leg.delivered_at,
    } : null,
  };
}

type Ctx = { params: Record<string, string>; body: any; url: URL };
type Handler = (ctx: Ctx) => Promise<unknown>;

export interface PayoutDeps {
  db: DatabaseSync;
  now: () => Date;
  adapters?: Record<Rail, PayoutAdapter>;
}

export function payoutRoutes(deps: PayoutDeps): [string, RegExp, Handler][] {
  const { db, now } = deps;
  const adapters = deps.adapters ?? createAdapters(now);
  const get = (id: string): PayoutRow => {
    if (!/^\d+$/.test(id)) throw new ApiError(400, "payout id must be a number");
    const p = db.prepare("SELECT * FROM payouts WHERE id = ?").get(Number(id)) as PayoutRow | undefined;
    if (!p) throw new ApiError(404, "payout not found");
    return p;
  };
  return [
    ["GET", /^\/payouts$/, async ({ url }) => {
      const mid = url.searchParams.get("milestone_id");
      const rows = (mid
        ? db.prepare("SELECT * FROM payouts WHERE milestone_id = ? ORDER BY id").all(mid)
        : db.prepare("SELECT * FROM payouts ORDER BY id").all()) as unknown as PayoutRow[];
      return { simulated: true, payouts: rows.map((p) => view(db, p, now())) };
    }],
    ["POST", /^\/payouts\/quote$/, async ({ body }) => {
      const rail = body?.rail as Rail;
      if (!RAILS.includes(rail)) throw new ApiError(400, `rail must be one of ${RAILS.join(", ")}`);
      return adapters[rail].quote({ rail, amount: body?.amount, country: typeof body?.country === "string" ? body.country : undefined });
    }],
    ["GET", /^\/payouts\/([^/]+)$/, async ({ params }) => view(db, get(params[1]), now())],
    ["POST", /^\/payouts\/([^/]+)\/status$/, async ({ params, body }) => {
      const p = get(params[1]);
      if (p.status !== "confirmed") throw new ApiError(409, `on-chain payout is ${p.status}; the off-chain leg starts after it confirms`, "NOT_CONFIRMED");
      const fail = body?.fail;
      if (fail !== undefined && fail !== "timeout" && fail !== "rejected") throw new ApiError(400, 'fail must be "timeout" or "rejected"');
      await processConfirmedPayouts(db, now, { adapters, fail: (x) => (x.id === p.id ? fail : undefined) });
      let leg = legOf(db, p.id);
      if (!leg) throw new ApiError(409, `no off-chain adapter for rail ${p.rail}`, "NO_ADAPTER");
      // Demo controls (simulated): force a failure before the leg finishes, or move one step forward.
      if (fail && leg.status !== "delivered" && leg.status !== "failed") {
        db.prepare("UPDATE offchain_payouts SET fail_mode = ? WHERE payout_id = ?").run(fail, p.id);
        leg = legOf(db, p.id)!;
      }
      if (body?.advance === true) {
        const bonus = advanceBonus(refOf(leg), now());
        db.prepare("UPDATE offchain_payouts SET bonus_seconds = ? WHERE payout_id = ?").run(bonus, p.id);
        leg = legOf(db, p.id)!;
      }
      refreshLeg(db, leg, now());
      return view(db, p, now());
    }],
  ];
}
