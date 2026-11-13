import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors";
import {
  MAGIC_FAIL_REJECTED, MAGIC_FAIL_TIMEOUT, createAdapters, migratePayouts, payoutRoutes, processConfirmedPayouts,
} from "../src/payouts";
import { M1, fundedAndReleased, harness } from "./helpers";

const clockAt = () => {
  let t = new Date("2026-11-12T10:00:00Z");
  return { now: () => t, advance: (s: number) => { t = new Date(t.getTime() + s * 1000); } };
};
const call = (routes: ReturnType<typeof payoutRoutes>, method: string, path: string, body?: unknown) => {
  const url = new URL(path, "http://localhost");
  const r = routes.find(([m, re]) => m === method && re.test(url.pathname))!;
  return r[2]({ params: r[1].exec(url.pathname)!.map((p) => decodeURIComponent(p)) as never, body, url });
};
const rejects = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) => e instanceof ApiError && e.status === status);

test("quotes: exact fee, net and simulated local amount per rail", async () => {
  const a = createAdapters(() => new Date());
  const mp = await a.mpesa.quote({ rail: "mpesa", amount: "100000000" });
  assert.deepEqual([mp.fee, mp.net_amount, mp.local_amount, mp.currency, mp.country, mp.expected_seconds], ["1500000", "98500000", "12706.50", "KES", "KE", 30]);
  assert.equal(mp.simulated, true);
  assert.match(mp.fx.label, /Simulated FX rate/);
  const mtn = await a.mtn_momo.quote({ rail: "mtn_momo", amount: "50000000" });
  assert.deepEqual([mtn.fee, mtn.net_amount, mtn.local_amount, mtn.currency], ["500000", "49500000", "767.25", "GHS"]);
  const air = await a.airtel.quote({ rail: "airtel", amount: "10000000", country: "KE" });
  assert.deepEqual([air.fee, air.local_amount, air.currency], ["120000", "1274.52", "KES"]);
  const bank = await a.bank.quote({ rail: "bank", amount: "100000000" });
  assert.deepEqual([bank.fee, bank.net_amount, bank.local_amount, bank.currency], ["1000000", "99000000", "148500.00", "NGN"]);
  const small = await a.bank.quote({ rail: "bank", amount: "2000000" }); // 0.5% is 10000, so the 1 USDT minimum applies
  assert.equal(small.fee, "1000000");
  const usdt = await a.usdt.quote({ rail: "usdt", amount: "7000000" });
  assert.deepEqual([usdt.fee, usdt.net_amount, usdt.expected_seconds, usdt.currency], ["0", "7000000", 0, "USDT"]);
});

test("quotes: bad input is refused", async () => {
  const a = createAdapters(() => new Date());
  await assert.rejects(a.mpesa.quote({ rail: "mpesa", amount: "1.5" }), ApiError);
  await assert.rejects(a.mpesa.quote({ rail: "mpesa", amount: "100000000", country: "GH" }), ApiError);
  await assert.rejects(a.bank.quote({ rail: "bank", amount: "1000000" }), ApiError); // fee would eat the whole amount
});

test("initiate is idempotent on the key; a different key gives another reference", async () => {
  const c = clockAt();
  const a = createAdapters(c.now);
  const r1 = await a.mpesa.initiate({ rail: "mpesa", amount: "100000000" }, "k1");
  c.advance(60);
  const r2 = await a.mpesa.initiate({ rail: "mpesa", amount: "100000000" }, "k1");
  assert.deepEqual(r2, r1);
  const r3 = await a.mpesa.initiate({ rail: "mpesa", amount: "100000000" }, "k2");
  assert.notEqual(r3.reference, r1.reference);
  assert.match(r1.reference, /^SIM-MPESA-[0-9A-F]{12}$/);
  await assert.rejects(a.mpesa.initiate({ rail: "mpesa", amount: "100000000" }, ""), ApiError);
});

test("status flow by clock: pending, processing, delivered", async () => {
  const c = clockAt();
  const a = createAdapters(c.now);
  const ref = await a.mpesa.initiate({ rail: "mpesa", amount: "100000000" }, "k");
  assert.equal((await a.mpesa.status(ref)).status, "pending");
  c.advance(5);
  assert.equal((await a.mpesa.status(ref)).status, "processing");
  c.advance(25);
  const done = await a.mpesa.status(ref);
  assert.equal(done.status, "delivered");
  assert.equal(done.simulated, true);
});

test("forced failures: option and magic amounts give a reason", async () => {
  const c = clockAt();
  const a = createAdapters(c.now);
  const t = await a.mtn_momo.initiate({ rail: "mtn_momo", amount: "20000000", fail: "timeout" }, "a");
  const r = await a.airtel.initiate({ rail: "airtel", amount: MAGIC_FAIL_REJECTED }, "b");
  const m = await a.mpesa.initiate({ rail: "mpesa", amount: MAGIC_FAIL_TIMEOUT }, "c");
  c.advance(3600);
  assert.deepEqual(await a.mtn_momo.status(t), { simulated: true, status: "failed", reason: "provider timeout (simulated)" });
  assert.match((await a.airtel.status(r)).reason!, /rejected/);
  assert.equal((await a.mpesa.status(m)).status, "failed");
});

