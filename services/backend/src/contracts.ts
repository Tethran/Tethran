// Contracts and milestone schedules (PRD M1, FR-1.1 to FR-1.3). Off-chain only: no chain access, no Stripe.
// A contract is signed off-chain with EIP-712 (no chain id: it is a document, not a transaction). Once both
// parties have signed the same hash the terms are frozen. A contract milestone becomes an escrow milestone
// when the main session posts activateMilestone()'s body to POST /milestones; from then on its state is the
// state of the row in the existing `milestones` table with the same id.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getAddress, isAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { requireCountryProfile } from "./countryProfiles";
import { ApiError } from "./errors";

export type Party = "provider" | "client";
export type Recurrence = { frequency: "monthly" | "weekly"; count?: number; end_date?: string };

export const CONTRACT_DOMAIN = { name: "TethranContract", version: "1" } as const;
export const CONTRACT_TYPES = { ContractSignature: [{ name: "contractHash", type: "bytes32" }, { name: "party", type: "string" }] } as const;
export const HASH_ALGORITHM = "keccak256";
export const OFFCHAIN_STATES = ["draft", "funded", "in_review", "approved", "disputed", "released", "paid_out", "refunded"] as const;

export interface MilestoneTerms {
  id: string;
  title: string;
  amount_usd_cents: number;
  acceptance_criteria: string;
  due_date: string; // YYYY-MM-DD
  recurrence?: Recurrence;
}

export interface ContractTerms {
  provider_id: string;
  provider_name: string;
  provider_address: string;
  client_name: string;
  client_email?: string;
  client_address: string;
  currency: "USD";
  country: string;
  recurrence?: Recurrence;
  milestones: MilestoneTerms[];
}

