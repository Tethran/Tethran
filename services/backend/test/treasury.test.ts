import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors";
import { signStripePayload, verifyStripeSignature, StripeSignatureError } from "../src/stripe";
import { centsToBaseUnits } from "../src/treasury";
import { ARBITER, CLIENT, M1, PROVIDER, TREASURY, VAULT, WEBHOOK_SECRET, harness } from "./helpers";

const status = async (p: Promise<unknown>, code: number, errCode?: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.status === code && (errCode === undefined || e.code === errCode));
};
const create = (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) =>
  h.treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000, ...over } as never);

// ---- milestone creation: arbiter and vault are chosen by the backend ----

test("create: the backend picks the platform arbiter and the provider's vault, checked on-chain", async () => {
  const h = harness();
  const m = await create(h);
  assert.deepEqual([m.arbiter_address, m.vault, m.provider_address, m.state, m.amount], [ARBITER, VAULT, PROVIDER, "draft", "100000000"]);
});

test("create: refuses an unknown provider, a duplicate id, bad input, and a client who is a party already", async () => {
  const h = harness();
  await status(create(h, { provider_id: "nobody" }), 404);
  await create(h);
  await status(create(h), 409);
  await status(create(h, { id: "not-a-uuid" }), 400);
  await status(create(h, { id: "22222222-2222-4222-8222-222222222222", client_address: "0x12" }), 400);
  await status(create(h, { id: "22222222-2222-4222-8222-222222222222", client_address: ARBITER }), 400);
  await status(create(h, { id: "22222222-2222-4222-8222-222222222222", client_address: PROVIDER }), 400);
  await status(create(h, { id: "22222222-2222-4222-8222-222222222222", amount_usd_cents: 0 }), 400);
});

test("create: refuses a vault whose on-chain payout address is not the provider in the record", async () => {
  const h = harness();
  h.db.prepare("UPDATE vaults SET provider_payout = ?").run(CLIENT);
  await status(create(h), 409, "VAULT_MISMATCH");
});

test("centsToBaseUnits: 1 USD = 1 test USDT (simulated), integers only", () => {
  assert.equal(centsToBaseUnits(12_345), "123450000");
  assert.throws(() => centsToBaseUnits(1.5));
  assert.throws(() => centsToBaseUnits(-1));
});

// ---- stablecoin deposit (demo simplification) ----

test("deposit: confirmed transfer from the client funds the escrow once, and the milestone is verified on-chain", async () => {
  const h = harness();
  await create(h);
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  const r = await h.treasury.confirmDeposit(M1, tx);
  assert.equal(r.milestone.state, "funded");
  assert.equal(r.milestone.funding_source, "stablecoin");
  assert.equal(h.escrow.get(M1)?.cardFunded, false);
  const again = await h.treasury.confirmDeposit(M1, tx);
  assert.equal(again.escrow_tx, r.escrow_tx);
  assert.equal(h.sent.filter((s) => s === "createAndFund").length, 1);
});

test("deposit: refuses no transfer, a transfer from someone else, too little, and a bad hash", async () => {
  const h = harness();
  await create(h);
  await status(h.treasury.confirmDeposit(M1, "0x" + "01".repeat(32)), 409, "DEPOSIT_NOT_FOUND");
  h.deposits.set("0x" + "02".repeat(32), [{ from: ARBITER, to: TREASURY, value: "100000000" }]);
  await status(h.treasury.confirmDeposit(M1, "0x" + "02".repeat(32)), 409, "DEPOSIT_NOT_FOUND");
  h.deposits.set("0x" + "03".repeat(32), [{ from: CLIENT, to: TREASURY, value: "99999999" }]);
  await status(h.treasury.confirmDeposit(M1, "0x" + "03".repeat(32)), 409, "DEPOSIT_TOO_SMALL");
  await status(h.treasury.confirmDeposit(M1, "0x12"), 400);
  assert.equal(h.escrow.size, 0);
});

test("deposit instructions name the treasury, the token, the exact amount and the client", async () => {
  const h = harness();
  await create(h);
  const d = h.treasury.depositInstructions(M1);
  assert.deepEqual([d.deposit_address, d.amount, d.from], [TREASURY, "100000000", CLIENT]);
  assert.match(d.note, /Demo simplification/);
});