test("UsdtSim: delivered as soon as it is initiated", async () => {
  const a = createAdapters(() => new Date("2026-11-12T10:00:00Z"));
  const ref = await a.usdt.initiate({ rail: "usdt", amount: "5000000" }, "u");
  assert.equal((await a.usdt.status(ref)).status, "delivered");
  assert.equal(ref.adapter, "UsdtSim");
});

test("processConfirmedPayouts: rail-correct legs, idempotent, skips unconfirmed", async () => {
  const h = harness();
  migratePayouts(h.db);
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  const first = await processConfirmedPayouts(h.db, h.now);
  assert.equal(first.count, 2);
  const again = await processConfirmedPayouts(h.db, h.now);
  assert.equal(again.count, 0);
  const legs = h.db.prepare("SELECT o.*, p.rail AS prail FROM offchain_payouts o JOIN payouts p ON p.id = o.payout_id ORDER BY o.payout_id").all() as any[];
  assert.equal(legs.length, 2);
  const usdt = legs.find((l) => l.prail === "usdt");
  const mp = legs.find((l) => l.prail === "mpesa");
  assert.deepEqual([usdt.adapter, usdt.status, usdt.fee, usdt.simulated], ["UsdtSim", "delivered", "0", 1]);
  assert.deepEqual([mp.adapter, mp.status, mp.fee, mp.local_amount, mp.currency], ["MobileMoneySim", "pending", "450000", "3811.95", "KES"]);
  // an unconfirmed payout gets no leg
  h.db.prepare("INSERT INTO payouts (plan_id, milestone_id, action_index, action_id, payee_id, rail, to_address, amount, chain_id, proposal_hash, deadline, policy_sig, tx, status, simulated, at) VALUES (1, ?, 9, 'x9', 'payee_kofi', 'mpesa', '0x0', '1000000', 31337, '0x', 0, '0x', NULL, 'failed', 1, 'now')").run(M1);
  assert.equal((await processConfirmedPayouts(h.db, h.now)).count, 0);
});

test("routes: list, get, quote, status advance and forced failure", async () => {
  const h = harness();
  migratePayouts(h.db);
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  const routes = payoutRoutes({ db: h.db, now: h.now });
  const q: any = await call(routes, "POST", "/payouts/quote", { rail: "mpesa", amount: "100000000", country: "KE" });
  assert.equal(q.fee, "1500000");
  await rejects(call(routes, "POST", "/payouts/quote", { rail: "paypal", amount: "1" }), 400);

  const list: any = await call(routes, "GET", `/payouts?milestone_id=${M1}`);
  assert.equal(list.payouts.length, 3); // incl. the platform fee line
  const kofi = list.payouts.find((p: any) => p.rail === "mpesa");
  assert.equal(kofi.offchain, null); // no leg until processing

  const s1: any = await call(routes, "POST", `/payouts/${kofi.id}/status`, {});
  assert.equal(s1.offchain.status, "pending");
  const s2: any = await call(routes, "POST", `/payouts/${kofi.id}/status`, { advance: true });
  assert.equal(s2.offchain.status, "processing");
  const s3: any = await call(routes, "POST", `/payouts/${kofi.id}/status`, { advance: true });
  assert.equal(s3.offchain.status, "delivered");
  const s4: any = await call(routes, "POST", `/payouts/${kofi.id}/status`, { advance: true });
  assert.equal(s4.offchain.status, "delivered");
  assert.equal(((await call(routes, "GET", `/payouts/${kofi.id}`)) as any).offchain.simulated, true);

  await rejects(call(routes, "GET", "/payouts/9999"), 404);
  await rejects(call(routes, "POST", `/payouts/${kofi.id}/status`, { fail: "nope" }), 400);
});

test("routes: forced failure on the demo path carries a reason", async () => {
  const h = harness();
  migratePayouts(h.db);
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  const routes = payoutRoutes({ db: h.db, now: h.now });
  const kofi = ((await call(routes, "GET", `/payouts?milestone_id=${M1}`)) as any).payouts.find((p: any) => p.rail === "mpesa");
  const f: any = await call(routes, "POST", `/payouts/${kofi.id}/status`, { fail: "rejected", advance: true });
  assert.equal(f.offchain.status, "processing");
  const f2: any = await call(routes, "POST", `/payouts/${kofi.id}/status`, { advance: true });
  assert.equal(f2.offchain.status, "failed");
  assert.match(f2.offchain.reason, /rejected/);
});
