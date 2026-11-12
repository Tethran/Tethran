import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTracer } from "../../llm/src/index";
import { PAYMENT_METHODS, createSimulatedCheckout, createStripeCheckout, startCheckout, stripeMethodTypes } from "../src/checkout";
import { ApiError } from "../src/errors";
import { createIdentityCheck } from "../src/identity";
import { createTreasury } from "../src/treasury";
import { relayVaultActions } from "../src/vaultRelay";
import { ARBITER, CHAIN_ID, CLIENT, M1, TREASURY, USDT, VAULT, WEBHOOK_SECRET, fundedAndReleased, harness } from "./helpers";

const create = (h: ReturnType<typeof harness>) =>
  h.treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000 });

function simulated(h: ReturnType<typeof harness>) {
  return createSimulatedCheckout({ db: h.db, webhookSecret: WEBHOOK_SECRET, treasury: () => h.treasury, publicBaseUrl: "http://app.test", now: h.now });
}

// ---- simulated checkout ----

test("checkout options list all six methods; the simulated provider is labelled", () => {
  assert.deepEqual(PAYMENT_METHODS.map((m) => m.id), ["card", "apple_pay", "google_pay", "paypal", "cashapp", "stablecoin"]);
});

test("simulated card payment: a signed event goes through the real webhook path and funds the escrow once", async () => {
  const h = harness();
  await create(h);
  const sim = simulated(h);
  for (const method of ["card", "apple_pay", "google_pay", "paypal", "cashapp"]) {
    const s = await startCheckout({ db: h.db, provider: sim.provider, treasury: h.treasury, publicBaseUrl: "http://app.test", milestone_id: M1, method });
    assert.deepEqual([s.provider, s.simulated, s.label, s.status], ["simulated", true, "Simulated", "open"]);
  }
  const s = await startCheckout({ db: h.db, provider: sim.provider, treasury: h.treasury, publicBaseUrl: "http://app.test", milestone_id: M1, method: "google_pay" });
  const done: any = await sim.complete(s.session_id, "paid");
  assert.equal(done.webhook.outcome, "funded");
  assert.equal(done.session.status, "paid");
  assert.equal(h.escrow.get(M1)?.cardFunded, true);
  // completing again does nothing; another session for the same milestone is refused
  assert.equal((await sim.complete(s.session_id, "paid") as any).already, true);
  await assert.rejects(startCheckout({ db: h.db, provider: sim.provider, treasury: h.treasury, publicBaseUrl: "x", milestone_id: M1, method: "card" }),
    (e: unknown) => e instanceof ApiError && e.status === 409);
  assert.equal(h.sent.filter((x) => x === "createAndFund").length, 1);
});

test("simulated checkout uses the same verification: a wrong secret is refused by the webhook handler", async () => {
  const h = harness();
  await create(h);
  const bad = createSimulatedCheckout({ db: h.db, webhookSecret: "whsec_wrong", treasury: () => h.treasury, publicBaseUrl: "x", now: h.now });
  const s = await bad.provider.createSession({ milestone_id: M1, method: "card", amount_usd_cents: 10_000, title: "t", success_url: "a", cancel_url: "b" });
  await assert.rejects(bad.complete(s.session_id, "paid"), (e: unknown) => e instanceof ApiError && e.code === "BAD_SIGNATURE");
  assert.equal(h.escrow.size, 0);
});

test("simulated checkout: the amount is checked by the treasury, failed and cancelled sessions fund nothing", async () => {
  const h = harness();
  await create(h);
  const sim = simulated(h);
  const wrong = await sim.provider.createSession({ milestone_id: M1, method: "card", amount_usd_cents: 9_999, title: "t", success_url: "a", cancel_url: "b" });
  assert.match((await sim.complete(wrong.session_id, "paid") as any).webhook.outcome, /^rejected/);
  for (const outcome of ["failed", "cancelled"]) {
    const s = await sim.provider.createSession({ milestone_id: M1, method: "card", amount_usd_cents: 10_000, title: "t", success_url: "a", cancel_url: "b" });
    assert.equal((await sim.complete(s.session_id, outcome) as any).session.status, outcome);
  }
  await assert.rejects(sim.complete(wrong.session_id, "maybe"), (e: unknown) => e instanceof ApiError && e.status === 400);
  assert.equal(h.escrow.size, 0);
});

test("simulated dispute during the card hold refunds the escrow through the chargeback path", async () => {
  const h = harness();
  await create(h);
  const sim = simulated(h);
  const s = await sim.provider.createSession({ milestone_id: M1, method: "card", amount_usd_cents: 10_000, title: "t", success_url: "a", cancel_url: "b" });
  await sim.complete(s.session_id, "paid");
  h.chain.approve(M1);
  const d: any = await sim.dispute(s.session_id);
  assert.match(d.webhook.outcome, /^refunded/);
  assert.equal(h.escrow.get(M1)?.state, "Refunded");
});

