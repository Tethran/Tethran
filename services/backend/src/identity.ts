// SIMULATED identity check for identity-matched release (PRD FR-10.2).
// Compares the verified name on the payment record with the verified customer. Real verification would need a
// licensed provider; here the names come from a simulated verification step (POST /milestones/{id}/identity).
//
// Strict: a milestone with no identity record is NOT a match. A mismatch or a missing record holds the release
// and opens an identity hold for the operator (operator.ts), who can resolve it with a signed decision.
import type { DatabaseSync } from "node:sqlite";
import type { MilestoneRow } from "./db";
import { ApiError } from "./errors";

export interface IdentityCheck {
  check(m: MilestoneRow): { match: boolean; simulated: true; reason: string; overridden?: boolean };
}

const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function migrateIdentity(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS identity_holds (
    milestone_id TEXT PRIMARY KEY, reason TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, decision TEXT,
    opened_at TEXT NOT NULL, decided_at TEXT
  )`);
}

export function createIdentityCheck(db: DatabaseSync): IdentityCheck {
  migrateIdentity(db);
  return {
    check(m) {
      const hold = db.prepare("SELECT status, decision FROM identity_holds WHERE milestone_id = ?").get(m.id) as { status: string; decision: string | null } | undefined;
      if (hold?.status === "decided" && hold.decision === "release") {
        return { match: true, simulated: true, overridden: true, reason: "identity hold released by an operator-signed decision" };
      }
      const r = db.prepare("SELECT * FROM identity_records WHERE milestone_id = ?").get(m.id) as
        | { payer_verified_name: string; customer_verified_name: string }
        | undefined;
      if (!r) return { match: false, simulated: true, reason: "no verified identity on file for this payment" };
      const match = norm(r.payer_verified_name) === norm(r.customer_verified_name);
      return { match, simulated: true, reason: match ? "names match" : "payer and customer names differ" };
    },
  };
}

/** SIMULATED verification provider: records the verified names for a milestone's payment. */
export function recordIdentity(db: DatabaseSync, milestoneId: string, body: { payer_verified_name?: unknown; customer_verified_name?: unknown }) {
  const ok = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 120;
  if (!ok(body.payer_verified_name) || !ok(body.customer_verified_name)) {
    throw new ApiError(400, "payer_verified_name and customer_verified_name are required (max 120 chars)");
  }
  const ref = `SIM-ID-${milestoneId.slice(0, 8)}`;
  db.prepare("INSERT OR REPLACE INTO identity_records (milestone_id, payer_verified_name, customer_verified_name, simulated_id_ref) VALUES (?, ?, ?, ?)")
    .run(milestoneId, (body.payer_verified_name as string).trim(), (body.customer_verified_name as string).trim(), ref);
  return { milestone_id: milestoneId, simulated: true, simulated_id_ref: ref, note: "SIMULATED verification: no real identity provider was called" };
}

/** Opens (or keeps open) an identity hold. Called by the treasury when a release is held. */
export function openIdentityHold(db: DatabaseSync, milestoneId: string, reason: string, now: Date) {
  db.prepare("INSERT OR IGNORE INTO identity_holds (milestone_id, reason, status, opened_at) VALUES (?, ?, 'open', ?)").run(milestoneId, reason, now.toISOString());
}
