// SIMULATED identity check for identity-matched release (PRD FR-10.2).
// Compares the verified name on the payment record with the verified customer. Real verification would need a
// licensed provider; here the names come from the identity_records table seeded for the demo.
// Block 3 adds the hold-and-escalate queue; this module only answers "match or not".
import type { DatabaseSync } from "node:sqlite";
import type { MilestoneRow } from "./db";

export interface IdentityCheck {
  check(m: MilestoneRow): { match: boolean; simulated: true; reason: string };
}

const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function createIdentityCheck(db: DatabaseSync): IdentityCheck {
  return {
    check(m) {
      const r = db.prepare("SELECT * FROM identity_records WHERE milestone_id = ?").get(m.id) as
        | { payer_verified_name: string; customer_verified_name: string }
        | undefined;
      if (!r) return { match: true, simulated: true, reason: "no identity record: treated as matched in the demo" };
      const match = norm(r.payer_verified_name) === norm(r.customer_verified_name);
      return { match, simulated: true, reason: match ? "names match" : "payer and customer names differ" };
    },
  };
}