test("stablecoin in checkout returns the treasury deposit instructions (demo simplification)", async () => {
  const h = harness();
  await create(h);
  const s: any = await startCheckout({ db: h.db, provider: simulated(h).provider, treasury: h.treasury, publicBaseUrl: "x", milestone_id: M1, method: "stablecoin" });
  assert.equal(s.deposit.deposit_address, TREASURY);
  assert.match(s.label, /demo simplification/);
});

test("the real Stripe provider builds the documented Checkout Session request (not called: disabled without keys)", async () => {
  let sent: { url: string; body: string; auth: string } | undefined;
  const fakeFetch = (async (url: string, init: any) => {
    sent = { url, body: init.body, auth: init.headers.authorization };
    return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const s = await createStripeCheckout({ secretKey: "sk_test_x", fetch: fakeFetch }).createSession({
    milestone_id: M1, method: "paypal", amount_usd_cents: 10_000, title: "Brand pack", success_url: "https://a", cancel_url: "https://b",
  });
  assert.equal(s.simulated, false);
  assert.equal(sent!.url, "https://api.stripe.com/v1/checkout/sessions");
  const form = new URLSearchParams(sent!.body);
  assert.equal(form.get("payment_method_types[0]"), "paypal");
  assert.equal(form.get("metadata[milestone_id]"), M1);
  assert.equal(form.get("payment_intent_data[metadata][milestone_id]"), M1);
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "10000");
  assert.deepEqual(stripeMethodTypes("apple_pay"), ["card"]);
});

// ---- agent modes: live, replay, live+replay ----

test("replay mode: a saved proposal is used, labelled Replay, and still goes through the Policy Service", async () => {
  const h = harness({ mode: "replay" });
  await fundedAndReleased(h);
  const r: any = await h.orchestrator.settle(M1);
  assert.equal(r.agent_mode, "Replay");
  assert.match(r.replay_source, /^(curated|real model output: .+ Opik trace )/); // always says where it came from
  assert.equal(h.llm.calls, 0);
  assert.equal(h.submitted.length, 1); // the Policy Service still decided
  assert.equal(r.decision, "approved");
  // the saved proposal is scaled to this milestone: 90% payout, 10% tax reserve of 100 USDT
  assert.deepEqual(h.submitted[0].proposal.actions.map((a: any) => a.amount), ["90000000", "10000000"]);
});

test("live+replay: when every live attempt fails (rate limit), the saved proposal is used and the reason is shown", async () => {
  const h = harness({ mode: "live+replay", failLlm: true });
  await fundedAndReleased(h);
  const r: any = await h.orchestrator.settle(M1);
  assert.equal(r.agent_mode, "Replay (live failed: HTTP 429)");
  assert.equal(r.decision, "approved");
});

test("live only: a failed live call is a rejection, never a silent replay", async () => {
  const h = harness({ mode: "live", failLlm: true });
  await fundedAndReleased(h);
  const r: any = await h.orchestrator.settle(M1);
  assert.deepEqual([r.decision, r.agent_mode], ["rejected", "live"]);
  assert.equal(h.submitted.length, 0);
});

test("a request can choose the agent mode", async () => {
  const h = harness({ mode: "live" });
  await fundedAndReleased(h);
  const r: any = await h.orchestrator.settle(M1, { agentMode: "replay" });
  assert.equal(r.agent_mode, "Replay");
});

// ---- approved escalations ----

test("escalated settlement: nothing is paid until the operator approves; then the payouts and receipt run", async () => {
  const h = harness({ decision: "escalated" });
  await fundedAndReleased(h);
  const first: any = await h.orchestrator.settle(M1);
  assert.equal(first.decision, "escalated");
  assert.equal(h.sent.includes("vaultExecute"), false);
  await assert.rejects(h.orchestrator.executeApproval(M1, "nope", { decision: "approve", operator_signature: "0x" }),
    (e: unknown) => e instanceof ApiError && e.status === 404);
  await assert.rejects(h.orchestrator.executeApproval(M1, first.approval_id, { decision: "approve" }),
    (e: unknown) => e instanceof ApiError && e.status === 403);
  const r: any = await h.orchestrator.executeApproval(M1, first.approval_id, { decision: "approve", operator_signature: "0xsig" });
  assert.equal(r.decision, "approved");
  assert.equal(r.settlement_trace_id, first.trace_id);
  assert.equal(h.sent.filter((x) => x === "vaultExecute").length, 2);
  assert.equal(h.receipts.size, 1);
  // executing again resumes, it does not pay twice
  const again: any = await h.orchestrator.executeApproval(M1, first.approval_id, { decision: "approve", operator_signature: "0xsig" });
  assert.equal(again.resumed, true);
  assert.equal(h.sent.filter((x) => x === "vaultExecute").length, 2);
});

test("escalated settlement rejected by the operator pays nothing", async () => {
  const h = harness({ decision: "escalated" });
  await fundedAndReleased(h);
  const first: any = await h.orchestrator.settle(M1);
  const r: any = await h.orchestrator.executeApproval(M1, first.approval_id, { decision: "reject", operator_signature: "0xsig" });
  assert.equal(r.decision, "rejected");
  assert.equal(h.sent.includes("vaultExecute"), false);
  await assert.rejects(h.orchestrator.executeApproval(M1, first.approval_id, { decision: "approve", operator_signature: "0xsig" }),
    (e: unknown) => e instanceof ApiError && e.status === 409);
});

// ---- treasury tracing ----

test("each treasury action is one trace with its chain calls as spans; the trace id is stored and returned", async () => {
  const h = harness();
  const tracer = new MemoryTracer();
  const treasury = createTreasury({
    db: h.db, chain: h.chain, identity: createIdentityCheck(h.db), now: h.now, tracer,
    config: { chainId: CHAIN_ID, chainName: "x", treasuryAddress: TREASURY, usdtAddress: USDT, arbiterAddress: ARBITER, defaultTimeoutSeconds: 604800, cardHoldSeconds: 600, stripeWebhookSecret: WEBHOOK_SECRET },
  });
  await treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "t", client_address: CLIENT, amount_usd_cents: 10_000 });
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  const funded: any = await treasury.confirmDeposit(M1, tx);
  assert.ok(funded.trace_id);
  const run = tracer.runs.find((r) => r.name === "treasury.confirmDeposit")!;
  assert.equal(run.traceId, funded.trace_id);
  assert.ok(run.spans.some((s) => s.name === "chain.createAndFund"));
  assert.ok(run.spans.some((s) => s.name === "chain.usdtTransfersInTx"));
  assert.equal(tracer.runs.filter((r) => r.name === "treasury.fund").length, 0); // the nested fund joined the deposit trace
  const funding = h.db.prepare("SELECT trace_id FROM fundings").get() as { trace_id: string };
  assert.equal(funding.trace_id, funded.trace_id);
  const actions = h.db.prepare("SELECT action, trace_id FROM treasury_actions ORDER BY id").all() as { action: string; trace_id: string }[];
  assert.deepEqual(actions.map((a) => a.action), ["createMilestone", "confirmDeposit"]);
});

