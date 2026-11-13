// Review findings 3 to 10 (lead, 13 Nov 2026), one test or more each.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ApiError } from "../src/errors";
import { createHttpServer } from "../src/http";
import { openTreasuryIssues } from "../src/issues";
import { migrateReconciliation, reconciliationRoutes } from "../src/reconciliation";
import { assertWebhookSecret, signStripePayload } from "../src/stripe";
import { centsToBaseUnits, DEPOSIT_CLOCK_SLACK_S, maxMilestoneCents } from "../src/treasury";
import { CLIENT, M1, TREASURY, WEBHOOK_SECRET, fundedAndReleased, harness } from "./helpers";

type H = ReturnType<typeof harness>;
const create = (h: H, id = M1, cents = 10_000) =>
  h.treasury.createMilestone({ id, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: cents });
const event = (id: string, obj: Record<string, unknown> = {}) => JSON.stringify({
  id, type: "checkout.session.completed",
  data: { object: { id: "cs_" + id, payment_intent: "pi_" + id, payment_status: "paid", amount_total: 10_000, currency: "usd", metadata: { milestone_id: M1 }, ...obj } },
});
const sign = (h: H, body: string) => signStripePayload(body, WEBHOOK_SECRET, Math.floor(h.now().getTime() / 1000));
const code = (c: string) => (e: unknown) => e instanceof ApiError && e.code === c;

// ---- 3. webhook: a refused funding is recorded, a refund is queued, Stripe gets 200 ----

test("3. a second card payment for an already funded milestone: recorded, refund queued, answered without an error", async () => {
  const h = harness();
  await create(h);
  const first = event("evt_a");
  assert.equal((await h.treasury.handleStripeWebhook(first, sign(h, first))).outcome, "funded");
  const second = event("evt_b"); // a different payment (pi_evt_b) for the same milestone
  const r = await h.treasury.handleStripeWebhook(second, sign(h, second));
  assert.match(r.outcome, /^refund needed/);
  const issues = openTreasuryIssues(h.db);
  assert.equal(issues.length, 1);
  assert.deepEqual([issues[0]!.kind, issues[0]!.reference, issues[0]!.milestone_id], ["refund_needed", "stripe:pi_evt_b", M1]);
  // Stripe retries the same event: it is a duplicate, not a second issue.
  const again = await h.treasury.handleStripeWebhook(second, sign(h, second));
  assert.equal(again.duplicate, true);
  assert.equal(openTreasuryIssues(h.db).length, 1);
  // It shows in the reconciliation queue for a person.
  migrateReconciliation(h.db);
  const routes = reconciliationRoutes({ db: h.db, now: h.now });
  const q: any = await routes.find(([m, re]) => m === "GET" && re.test("/reconciliation/queue"))![2]({ params: [] as never, body: undefined, url: new URL("http://x/reconciliation/queue") });
  assert.ok(q.items.some((i: any) => i.kind === "refund_needed" && i.milestone_id === M1));
});

test("3. a wrong amount is a refund too; a transient chain failure is not recorded so Stripe retries", async () => {
  const h = harness();
  await create(h);
  const wrong = event("evt_w", { amount_total: 9_999 });
  assert.match((await h.treasury.handleStripeWebhook(wrong, sign(h, wrong))).outcome, /refund needed/);
  assert.equal(openTreasuryIssues(h.db).length, 1);
  // Chain down: an error (5xx), no event row, so the same event can be delivered again.
  const realMint = h.chain.mintTestUsdt;
  h.chain.mintTestUsdt = async () => { throw new Error("rpc down"); }; // the card conversion step fails
  const body = event("evt_t");
  await assert.rejects(h.treasury.handleStripeWebhook(body, sign(h, body)), (e: unknown) => e instanceof ApiError && e.status >= 500);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE event_id = 'evt_t'").get()!.n, 0);
  // When the chain is back, Stripe's retry of the same event funds the milestone.
  h.chain.mintTestUsdt = realMint;
  assert.equal((await h.treasury.handleStripeWebhook(body, sign(h, body))).outcome, "funded");
});