test("funding: a mismatching on-chain milestone is refused and the milestone stays unusable", async () => {
  const h = harness();
  await create(h);
  h.db.prepare("UPDATE milestones SET vault = ?").run(CLIENT); // the record says one vault ...
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  const real = h.chain.milestone.bind(h.chain);
  h.chain.milestone = async (id) => ({ ...(await real(id)), vault: VAULT }); // ... the chain shows another
  await status(h.treasury.confirmDeposit(M1, tx), 409, "FUNDING_MISMATCH");
  assert.equal((h.db.prepare("SELECT status FROM fundings").get() as { status: string }).status, "mismatch");
});

// ---- Stripe webhook ----

const event = (over: Record<string, unknown> = {}, obj: Record<string, unknown> = {}) => JSON.stringify({
  id: "evt_1", type: "checkout.session.completed",
  data: { object: { id: "cs_1", payment_intent: "pi_1", payment_status: "paid", amount_total: 10_000, currency: "usd", metadata: { milestone_id: M1 }, ...obj } },
  ...over,
});
const signed = (h: ReturnType<typeof harness>, body: string) => signStripePayload(body, WEBHOOK_SECRET, Math.floor(h.now().getTime() / 1000));

test("stripe: a verified paid checkout funds the escrow card-funded with the hold; the conversion is labelled simulated", async () => {
  const h = harness();
  await create(h);
  const body = event();
  const r = await h.treasury.handleStripeWebhook(body, signed(h, body));
  assert.deepEqual([r.outcome, r.duplicate], ["funded", false]);
  assert.equal(h.escrow.get(M1)?.cardFunded, true);
  assert.equal(h.escrow.get(M1)?.holdSeconds, 600);
  assert.deepEqual(h.sent, ["mint", "createAndFund"]); // test USDT minted for the simulated conversion
});

test("stripe: the same event twice is handled once; a second event for the same payment funds nothing new", async () => {
  const h = harness();
  await create(h);
  const body = event();
  await h.treasury.handleStripeWebhook(body, signed(h, body));
  const again = await h.treasury.handleStripeWebhook(body, signed(h, body));
  assert.deepEqual([again.duplicate, again.outcome], [true, "funded"]);
  const pi = event({ id: "evt_2", type: "payment_intent.succeeded" }, { id: "pi_1", amount_received: 10_000 });
  assert.equal((await h.treasury.handleStripeWebhook(pi, signed(h, pi))).outcome, "funded");
  assert.equal(h.sent.filter((s) => s === "createAndFund").length, 1);
});

test("stripe: bad, missing, stale or forged signatures are refused before anything happens", async () => {
  const h = harness();
  await create(h);
  const body = event();
  await status(h.treasury.handleStripeWebhook(body, undefined), 400, "BAD_SIGNATURE");
  await status(h.treasury.handleStripeWebhook(body, signStripePayload(body, "whsec_other", Math.floor(h.now().getTime() / 1000))), 400, "BAD_SIGNATURE");
  await status(h.treasury.handleStripeWebhook(body, signStripePayload(body, WEBHOOK_SECRET, Math.floor(h.now().getTime() / 1000) - 301)), 400, "BAD_SIGNATURE");
  await status(h.treasury.handleStripeWebhook(event({}, { amount_total: 1 }), signed(h, body)), 400, "BAD_SIGNATURE"); // body changed after signing
  assert.equal(h.escrow.size, 0);
});

test("stripe: wrong amount or currency, unpaid sessions and events without a milestone do not fund", async () => {
  const h = harness();
  await create(h);
  for (const [i, obj] of [{ amount_total: 9_999 }, { currency: "eur" }, { payment_status: "unpaid" }, { metadata: {} }].entries()) {
    const body = event({ id: `evt_x${i}` }, obj);
    const r = await h.treasury.handleStripeWebhook(body, signed(h, body));
    assert.notEqual(r.outcome, "funded");
  }
  assert.equal(h.escrow.size, 0);
});

