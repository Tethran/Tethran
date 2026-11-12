import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAuditLog } from "../src/index";
import type { AuditEntry } from "../src/index";

const entry = (milestone_id: string, decision: AuditEntry["decision"] = "approved"): AuditEntry => ({
  at: "2026-11-12T10:00:00.000Z",
  milestone_id,
  proposal_hash: "ab".repeat(32),
  decision,
  reasons: decision === "approved" ? [] : ["LOW_CONFIDENCE"],
  policy_version: 1,
  trace_id: "trace-1",
});

test("append returns increasing ids and list returns rows in order", () => {
  const log = openAuditLog();
  const a = log.append(entry("m1"));
  const b = log.append(entry("m2", "escalated"));
  assert.ok(b > a);
  const rows = log.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].reasons, ["LOW_CONFIDENCE"]);
  assert.equal(rows[1].decision, "escalated");
});

test("list filters by milestone_id", () => {
  const log = openAuditLog();
  log.append(entry("m1"));
  log.append(entry("m2"));
  log.append(entry("m1", "rejected"));
  assert.equal(log.list({ milestone_id: "m1" }).length, 2);
  assert.equal(log.list({ milestone_id: "none" }).length, 0);
});

test("the log exposes no update or delete methods", () => {
  assert.deepEqual(Object.keys(openAuditLog()).sort(), ["append", "close", "list"]);
});

test("triggers abort UPDATE and DELETE on the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-audit-"));
  const file = join(dir, "audit.sqlite");
  try {
    const log = openAuditLog(file);
    log.append(entry("m1"));
    const raw = new DatabaseSync(file);
    assert.throws(() => raw.exec("UPDATE audit_log SET decision = 'approved'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM audit_log"), /append-only/);
    raw.close();
    assert.equal(log.list().length, 1);
    assert.equal(log.list()[0].decision, "approved");
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