// ---- 4. one pending funding per milestone ----

test("4. a second payment while another is still being funded is refused; a retry of the same payment is fine", async () => {
  const h = harness();
  await create(h);
  h.db.prepare("INSERT INTO fundings (milestone_id, source, reference, amount, chain_id, timeout_at, escrow_tx, status, at) VALUES (?, 'card', 'stripe:pi_1', '100000000', 31337, 0, NULL, 'pending', 'now')").run(M1);
  await assert.rejects(h.treasury.fund(M1, "card", "stripe:pi_2"), code("FUNDING_IN_PROGRESS"));
  const r = await h.treasury.fund(M1, "card", "stripe:pi_1"); // the same reference resumes
  assert.equal(r.milestone.state, "funded");
});

// ---- 5. deposits: our token, a successful tx on our chain, after the milestone existed ----

test("5. a deposit made before the milestone was created is not counted", async () => {
  const h = harness();
  await create(h);
  const created = Math.floor(h.now().getTime() / 1000);
  const tx = "0x" + "ee".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000", blockTime: created - DEPOSIT_CLOCK_SLACK_S - 1 }]);
  await assert.rejects(h.treasury.confirmDeposit(M1, tx), code("DEPOSIT_NOT_FOUND"));
  // Within the clock slack it counts.
  const ok = "0x" + "ef".repeat(32);
  h.deposits.set(ok, [{ from: CLIENT, to: TREASURY, value: "100000000", blockTime: created - 30 }]);
  h.add(TREASURY, 100_000_000n);
  assert.equal((await h.treasury.confirmDeposit(M1, ok)).milestone.state, "funded");
});
// (The token-contract, success and chain checks are in services/chain/test/depositLogs.test.ts.)

// ---- 6. webhook secret at startup ----

test("6. outside DEMO_MODE an empty, placeholder, short or simulated webhook secret refuses to start", () => {
  for (const bad of [undefined, "", "whsec_test", "changeme", "whsec_short", "whsec_simulated_" + "a".repeat(40)]) {
    assert.throws(() => assertWebhookSecret(bad, false), /STRIPE_WEBHOOK_SECRET/, String(bad));
  }
  assert.doesNotThrow(() => assertWebhookSecret("whsec_" + "Z9".repeat(16), false));
  assert.doesNotThrow(() => assertWebhookSecret(undefined, true)); // DEMO_MODE: the simulated checkout
});

// ---- 7. amount bounds ----

test("7. amounts must be safe whole cents and at most the configured maximum", async () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, "100" as never]) {
    assert.throws(() => centsToBaseUnits(bad), (e: unknown) => e instanceof ApiError && e.status === 400, String(bad));
  }
  assert.equal(centsToBaseUnits(10_000_000), "100000000000");
  assert.throws(() => centsToBaseUnits(10_000_001), code("AMOUNT_TOO_LARGE"));
  assert.throws(() => centsToBaseUnits(501, 500), code("AMOUNT_TOO_LARGE"));
  assert.equal(maxMilestoneCents({ MAX_MILESTONE_USD_CENTS: "500" } as never), 500);
  assert.throws(() => maxMilestoneCents({ MAX_MILESTONE_USD_CENTS: "lots" } as never));
  const h = harness();
  await assert.rejects(create(h, M1, 10_000_001), code("AMOUNT_TOO_LARGE"));
});

// ---- 8. identity hold, retried release ----