test("verifyStripeSignature accepts any matching v1 among several and rejects a malformed header", () => {
  const body = "{}";
  const good = signStripePayload(body, WEBHOOK_SECRET, 1000).split(",")[1];
  verifyStripeSignature(body, `t=1000,v1=${"00".repeat(32)},${good}`, WEBHOOK_SECRET, 1000);
  assert.throws(() => verifyStripeSignature(body, "garbage", WEBHOOK_SECRET, 1000), StripeSignatureError);
  assert.throws(() => verifyStripeSignature(body, signStripePayload(body, WEBHOOK_SECRET, 1000), "", 1000), StripeSignatureError);
});

// ---- release, chargeback, refund ----

test("release: only after the client approved, then once", async () => {
  const h = harness();
  await create(h);
  h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, 'Kofi Mensah Ltd', 'Kofi Mensah Ltd', 'SIM-T')").run(M1); // simulated verification
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  await status(h.treasury.release(M1), 409);
  h.chain.approve(M1);
  const r = await h.treasury.release(M1);
  assert.equal(r.milestone.state, "released");
  assert.equal((await h.treasury.release(M1)).already, true);
  assert.equal(h.bal(VAULT), 100_000_000n);
});

test("release: an identity mismatch holds the release (simulated identity check)", async () => {
  const h = harness();
  await create(h);
  h.db.prepare("INSERT INTO identity_records VALUES (?, 'Ada Okafor', 'Someone Else', 'SIM-1')").run(M1);
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  h.chain.approve(M1);
  await status(h.treasury.release(M1), 409, "IDENTITY_MISMATCH");
  assert.equal(h.escrow.get(M1)?.state, "Approved");
});

test("card: release waits for the hold; a chargeback during the hold refunds the escrow to the treasury", async () => {
  const h = harness();
  await create(h);
  h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, 'Kofi Mensah Ltd', 'Kofi Mensah Ltd', 'SIM-T')").run(M1); // simulated verification
  const body = event();
  await h.treasury.handleStripeWebhook(body, signed(h, body));
  h.chain.approve(M1);
  await status(h.treasury.release(M1), 409, "HOLD_ACTIVE");
  const dispute = JSON.stringify({ id: "evt_d", type: "charge.dispute.created", data: { object: { id: "dp_1", metadata: { milestone_id: M1 } } } });
  const r = await h.treasury.handleStripeWebhook(dispute, signed(h, dispute));
  assert.match(r.outcome, /^refunded/);
  assert.equal(h.escrow.get(M1)?.state, "Refunded");
});

test("card: after the hold a chargeback is flagged for a human, not refunded", async () => {
  const h = harness();
  await create(h);
  h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, 'Kofi Mensah Ltd', 'Kofi Mensah Ltd', 'SIM-T')").run(M1); // simulated verification
  const body = event();
  await h.treasury.handleStripeWebhook(body, signed(h, body));
  h.chain.approve(M1);
  h.advance(601);
  assert.match((await h.treasury.chargeback(M1)).outcome, /^flagged/);
  await h.treasury.release(M1);
});

test("refund: refused before the timeout, done after it, with the off-chain leg labelled simulated", async () => {
  const h = harness();
  await create(h);
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  await status(h.treasury.refund(M1), 409, "TIMEOUT_NOT_REACHED");
  h.advance(7 * 24 * 3600);
  const r = await h.treasury.refund(M1);
  assert.equal(r.milestone.state, "refunded");
  assert.equal(r.offchain_refund?.simulated, true);
  assert.equal(h.bal(TREASURY), 100_000_000n);
});

test("strict identity: no identity record holds the release and opens an operator hold", async () => {
  const h = harness();
  await create(h);
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  h.chain.approve(M1);
  await status(h.treasury.release(M1), 409, "IDENTITY_MISMATCH");
  const hold = h.db.prepare("SELECT status, reason FROM identity_holds WHERE milestone_id = ?").get(M1) as { status: string; reason: string };
  assert.deepEqual([hold.status, hold.reason], ["open", "no verified identity on file for this payment"]);
  assert.equal(h.escrow.get(M1)?.state, "Approved");
});
