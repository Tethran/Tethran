// Backend storage (SQLite through node:sqlite). Tables follow docs/INTERFACES.md section 5.
// Amounts are strings in base units. Times are ISO strings. Nothing here holds a key.
import { DatabaseSync } from "node:sqlite";

export type MilestoneState =
  | "draft" | "funded" | "in_review" | "approved" | "disputed" | "released" | "paid_out" | "refunded";

export type FundingSource = "card" | "stablecoin";

export interface MilestoneRow {
  id: string;               // UUID; the escrow id is keccak256 of it
  provider_id: string;
  title: string;
  client_address: string;
  provider_address: string;
  arbiter_address: string;
  vault: string;
  amount: string;           // USDT base units
  amount_usd_cents: number; // what the client pays in USD (fiat to USDT conversion is SIMULATED at 1:1)
  timeout: number;          // unix seconds
  funding_source: FundingSource | null;
  card_funded: number;      // 0 or 1
  hold_seconds: number;
  chain_id: number;
  state: MilestoneState;
  escrow_tx: string | null;
  release_tx: string | null;
  invoice_ref: string;
  /** Seeded demo scenario this milestone stands for (selects the saved proposal in replay mode). */
  scenario?: string | null;
  created_at: string;
}

export interface PayeeRow {
  payee_id: string;
  provider_id: string;
  name: string;
  address: string;     // on-chain address; for a simulated rail, the rail's deposit wallet
  rail: string;        // usdt | mpesa | mtn_momo | airtel | bank
  simulated: number;   // 1 for simulated rails
  verified_name: string | null;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS vaults (
      provider_id TEXT NOT NULL, chain_id INTEGER NOT NULL, vault TEXT NOT NULL,
      operator TEXT NOT NULL, provider_payout TEXT NOT NULL,
      PRIMARY KEY (provider_id, chain_id)
    );
    CREATE TABLE IF NOT EXISTS payees (
      payee_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL,
      rail TEXT NOT NULL, simulated INTEGER NOT NULL, verified_name TEXT
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, title TEXT NOT NULL,
      client_address TEXT NOT NULL, provider_address TEXT NOT NULL, arbiter_address TEXT NOT NULL, vault TEXT NOT NULL,
      amount TEXT NOT NULL, amount_usd_cents INTEGER NOT NULL, timeout INTEGER NOT NULL,
      funding_source TEXT, card_funded INTEGER NOT NULL DEFAULT 0, hold_seconds INTEGER NOT NULL DEFAULT 0,
      chain_id INTEGER NOT NULL, state TEXT NOT NULL, escrow_tx TEXT, release_tx TEXT,
      invoice_ref TEXT NOT NULL, scenario TEXT, release_trace_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS treasury_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL,
      tx TEXT, trace_id TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fundings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL, source TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE, amount TEXT NOT NULL, chain_id INTEGER NOT NULL, timeout_at INTEGER NOT NULL,
      escrow_tx TEXT, status TEXT NOT NULL, trace_id TEXT, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, milestone_id TEXT, outcome TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settlement_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL, proposal_json TEXT, proposal_hash TEXT,
      trace_id TEXT NOT NULL, decision TEXT NOT NULL, reasons TEXT NOT NULL, approval_id TEXT, agent_mode TEXT, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, milestone_id TEXT NOT NULL,
      action_index INTEGER NOT NULL, action_id TEXT NOT NULL UNIQUE, payee_id TEXT NOT NULL, rail TEXT NOT NULL,
      to_address TEXT NOT NULL, amount TEXT NOT NULL, chain_id INTEGER NOT NULL, proposal_hash TEXT NOT NULL,
      deadline INTEGER NOT NULL, policy_sig TEXT NOT NULL, tx TEXT, status TEXT NOT NULL,
      simulated INTEGER NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      milestone_id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, token_id INTEGER, mint_tx TEXT NOT NULL,
      holder TEXT NOT NULL, invoice_hash TEXT NOT NULL, settlement_hash TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_records (
      milestone_id TEXT PRIMARY KEY, payer_verified_name TEXT NOT NULL, customer_verified_name TEXT NOT NULL,
      simulated_id_ref TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
    );
  `);
  return db;
}

export const milestones = {
  get(db: DatabaseSync, id: string): MilestoneRow | undefined {
    return db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as MilestoneRow | undefined;
  },
  setState(db: DatabaseSync, id: string, state: MilestoneState, extra: Partial<Pick<MilestoneRow, "escrow_tx" | "release_tx" | "funding_source" | "card_funded" | "hold_seconds">> = {}) {
    const fields = ["state = ?", ...Object.keys(extra).map((k) => `${k} = ?`)];
    db.prepare(`UPDATE milestones SET ${fields.join(", ")} WHERE id = ?`).run(state, ...(Object.values(extra) as (string | number)[]), id);
  },
};

export function payeesOf(db: DatabaseSync, providerId: string): PayeeRow[] {
  return db.prepare("SELECT * FROM payees WHERE provider_id = ? ORDER BY payee_id").all(providerId) as unknown as PayeeRow[];
}

export function allPayees(db: DatabaseSync): PayeeRow[] {
  return db.prepare("SELECT * FROM payees ORDER BY payee_id").all() as unknown as PayeeRow[];
}

export function vaultOf(db: DatabaseSync, providerId: string, chainId: number) {
  return db.prepare("SELECT * FROM vaults WHERE provider_id = ? AND chain_id = ?").get(providerId, chainId) as
    | { provider_id: string; chain_id: number; vault: string; operator: string; provider_payout: string }
    | undefined;
}