test("8. a retried release on an identity mismatch keeps one hold, opened at the first attempt", async () => {
  const h = harness();
  await create(h);
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, 'Bola Trading Co', 'Kofi Mensah Ltd', 'SIM-T')").run(M1);
  h.chain.approve(M1);
  await assert.rejects(h.treasury.release(M1), code("IDENTITY_MISMATCH"));
  const first = h.db.prepare("SELECT opened_at FROM identity_holds WHERE milestone_id = ?").get(M1) as { opened_at: string };
  h.advance(60);
  await assert.rejects(h.treasury.release(M1), code("IDENTITY_MISMATCH"));
  const rows = h.db.prepare("SELECT opened_at FROM identity_holds WHERE milestone_id = ?").all(M1) as { opened_at: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.opened_at, first.opened_at);
});

// ---- 9. no raw body or signature in traces ----

test("9. a webhook trace carries the milestone id only: never the raw body or the signature", async () => {
  const h = harness();
  await create(h);
  const body = event("evt_trace");
  const sig = sign(h, body);
  await h.treasury.handleStripeWebhook(body, sig);
  const traced = JSON.stringify([h.tracer.runs, h.tracer.records]);
  assert.ok(h.tracer.runs.some((r) => r.name === "treasury.handleStripeWebhook"));
  assert.ok(!traced.includes(sig), "signature in a trace");
  assert.ok(!traced.includes(sig.split("v1=")[1]!), "signature digest in a trace");
  assert.ok(!traced.includes("cs_evt_trace") && !traced.includes("payment_status"), "raw body in a trace");
});

// ---- 10. no public route reaches release, refund or settle; funding only through verified paths ----

async function serve(h: H, platformToken = "platform-secret") {
  const server = createHttpServer({ db: h.db, treasury: h.treasury, orchestrator: h.orchestrator, now: h.now, internalToken: "internal-secret", platformToken } as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, headers: Record<string, string> = {}, body?: string) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body ?? "{}" });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  return { post, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("10. release, refund and settle need the platform token; the internal token or none is refused", async () => {
  const h = harness();
  await create(h);
  const s = await serve(h);
  try {
    for (const action of ["release", "refund", "settle"]) {
      for (const headers of [{}, { "x-platform-token": "wrong" }, { "x-internal-token": "internal-secret" }] as Record<string, string>[]) {
        const r = await s.post(`/milestones/${M1}/${action}`, headers);
        assert.equal(r.status, 401, `${action} ${JSON.stringify(headers)}`);
        assert.equal(r.json.code, "PLATFORM_ONLY");
      }
    }
    // With the platform token the request reaches the treasury (which then applies its own state rules).
    const ok = await s.post(`/milestones/${M1}/release`, { "x-platform-token": "platform-secret" });
    assert.notEqual(ok.status, 401);
  } finally { await s.close(); }
});

test("10. with no platform token configured, the platform routes refuse everyone", async () => {
  const h = harness();
  await fundedAndReleased(h);
  const s = await serve(h, "");
  try {
    assert.equal((await s.post(`/milestones/${M1}/settle`, { "x-platform-token": "" })).status, 401);
  } finally { await s.close(); }
});

test("10. card funding has no public route except the signature-verified webhook; an unsigned or forged event funds nothing", async () => {
  const h = harness();
  await create(h);
  const s = await serve(h);
  try {
    const body = event("evt_pub");
    assert.equal((await s.post("/webhooks/stripe", {}, body)).status, 400); // no signature
    assert.equal((await s.post("/webhooks/stripe", { "stripe-signature": signStripePayload(body, "whsec_forged_" + "x".repeat(20), Math.floor(h.now().getTime() / 1000)) }, body)).status, 400);
    assert.equal(h.sent.includes("createAndFund"), false);
    // No route funds directly.
    assert.equal((await s.post(`/milestones/${M1}/fund`, { "x-platform-token": "platform-secret" })).status, 404);
    // The simulated checkout routes exist only when a simulated checkout is configured (DEMO_MODE in main.ts).
    assert.equal((await s.post("/checkout/sessions/x/complete")).status, 404);
    // The verified webhook funds.
    const ok = await s.post("/webhooks/stripe", { "stripe-signature": sign(h, body) }, body);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.outcome, "funded");
  } finally { await s.close(); }
});