// ---- vault action relay (for the Policy Service) ----

test("vault relay submits operator-signed actions in order through the chain port, once per version", async () => {
  const h = harness();
  const actions = [
    { type: "setPolicy", version: 3, perTxCap: "1", dailyCap: "2", minReserve: "0", operator_signature: "0xaa" },
    { type: "setPayees", version: 4, payees: [CLIENT], allowed: true, operator_signature: "0xbb" },
  ];
  const r = await relayVaultActions(h.chain, VAULT, actions);
  assert.deepEqual(r.transactions.map((t) => [t.type, t.version]), [["setPolicy", 3], ["setPayees", 4]]);
  await relayVaultActions(h.chain, VAULT, actions); // same versions again: same transactions, nothing new sent
  assert.deepEqual(h.sent.filter((x) => x.startsWith("set")), ["setPolicy:3", "setPayees:4"]);
  await assert.rejects(relayVaultActions(h.chain, "0x12", actions), (e: unknown) => e instanceof ApiError && e.status === 400);
  await assert.rejects(relayVaultActions(h.chain, VAULT, []), (e: unknown) => e instanceof ApiError && e.status === 400);
});

test("escalated settlement: new_plan closes the plan with nothing paid or minted, and the agent can be asked again", async () => {
  const h = harness({ decision: "escalated" });
  await fundedAndReleased(h);
  const first: any = await h.orchestrator.settle(M1);
  assert.equal(first.decision, "escalated");
  const r: any = await h.orchestrator.executeApproval(M1, first.approval_id, { decision: "new_plan", operator_signature: "0xsig" });
  assert.equal(r.decision, "new_plan_requested");
  assert.equal(r.next, `POST /milestones/${M1}/settle`);
  assert.equal(h.sent.includes("vaultExecute"), false);
  assert.equal(h.receipts.size, 0);
  const row = h.db.prepare("SELECT state FROM milestones WHERE id = ?").get(M1) as { state: string };
  assert.equal(row.state, "released"); // still waiting for a settlement
  // A new settlement runs (a new plan, a new Policy decision).
  const before = h.submitted.length;
  const second: any = await h.orchestrator.settle(M1);
  assert.equal(h.submitted.length, before + 1);
  assert.ok(second.plan_id === undefined || second.plan_id !== first.plan_id);
  // An unknown decision is refused before anything is relayed.
  await assert.rejects(h.orchestrator.executeApproval(M1, first.approval_id, { decision: "approve_all", operator_signature: "0xsig" }),
    (e: unknown) => e instanceof ApiError && e.status === 400);
});
