import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Wallet } from "ethers";
import { createHttpServer, listen, MAX_BODY_BYTES } from "../src/http";
import { ATTESTATION_KIND, attestationDomain, attestationTypes, onChainMilestoneId } from "../src/typed";
import type { Policy } from "../src/index";
import { goodProposal, policy as basePolicy } from "./helpers";
import { CHAIN_ID, ESCROW, escalatingProposal, makeHarness, signApproval, signPolicy } from "./service-helpers";

const h = makeHarness();
const server = createHttpServer(h.service);
let base = "";
let allBodies = "";

before(async () => {
  await listen(server, 0);
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
});

async function call(method: string, path: string, body?: unknown, rawBody?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  allBodies += text + "\n";
  return { status: res.status, json: JSON.parse(text) as any, headers: res.headers };
}

test("server binds to 127.0.0.1 by default", () => {
  assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
});

test("POST /v1/proposals: approved, escalated and rejected over HTTP", async () => {
  const ok = await call("POST", "/v1/proposals", { proposal: goodProposal(), trace_id: "t1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.decision, "approved");
  assert.equal(ok.json.cosignatures.length, 1);

  const dup = await call("POST", "/v1/proposals", { proposal: goodProposal(), trace_id: "t2" });
  assert.equal(dup.json.decision, "rejected");
  assert.ok(dup.json.reasons.includes("DUPLICATE_PROPOSAL"));
  assert.equal(dup.json.cosignatures, undefined);
});

test("GET /v1/policy and POST /v1/policy", async () => {
  const got = await call("GET", "/v1/policy");
  assert.equal(got.status, 200);
  assert.equal(got.json.version, 1);

  const doc: Policy = { ...basePolicy, version: 2, daily_cap: "3000000000" };
  const operator_signature = await signPolicy(h.operator, 2, doc);
  const set = await call("POST", "/v1/policy", { policy: doc, version: 2, operator_signature });
  assert.equal(set.status, 200);
  assert.equal(set.json.version, 2);

  const bad = await call("POST", "/v1/policy", { policy: { ...doc, version: 3 }, version: 3, operator_signature: await signPolicy(Wallet.createRandom(), 3, { ...doc, version: 3 }) });
  assert.equal(bad.status, 403);
  assert.equal(typeof bad.json.error, "string");
});

test("approvals queue: list pending and decide", async () => {
  const esc = await call("POST", "/v1/proposals", { proposal: escalatingProposal(), trace_id: "t3" });
  assert.equal(esc.json.decision, "escalated");
  const list = await call("GET", "/v1/approvals?status=pending");
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].id, esc.json.approval_id);
  const defaulted = await call("GET", "/v1/approvals");
  assert.equal(defaulted.json.length, 1);

  const operator_signature = await signApproval(h.operator, esc.json.approval_id, "approve", esc.json.proposal_hash);
  const decided = await call("POST", `/v1/approvals/${esc.json.approval_id}/decision`, { decision: "approve", operator_signature });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.decision, "approved");
  assert.equal(decided.json.cosignatures.length, 1);

  const again = await call("POST", `/v1/approvals/${esc.json.approval_id}/decision`, { decision: "approve", operator_signature });
  assert.equal(again.status, 409);
  const missing = await call("POST", "/v1/approvals/nope/decision", { decision: "approve", operator_signature });
  assert.equal(missing.status, 404);
});

test("POST /v1/attestations/verify", async () => {
  const w = Wallet.createRandom();
  const milestone_id = "11111111-1111-4111-8111-111111111111";
  const signature = await w.signTypedData(attestationDomain(CHAIN_ID, ESCROW), attestationTypes, {
    milestoneId: onChainMilestoneId(milestone_id),
    kind: ATTESTATION_KIND.client,
    releaseToProvider: true,
  });
  const body = { milestone_id, type: "client", signer: w.address, signature, release_to_provider: true };
  assert.deepEqual((await call("POST", "/v1/attestations/verify", body)).json, { valid: true });
  assert.deepEqual((await call("POST", "/v1/attestations/verify", { ...body, type: "arbiter" })).json, { valid: false });
  assert.equal((await call("POST", "/v1/attestations/verify", { ...body, type: "x" })).status, 400);
});

test("GET /v1/audit with and without milestone_id", async () => {
  const all = await call("GET", "/v1/audit");
  assert.equal(all.status, 200);
  assert.ok(all.json.length >= 3);
  const none = await call("GET", "/v1/audit?milestone_id=does-not-exist");
  assert.deepEqual(none.json, []);
  const one = await call("GET", "/v1/audit?milestone_id=11111111-1111-4111-8111-111111111111");
  assert.ok(one.json.length >= 3);
});

test("malformed JSON is 400", async () => {
  const r = await call("POST", "/v1/proposals", undefined, "{not json");
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "malformed JSON" });
  const empty = await call("POST", "/v1/proposals", undefined, "");
  assert.equal(empty.status, 400);
});

test("an oversize body is refused with 413", async () => {
  const big = JSON.stringify({ proposal: { pad: "x".repeat(MAX_BODY_BYTES + 10) }, trace_id: "t" });
  const r = await call("POST", "/v1/proposals", undefined, big);
  assert.equal(r.status, 413);
});

test("unknown route is 404 and wrong method is 405 with Allow", async () => {
  assert.equal((await call("GET", "/v1/nothing")).status, 404);
  assert.equal((await call("GET", "/")).status, 404);
  const r = await call("GET", "/v1/proposals");
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "POST");
  assert.equal((await call("DELETE", "/v1/policy")).status, 405);
  assert.equal((await call("PUT", "/v1/approvals/abc/decision", {})).status, 405);
});

test("errors carry only { error } with no stack or URL, and no response contains a test key", async () => {
  const r = await call("POST", "/v1/proposals", { trace_id: "t" });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.json), ["error"]);
  assert.ok(!/\bat\s.+\(.+:\d+:\d+\)/.test(JSON.stringify(r.json)), "no stack trace");

  for (const key of [h.policySigner.privateKey, h.operator.privateKey]) {
    assert.ok(!allBodies.includes(key) && !allBodies.includes(key.slice(2)), "key leaked in a response");
    for (const row of h.audit.list()) {
      assert.ok(!JSON.stringify(row).includes(key.slice(2)), "key leaked in audit");
    }
  }
});