/** Create the tables this module and invoices.ts own. Safe to call more than once. */
export function migrateContracts(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, terms_json TEXT NOT NULL, contract_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, signed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contract_milestones (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
      amount_usd_cents INTEGER NOT NULL, acceptance_criteria TEXT NOT NULL, due_date TEXT NOT NULL,
      recurrence_json TEXT
    );
    CREATE INDEX IF NOT EXISTS contract_milestones_contract ON contract_milestones (contract_id, idx);
    CREATE TABLE IF NOT EXISTS contract_signatures (
      contract_id TEXT NOT NULL, party TEXT NOT NULL, signer TEXT NOT NULL, signature TEXT NOT NULL,
      contract_hash TEXT NOT NULL, signed_at TEXT NOT NULL, PRIMARY KEY (contract_id, party)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, contract_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
      occurrence INTEGER NOT NULL DEFAULT 0, escrow_milestone_id TEXT NOT NULL,
      number TEXT NOT NULL, seq INTEGER NOT NULL, year INTEGER NOT NULL, country TEXT NOT NULL,
      currency TEXT NOT NULL, provider_name TEXT NOT NULL, client_name TEXT NOT NULL,
      provider_tax_ids_json TEXT NOT NULL, missing_fields_json TEXT NOT NULL, line_items_json TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, payout_cents INTEGER NOT NULL,
      fee_payer TEXT NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid', paid_at TEXT, paid_reference TEXT, created_at TEXT NOT NULL,
      UNIQUE (milestone_id, occurrence), UNIQUE (provider_id, number)
    );
    CREATE TABLE IF NOT EXISTS invoice_counters (
      provider_id TEXT NOT NULL, year INTEGER NOT NULL, last_seq INTEGER NOT NULL, PRIMARY KEY (provider_id, year)
    );
    CREATE TABLE IF NOT EXISTS invoice_reminders (
      invoice_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (invoice_id, kind)
    );
  `);
}

// ---------- canonical hash ----------

/** JSON with sorted keys at every level and no undefined values. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, norm(val)]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** keccak256 over the UTF-8 canonical JSON of the terms. Terms hold no timestamps or signatures. */
export function contractHash(terms: ContractTerms): string {
  return keccak256(toUtf8Bytes(canonicalJson(terms)));
}

// ---------- validation ----------

const bad = (msg: string): never => { throw new ApiError(400, msg); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s: unknown): s is string {
  return typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);
}
const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || v.trim().length === 0) bad(`${field} is required`);
  if ((v as string).length > max) bad(`${field} is too long (max ${max})`);
  return (v as string).trim();
};
const addr = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !isAddress(v)) bad(`${field} must be an EVM address`);
  return getAddress(v as string);
};

function parseRecurrence(v: unknown, field: string): Recurrence | undefined {
  if (v === undefined || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r !== "object" || (r.frequency !== "monthly" && r.frequency !== "weekly")) bad(`${field}.frequency must be monthly or weekly`);
  const out: Recurrence = { frequency: r.frequency as "monthly" | "weekly" };
  if (r.count !== undefined) {
    if (!Number.isInteger(r.count) || (r.count as number) < 2 || (r.count as number) > 120) bad(`${field}.count must be an integer from 2 to 120 (the first invoice counts)`);
    out.count = r.count as number;
  }
  if (r.end_date !== undefined) {
    if (!validDate(r.end_date)) bad(`${field}.end_date must be YYYY-MM-DD`);
    out.end_date = r.end_date as string;
  }
  if (out.count === undefined && out.end_date === undefined) bad(`${field} needs a count or an end_date`);
  return out;
}

/** Validate a create or replace body into canonical terms. Milestone ids are kept when given, else generated. */
export function parseTerms(body: any): ContractTerms {
  if (!body || typeof body !== "object") bad("body is required");
  const provider_id = text(body.provider_id, "provider_id", 100);
  const provider_address = addr(body.provider_address, "provider_address");
  const client_address = addr(body.client_address, "client_address");
  if (provider_address === client_address) bad("provider and client must be different wallets");
  const client_name = text(body.client_name, "client_name", 200);
  let client_email: string | undefined;
  if (body.client_email !== undefined && body.client_email !== null && body.client_email !== "") {
    client_email = text(body.client_email, "client_email", 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client_email)) bad("client_email is not an email address");
  }
  if (body.currency !== "USD") bad('currency must be "USD"');
  const country = requireCountryProfile(body.country).code;
  const provider_name = body.provider_name === undefined ? provider_id : text(body.provider_name, "provider_name", 200);
  const recurrence = parseRecurrence(body.recurrence, "recurrence");
  if (!Array.isArray(body.milestones) || body.milestones.length === 0) bad("milestones must be a non-empty array");
  if (body.milestones.length > 50) bad("at most 50 milestones");
  const seen = new Set<string>();
  const milestones = body.milestones.map((m: any, i: number): MilestoneTerms => {
    const f = `milestones[${i}]`;
    if (!m || typeof m !== "object") bad(`${f} must be an object`);
    if (!Number.isSafeInteger(m.amount_usd_cents) || m.amount_usd_cents <= 0) bad(`${f}.amount_usd_cents must be a positive integer (USD cents)`);
    if (!validDate(m.due_date)) bad(`${f}.due_date must be YYYY-MM-DD`);
    let id = randomUUID();
    if (m.id !== undefined) {
      if (typeof m.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.id)) bad(`${f}.id must be a UUID`);
      id = m.id.toLowerCase();
    }
    if (seen.has(id)) bad(`${f}.id is repeated`);
    seen.add(id);
    const rec = parseRecurrence(m.recurrence, `${f}.recurrence`);
    return {
      id, title: text(m.title, `${f}.title`, 200), amount_usd_cents: m.amount_usd_cents,
      acceptance_criteria: text(m.acceptance_criteria, `${f}.acceptance_criteria`, 5000), due_date: m.due_date,
      ...(rec ? { recurrence: rec } : {}),
    };
  });
  return {
    provider_id, provider_name, provider_address, client_name, ...(client_email ? { client_email } : {}),
    client_address, currency: "USD", country, ...(recurrence ? { recurrence } : {}), milestones,
  };
}

// ---------- storage ----------

interface ContractRow { id: string; provider_id: string; terms_json: string; contract_hash: string; status: "draft" | "signed"; created_at: string; signed_at: string | null }

export function getContractRow(db: DatabaseSync, id: string): ContractRow {
  const row = db.prepare("SELECT * FROM contracts WHERE id = ?").get(id) as ContractRow | undefined;
  if (!row) throw new ApiError(404, "contract not found");
  return row;
}

export function contractTerms(db: DatabaseSync, id: string): ContractTerms {
  return JSON.parse(getContractRow(db, id).terms_json) as ContractTerms;
}

function writeMilestones(db: DatabaseSync, contractId: string, terms: ContractTerms) {
  db.prepare("DELETE FROM contract_milestones WHERE contract_id = ?").run(contractId);
  const ins = db.prepare("INSERT INTO contract_milestones (id, contract_id, idx, title, amount_usd_cents, acceptance_criteria, due_date, recurrence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  terms.milestones.forEach((m, i) => ins.run(m.id, contractId, i, m.title, m.amount_usd_cents, m.acceptance_criteria, m.due_date, m.recurrence ? JSON.stringify(m.recurrence) : null));
}

export function createContract(db: DatabaseSync, body: unknown, now: Date): ReturnType<typeof getContract> {
  const terms = parseTerms(body);
  for (const m of terms.milestones) {
    if (db.prepare("SELECT 1 FROM contract_milestones WHERE id = ?").get(m.id)) throw new ApiError(409, "a milestone id is already used by another contract");
  }
  const id = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO contracts (id, provider_id, terms_json, contract_hash, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)")
      .run(id, terms.provider_id, canonicalJson(terms), contractHash(terms), now.toISOString());
    writeMilestones(db, id, terms);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getContract(db, id);
}

/** Replace the terms of a draft contract. Refused once signed. Any earlier signature is dropped (the hash changed). */
export function updateContract(db: DatabaseSync, id: string, body: any): ReturnType<typeof getContract> {
  const row = getContractRow(db, id);
  if (row.status === "signed") throw new ApiError(409, "contract is signed; its terms are frozen", "TERMS_FROZEN");
  const current = JSON.parse(row.terms_json) as ContractTerms;
  const terms = parseTerms({ ...current, ...(body ?? {}) });
  for (const m of terms.milestones) {
    const owner = db.prepare("SELECT contract_id FROM contract_milestones WHERE id = ?").get(m.id) as { contract_id: string } | undefined;
    if (owner && owner.contract_id !== id) throw new ApiError(409, "a milestone id is already used by another contract");
  }
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE contracts SET terms_json = ?, contract_hash = ? WHERE id = ?").run(canonicalJson(terms), contractHash(terms), id);
    db.prepare("DELETE FROM contract_signatures WHERE contract_id = ?").run(id);
    writeMilestones(db, id, terms);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getContract(db, id);
}

// ---------- state mapping (docs/INTERFACES.md section 0) ----------

/** The state of a contract milestone: the escrow milestone row with the same id, else `draft`. */
export function milestoneState(db: DatabaseSync, milestoneId: string): (typeof OFFCHAIN_STATES)[number] {
  const row = db.prepare("SELECT state FROM milestones WHERE id = ?").get(milestoneId) as { state: string } | undefined;
  return (row?.state as (typeof OFFCHAIN_STATES)[number] | undefined) ?? "draft";
}

export function listContractMilestones(db: DatabaseSync, contractId: string) {
  const row = getContractRow(db, contractId);
  const terms = JSON.parse(row.terms_json) as ContractTerms;
  const rows = db.prepare("SELECT * FROM contract_milestones WHERE contract_id = ? ORDER BY idx").all(contractId) as any[];
  return rows.map((r) => {
    const own: Recurrence | undefined = r.recurrence_json ? JSON.parse(r.recurrence_json) : undefined;
    const inv = db.prepare("SELECT id, number FROM invoices WHERE milestone_id = ? AND occurrence = 0").get(r.id) as { id: string; number: string } | undefined;
    return {
      id: r.id as string, contract_id: contractId, index: r.idx as number, title: r.title as string,
      amount_usd_cents: r.amount_usd_cents as number, acceptance_criteria: r.acceptance_criteria as string, due_date: r.due_date as string,
      recurrence: own ?? terms.recurrence ?? null,
      state: milestoneState(db, r.id),
      invoice_id: inv?.id ?? null, invoice_number: inv?.number ?? null,
    };
  });
}

export function getContract(db: DatabaseSync, id: string) {
  const row = getContractRow(db, id);
  const terms = JSON.parse(row.terms_json) as ContractTerms;
  const signatures = db.prepare("SELECT party, signer, signature, signed_at FROM contract_signatures WHERE contract_id = ? ORDER BY party").all(id);
  const { milestones: _ignored, ...rest } = terms;
  return {
    id: row.id, status: row.status, ...rest,
    contract_hash: row.contract_hash, hash_algorithm: HASH_ALGORITHM,
    signatures, created_at: row.created_at, signed_at: row.signed_at,
    milestones: listContractMilestones(db, id),
  };
}

// ---------- signing ----------

export function signingPayload(db: DatabaseSync, id: string, party: Party) {
  const row = getContractRow(db, id);
  return {
    domain: CONTRACT_DOMAIN, types: CONTRACT_TYPES, primaryType: "ContractSignature",
    message: { contractHash: row.contract_hash, party },
  };
}

export function signContract(db: DatabaseSync, id: string, body: any, now: Date) {
  const row = getContractRow(db, id);
  const terms = JSON.parse(row.terms_json) as ContractTerms;
  const party = body?.party;
  if (party !== "provider" && party !== "client") throw new ApiError(400, 'party must be "provider" or "client"');
  const expected = party === "provider" ? terms.provider_address : terms.client_address;
  const signer = addr(body?.signer, "signer");
  if (typeof body?.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) throw new ApiError(400, "signature must be a 65-byte hex signature");
  if (signer !== expected) throw new ApiError(400, `signer is not the ${party} wallet of this contract`, "WRONG_SIGNER");
  let recovered: string;
  try {
    recovered = verifyTypedData(CONTRACT_DOMAIN, CONTRACT_TYPES as any, { contractHash: row.contract_hash, party }, body.signature);
  } catch {
    throw new ApiError(400, "signature is not valid", "BAD_SIGNATURE");
  }
  if (recovered !== expected) throw new ApiError(400, "signature does not recover to the party wallet for this contract hash", "BAD_SIGNATURE");

  db.exec("BEGIN");
  try {
    // Idempotent: a party that already signed this hash keeps its first signature and signed_at.
    db.prepare("INSERT OR IGNORE INTO contract_signatures (contract_id, party, signer, signature, contract_hash, signed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, party, signer, body.signature, row.contract_hash, now.toISOString());
    const n = (db.prepare("SELECT COUNT(*) AS n FROM contract_signatures WHERE contract_id = ? AND contract_hash = ?").get(id, row.contract_hash) as { n: number }).n;
    if (n === 2 && row.status !== "signed") db.prepare("UPDATE contracts SET status = 'signed', signed_at = ? WHERE id = ?").run(now.toISOString(), id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getContract(db, id);
}
