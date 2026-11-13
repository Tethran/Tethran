// Notifications: created from the records, never duplicated, visible only to their role, with read state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors";
import { createNotifications } from "../src/notifications";
import { fundedAndReleased, harness, M1 } from "./helpers";

const setup = async () => {
  const h = harness();
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  const n = createNotifications(h.db, { now: h.now, appBaseUrl: "https://app.example.test/" });
  return { h, n };
};
const types = (l: { items: any[] }) => l.items.map((i) => i.type).sort();

test("a settled milestone notifies each role about its own events, with absolute links under APP_BASE_URL", async () => {
  const { n } = await setup();
  const f = n.list("freelancer");
  assert.deepEqual(types(f), ["client_approved", "milestone_funded", "receipt_minted", "settlement_paid", "settlement_proposed"].sort());
  assert.ok(f.items.every((i: any) => i.link.startsWith("https://app.example.test/")), "links use APP_BASE_URL");
  const op = n.list("operator");
  assert.deepEqual(types(op), ["fee_collected"]);
  assert.match(op.items[0].title, /Platform fee collected: \$5\.00/);
  const c = n.list("client");
  assert.ok(types(c).includes("receipt_minted") && types(c).includes("settlement_paid"));
  assert.ok(!types(c).includes("milestone_funded"), "funded goes to the freelancer only");
  assert.equal(n.list("arbiter").items.length, 0);
});

test("idempotent: syncing again, or a notify() with the same key, creates nothing new", async () => {
  const { h, n } = await setup();
  n.sync();
  const before = (h.db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as any).n;
  n.sync(); n.sync();
  n.list("client"); n.list("freelancer");
  assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as any).n, before);
  assert.equal(n.notify({ recipient: "client", type: "email_sent", title: "t", body: "b", path: "/x", key: "email:1" }), true);
  assert.equal(n.notify({ recipient: "client", type: "email_sent", title: "t", body: "b", path: "/x", key: "email:1" }), false);
});

test("work submitted reaches the client with the delivery check summary and a request to approve", async () => {
  const h = harness();
  await fundedAndReleased(h);
  h.db.prepare("INSERT INTO evidence (milestone_id, text, at) VALUES (?, ?, ?)").run(M1, "done", "2026-11-13T10:00:00Z");
  const evId = (h.db.prepare("SELECT MAX(id) AS id FROM evidence").get() as any).id;
  const n = createNotifications(h.db, { now: h.now, appBaseUrl: "http://localhost:3000" });
  h.db.exec("CREATE TABLE IF NOT EXISTS delivery_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT, evidence_id INTEGER, checks_json TEXT, agent_mode TEXT, error TEXT, at TEXT)");
  h.db.prepare("INSERT INTO delivery_checks (milestone_id, evidence_id, checks_json, agent_mode, at) VALUES (?, ?, ?, 'Replay', ?)")
    .run(M1, evId, JSON.stringify([{ status: "met" }, { status: "unclear" }]), "2026-11-13T10:00:01Z");
  const item = n.list("client").items.find((i: any) => i.type === "work_submitted");
  assert.ok(item);
  assert.match(item.body, /1 met, 0 unmet, 1 unclear/);
  assert.match(item.body, /approve the work/);
  assert.equal(item.link, `http://localhost:3000/app/milestone/${M1}`);
});

test("read state: one at a time or all; a role cannot mark another role's notification", async () => {
  const { n } = await setup();
  const f = n.list("freelancer");
  assert.equal(f.unread, f.items.length);
  const first = f.items[0];
  n.markRead(String(first.id), "freelancer");
  assert.equal(n.list("freelancer").unread, f.items.length - 1);
  assert.ok(n.list("freelancer").items.find((i: any) => i.id === first.id)!.read_at);
  const c = n.list("client");
  assert.throws(() => n.markRead(String(c.items[0].id), "freelancer"), (e: unknown) => e instanceof ApiError && e.status === 404);
  assert.equal(n.markAllRead("client").marked, c.unread);
  assert.equal(n.list("client").unread, 0);
  assert.throws(() => n.list("everyone"), (e: unknown) => e instanceof ApiError && e.code === "BAD_RECIPIENT");
});
