import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Decision, Policy, ReasonCode } from "./types";
import { validatePolicy } from "./engine";

// SQLite stores for the Policy Service. Same style as audit.ts: one file per store, ":memory:" for tests.

// --- policy_versions ---
export interface PolicyVersionRow {
  version: number;
  policy: Policy;
  operator_signature: string;
  at: string;
}

export interface PolicyStore {
  current(): PolicyVersionRow;
  history(): PolicyVersionRow[];
  add(policy: Policy, operator_signature: string, at: string): void; // version must be current + 1
  close(): void;
}

// `initial` is stored as the first version only if the table is empty. Its signature is the text "initial".
export function openPolicyStore(path: string, initial: Policy): PolicyStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_versions (
      version INTEGER PRIMARY KEY,
      policy_json TEXT NOT NULL,
      operator_signature TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO policy_versions (version, policy_json, operator_signature, at) VALUES (?, ?, ?, ?)");

  const toRow = (r: Record<string, unknown>): PolicyVersionRow => ({
    version: Number(r.version),
    policy: JSON.parse(r.policy_json as string) as Policy,
    operator_signature: r.operator_signature as string,
    at: r.at as string,
  });
  const current = (): PolicyVersionRow =>
    toRow(db.prepare("SELECT * FROM policy_versions ORDER BY version DESC LIMIT 1").get() as Record<string, unknown>);

  const count = db.prepare("SELECT COUNT(*) AS n FROM policy_versions").get() as { n: number };
  if (Number(count.n) === 0) {
    validatePolicy(initial);
    insert.run(initial.version, JSON.stringify(initial), "initial", new Date(0).toISOString());
  }

  return {
    current,
    history() {
      return (db.prepare("SELECT * FROM policy_versions ORDER BY version").all() as Record<string, unknown>[]).map(toRow);
    },
    add(policy, operator_signature, at) {
      if (policy.version !== current().version + 1) throw new Error("version must be current + 1");
      insert.run(policy.version, JSON.stringify(policy), operator_signature, at);
    },
    close() {
      db.close();
    },
  };
}

// --- policy_decisions (used for duplicate detection) ---
export interface DecisionRecord {
  proposal_hash: string;
  decision: Decision;
  reasons: ReasonCode[];
  milestone_id: string;
  trace_id: string;
  at: string;
}

export interface DecisionStore {
  add(d: DecisionRecord): void;
  seenHashes(): Set<string>;
  close(): void;
}

export function openDecisionStore(path: string): DecisionStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      reasons TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS policy_decisions_hash ON policy_decisions (proposal_hash);
  `);
  const insert = db.prepare(
    "INSERT INTO policy_decisions (proposal_hash, decision, reasons, milestone_id, trace_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  return {
    add(d) {
      insert.run(d.proposal_hash, d.decision, JSON.stringify(d.reasons), d.milestone_id, d.trace_id, d.at);
    },
    seenHashes() {
      const rows = db.prepare("SELECT DISTINCT proposal_hash FROM policy_decisions").all() as { proposal_hash: string }[];
      return new Set(rows.map((r) => r.proposal_hash));
    },
    close() {
      db.close();
    },
  };
}

// --- approvals (human queue) ---
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRow {
  id: string;
  proposal: unknown;
  proposal_hash: string;
  reasons: ReasonCode[];
  milestone_id: string;
  trace_id: string;
  status: ApprovalStatus;
  created_at: string;
  decided_at: string | null;
}

export interface ApprovalStore {
  create(a: { proposal: unknown; proposal_hash: string; reasons: ReasonCode[]; milestone_id: string; trace_id: string; at: string }): string;
  get(id: string): ApprovalRow | undefined;
  list(status: ApprovalStatus): ApprovalRow[];
  // Moves pending -> approved/rejected. Returns false if the row was not pending (so a decision happens once).
  decide(id: string, status: "approved" | "rejected", at: string): boolean;
  close(): void;
}

export function openApprovalStore(path: string): ApprovalStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      proposal_json TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      reasons TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
  `);
  const toRow = (r: Record<string, unknown>): ApprovalRow => ({
    id: r.id as string,
    proposal: JSON.parse(r.proposal_json as string),
    proposal_hash: r.proposal_hash as string,
    reasons: JSON.parse(r.reasons as string) as ReasonCode[],
    milestone_id: r.milestone_id as string,
    trace_id: r.trace_id as string,
    status: r.status as ApprovalStatus,
    created_at: r.created_at as string,
    decided_at: (r.decided_at as string | null) ?? null,
  });
  return {
    create(a) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO approvals (id, proposal_json, proposal_hash, reasons, milestone_id, trace_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      ).run(id, JSON.stringify(a.proposal), a.proposal_hash, JSON.stringify(a.reasons), a.milestone_id, a.trace_id, a.at);
      return id;
    },
    get(id) {
      const r = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return r === undefined ? undefined : toRow(r);
    },
    list(status) {
      return (db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at, rowid").all(status) as Record<string, unknown>[]).map(toRow);
    },
    decide(id, status, at) {
      const res = db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, at, id);
      return Number(res.changes) === 1;
    },
    close() {
      db.close();
    },
  };
}
