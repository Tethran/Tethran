// Treasury issues that need a person: money arrived that the escrow will not take (a card payment for a milestone
// that is already funded, a mismatched amount, ...). Each one is a refund to make by hand; the reconciliation queue
// lists the open ones. Idempotent per (kind, reference).
import type { DatabaseSync } from "node:sqlite";

export type TreasuryIssueKind = "refund_needed";

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS treasury_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, milestone_id TEXT, reference TEXT NOT NULL, detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', at TEXT NOT NULL, UNIQUE (kind, reference)
  )`);
}

export function openTreasuryIssue(db: DatabaseSync, i: { kind: TreasuryIssueKind; milestone_id: string | null; reference: string; detail: string }, now: Date) {
  migrate(db);
  db.prepare("INSERT OR IGNORE INTO treasury_issues (kind, milestone_id, reference, detail, at) VALUES (?, ?, ?, ?, ?)")
    .run(i.kind, i.milestone_id, i.reference, i.detail.slice(0, 500), now.toISOString());
}

export function openTreasuryIssues(db: DatabaseSync) {
  migrate(db);
  return db.prepare("SELECT * FROM treasury_issues WHERE status = 'open' ORDER BY id").all() as {
    id: number; kind: TreasuryIssueKind; milestone_id: string | null; reference: string; detail: string; status: string; at: string;
  }[];
}
