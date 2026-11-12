// The reads the web app's screens use: milestone list, timeline with the proposal, contract list.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http";
import { M1, fundedAndReleased, harness } from "./helpers";

async function serve(h: ReturnType<typeof harness>) {
  const server = createHttpServer({ db: h.db, treasury: h.treasury, orchestrator: h.orchestrator, now: h.now } as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
  const post = async (p: string, body: unknown) => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  return { get, post, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("GET /milestones lists milestones with filters; the timeline carries the proposal, decision, reasons and agent mode", async () => {
  const h = harness();
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  const s = await serve(h);
  try {
    const all = await s.get("/milestones");
    assert.equal(all.count, 1);
    assert.equal(all.milestones[0].id, M1);
    assert.equal((await s.get("/milestones?state=paid_out")).count, 1);
    assert.equal((await s.get("/milestones?state=draft")).count, 0);
    assert.equal((await s.get("/milestones?provider_id=nobody")).count, 0);
    const t = await s.get(`/milestones/${M1}/timeline`);
    const plan = t.settlement_plans[0];
    assert.equal(plan.decision, "paid_out");
    assert.ok(Array.isArray(plan.reasons));
    assert.ok(plan.agent_mode);
    assert.ok(Array.isArray(plan.proposal.actions) && typeof plan.proposal.confidence === "number" && Array.isArray(plan.proposal.flags));
    assert.equal("proposal_json" in plan, false);
  } finally { await s.close(); }
});

test("GET /contracts lists contracts with provider and status filters", async () => {
  const h = harness();
  const s = await serve(h);
  try {
    const body = {
      provider_id: "prov-1", provider_address: "0x00000000000000000000000000000000000000a1", client_address: "0x00000000000000000000000000000000000000c1",
      client_name: "Demo Client Ltd", currency: "USD", country: "KE",
      milestones: [{ title: "Logo", amount_usd_cents: 5000, due_date: "2026-12-01", acceptance_criteria: "Delivered as agreed." }],
    };
    const c = await s.post("/contracts", body);
    assert.ok(c.id, JSON.stringify(c));
    const list = await s.get("/contracts");
    assert.equal(list.contracts.length, 1);
    assert.equal(list.contracts[0].id, c.id);
    assert.equal(list.contracts[0].country, "KE");
    assert.ok(Array.isArray(list.contracts[0].milestones));
    assert.equal((await s.get("/contracts?provider_id=prov-1&status=" + c.status)).contracts.length, 1);
    assert.equal((await s.get("/contracts?provider_id=other")).contracts.length, 0);
  } finally { await s.close(); }
});

test("GET /providers/{id}: payout address, vault and payees for the contract form; 404 for an unknown provider", async () => {
  const h = harness();
  const s = await serve(h);
  try {
    const p = await s.get("/providers/prov-1");
    assert.equal(p.provider_id, "prov-1");
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(p.provider_address));
    assert.deepEqual(p.payees.map((x: any) => x.payee_id), ["payee_amara", "payee_kofi"]);
    assert.equal(p.payees[1].simulated, true);
    assert.equal((await s.get("/providers/nobody")).error, "provider not found");
  } finally { await s.close(); }
});
