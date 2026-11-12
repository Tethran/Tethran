import { DatabaseSync } from "node:sqlite";
import type { Decision, ReasonCode } from "./types";

// Append-only decision log. Store only ids, hashes, decisions and reason codes:
// never secrets, keys or personal data.
export interface AuditEntry {
  at: string; // ISO timestamp supplied by the caller
  milestone_id: string;
  proposal_hash: string;
  decision: Decision;
  reasons: ReasonCode[];
  policy_version: number;
  trace_id: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
}

export interface AuditLog {
  append(entry: AuditEntry): number;
  list(filter?: { milestone_id?: string }): AuditRow[];
  close(): void; // releases the file handle only; changes no data
}

export function openAuditLog(path = ":memory:"): AuditLog {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      reasons TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      trace_id TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);

  const insert = db.prepare(
    "INSERT INTO audit_log (at, milestone_id, proposal_hash, decision, reasons, policy_version, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  return {
    append(e) {
      const result = insert.run(e.at, e.milestone_id, e.proposal_hash, e.decision, JSON.stringify(e.reasons), e.policy_version, e.trace_id);
      return Number(result.lastInsertRowid);
    },
    close() {
      db.close();
    },
    list(filter = {}) {
      const rows = (
        filter.milestone_id === undefined
          ? db.prepare("SELECT * FROM audit_log ORDER BY id").all()
          : db.prepare("SELECT * FROM audit_log WHERE milestone_id = ? ORDER BY id").all(filter.milestone_id)
      ) as Record<string, unknown>[];
      return rows.map((r) => ({
        id: Number(r.id),
        at: r.at as string,
        milestone_id: r.milestone_id as string,
        proposal_hash: r.proposal_hash as string,
        decision: r.decision as Decision,
        reasons: JSON.parse(r.reasons as string) as ReasonCode[],
        policy_version: Number(r.policy_version),
        trace_id: r.trace_id as string,
      }));
    },
  };
}
