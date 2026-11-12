// Review (lead, 13 Nov 2026): the Policy Service takes the milestone id from the authenticated request, not from the
// agent's proposal, and rejects a proposal that names a different milestone (MILESTONE_ID_MISMATCH).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { evaluateProposal } from "../src/engine";
import { createHttpServer, listen, tokenMatches } from "../src/http";
import { GOOD_MILESTONE, goodProposal, makeCtx, withActions } from "./helpers";
import { makeHarness, submit, VAULT, CHAIN_ID } from "./service-helpers";

const OTHER = "22222222-2222-4222-8222-222222222222";

test("engine: a proposal for another milestone than the request's is rejected, whatever it contains", () => {
  const r = evaluateProposal({ ...goodProposal(), milestone_id: OTHER }, makeCtx({ requestMilestoneId: GOOD_MILESTONE }));
  assert.equal(r.decision, "rejected");
  assert.deepEqual(r.reasons, ["MILESTONE_ID_MISMATCH"]);
  // Even a plan that moves no money (which would otherwise only escalate) is rejected.
  const none = evaluateProposal(withActions([], { milestone_id: OTHER }), makeCtx({ requestMilestoneId: GOOD_MILESTONE }));
  assert.equal(none.decision, "rejected");
  assert.ok(none.reasons.includes("MILESTONE_ID_MISMATCH"));
  // Same milestone: approved as before.
  assert.equal(evaluateProposal(goodProposal(), makeCtx({ requestMilestoneId: GOOD_MILESTONE })).decision, "approved");
});

test("engine: a context without the request milestone id is refused (never evaluated)", () => {
  assert.throws(() => evaluateProposal(goodProposal(), makeCtx({ requestMilestoneId: "" })), /requestMilestoneId/);
});

test("service: request names milestone A, proposal names B -> rejected, nothing signed, chain read and logged for A", async () => {
  const asked: string[] = [];
  const base = makeHarness();
  const h = makeHarness({
    chain: {
      async vaultFor(id: string) { asked.push(id); return { vault: VAULT, chainId: CHAIN_ID }; },
      async vaultState() { return { spentToday: "0", balance: "10000000000" }; },
      async milestoneFacts(id: string) { asked.push(id); return { ...base.fake.facts }; },
      async vaultPolicy() { return { ...base.fake.vault }; },
      async vaultPayeeAllowed() { return true; },
      async payees() { return { "payee-1": { address: "0x00000000000000000000000000000000000000a1", rail: "usdt", simulated: false } }; },
      chainId: () => CHAIN_ID,
    },
  });
  const r = await submit(h, { ...goodProposal(), milestone_id: OTHER }, "t-mismatch", GOOD_MILESTONE);
  assert.equal(r.decision, "rejected");
  assert.deepEqual(r.reasons, ["MILESTONE_ID_MISMATCH"]);
  assert.equal(r.cosignatures, undefined);
  assert.ok(asked.length > 0 && asked.every((id) => id === GOOD_MILESTONE), `reads were for ${asked}`);
  const rows = h.audit.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].milestone_id, GOOD_MILESTONE);
  // Nothing was recorded as settled for either milestone.
  assert.equal(h.decisions.settledFor(GOOD_MILESTONE).approvedCount, 0);
  assert.equal(h.decisions.settledFor(OTHER).approvedCount, 0);
  // The same proposal sent for its own milestone is approved: the mismatch, not the plan, was refused.
  assert.equal((await submit(h, { ...goodProposal(), milestone_id: OTHER }, "t-own", OTHER)).decision, "approved");
});

test("service: a request without milestone_id is a 400", async () => {
  const h = makeHarness();
  await assert.rejects(h.service.submitProposal({ proposal: goodProposal(), trace_id: "t" }), (e: any) => e.status === 400);
  await assert.rejects(h.service.submitProposal({ proposal: goodProposal(), trace_id: "t", milestone_id: "" }), (e: any) => e.status === 400);
  await assert.rejects(h.service.submitProposal({ proposal: goodProposal(), trace_id: "t", milestone_id: 7 }), (e: any) => e.status === 400);
  assert.equal(h.audit.list().length, 0);
});

// ---- HTTP: only an authenticated caller (the backend) may ask for a decision ----

const TOKEN = "milestone-id-test-token-0123456789";
const h = makeHarness();
const server = createHttpServer(h.service, { proposalToken: TOKEN });
let url = "";
before(async () => {
  await listen(server, 0);
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1/proposals";
});
after(() => server.close());

const post = (headers: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ milestone_id: GOOD_MILESTONE, proposal: goodProposal(), trace_id: "t" }) });

test("http: POST /v1/proposals without the token, or with a wrong one, is 401 and nothing is evaluated", async () => {
  for (const headers of [{} as Record<string, string>, { "x-internal-token": "wrong" }, { "x-internal-token": TOKEN + "x" }]) {
    const res = await post(headers);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorised" });
  }
  assert.equal(h.audit.list().length, 0);
  const ok = await post({ "x-internal-token": TOKEN });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).decision, "approved");
});

test("http: the server refuses to start without a usable token; tokenMatches is exact", () => {
  assert.throws(() => createHttpServer(h.service, { proposalToken: "" }));
  assert.throws(() => createHttpServer(h.service, { proposalToken: "short" }));
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches([TOKEN], TOKEN), false);
  assert.equal(tokenMatches("", ""), false);
});
