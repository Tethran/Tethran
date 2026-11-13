// Indicative FX rates (v0.12) with the provider mocked: success, failure and timeout fall back, stale cache, the
// 6-hour cache, and the rate locked to a milestone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFxService, FX_ATTRIBUTION, FX_CACHE_MS } from "../src/fx";
import { createAdapters } from "../src/payouts";

const OK = { result: "success", time_last_update_utc: "Fri, 13 Nov 2026 00:02:31 +0000", rates: { USD: 1, NGN: 1350.459083, GHS: 11.716289, KES: 130.03512, ZAR: 16.735572, UGX: 4023.50343, TZS: 2641.513483 } };
function setup(responses: (() => Promise<Response>)[]) {
  let t = new Date("2026-11-13T10:00:00Z");
  let calls = 0;
  const fakeFetch = (async () => { const r = responses[Math.min(calls, responses.length - 1)]; calls++; return r(); }) as unknown as typeof fetch;
  const fx = createFxService({ db: new DatabaseSync(":memory:"), now: () => t, fetch: fakeFetch, timeoutMs: 50 });
  return { fx, calls: () => calls, advance: (ms: number) => { t = new Date(t.getTime() + ms); } };
}
const json = (b: unknown, status = 200) => async () => new Response(JSON.stringify(b), { status });

test("success: real indicative rates with the provider's last-updated date and the attribution", async () => {
  const s = setup([json(OK)]);
  await s.fx.refresh();
  const r = s.fx.current("KES");
  assert.equal(r.rateMicro, 130_035_120n);
  assert.equal(r.source, "exchangerate-api");
  assert.equal(r.label, "Indicative rate, last updated 13 Nov 2026");
  assert.deepEqual(r.attribution, FX_ATTRIBUTION);
  assert.equal(FX_ATTRIBUTION.text, "Rates By Exchange Rate API");
});

test("the cache lasts 6 hours: no second call inside it, one after it", async () => {
  const s = setup([json(OK)]);
  await s.fx.refresh();
  s.advance(FX_CACHE_MS - 60_000);
  await s.fx.refresh();
  assert.equal(s.calls(), 1);
  s.advance(120_000);
  await s.fx.refresh();
  assert.equal(s.calls(), 2);
});

test("failure with nothing cached: the sample table, labelled as such, without attribution", async () => {
  for (const fail of [json({}, 503), json({ result: "error" }), async () => { throw new Error("ECONNREFUSED"); }]) {
    const s = setup([fail]);
    await s.fx.refresh();
    const r = s.fx.current("NGN");
    assert.equal(r.source, "sample");
    assert.equal(r.rateMicro, 1_500_000_000n);
    assert.match(r.label, /^Sample rate/);
    assert.equal(r.attribution, null);
  }
});

test("a slow API times out and a stale cache is kept, still labelled with its own last-updated date", async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 200)); return new Response(JSON.stringify(OK)); };
  const s = setup([json(OK), slow]);
  await s.fx.refresh();
  s.advance(FX_CACHE_MS + 1);
  await s.fx.refresh();
  assert.equal(s.fx.lastError(), "timeout");
  const r = s.fx.current("ZAR");
  assert.equal(r.source, "exchangerate-api (cached)");
  assert.equal(r.rateMicro, 16_735_572n);
  assert.equal(r.label, "Indicative rate, last updated 13 Nov 2026");
});

test("a milestone keeps the rate locked at creation, whatever the rates do later", async () => {
  const later = { ...OK, time_last_update_utc: "Sat, 14 Nov 2026 00:02:31 +0000", rates: { ...OK.rates, KES: 140 } };
  const s = setup([json(OK), json(later)]);
  await s.fx.refresh();
  s.fx.lock("M1");
  s.fx.lock("M1"); // a second lock keeps the first
  s.advance(FX_CACHE_MS + 1);
  await s.fx.refresh();
  assert.equal(s.fx.current("KES").rateMicro, 140_000_000n);
  const locked = s.fx.rateFor("KES", "M1");
  assert.equal(locked.rateMicro, 130_035_120n);
  assert.equal(locked.locked, true);
  assert.equal(locked.label, "Indicative rate, last updated 13 Nov 2026");
  assert.equal(s.fx.rateFor("KES", "M2").rateMicro, 140_000_000n, "an unlocked milestone uses today's rate");
});

test("a payout quote uses the milestone's locked indicative rate; the payout itself stays simulated", async () => {

  const s = setup([json(OK)]);
  await s.fx.refresh();
  s.fx.lock("M1");
  const a = createAdapters(() => new Date("2026-11-13T10:00:00Z"), s.fx);
  const q = await a.mpesa.quote({ rail: "mpesa", amount: "100000000", milestone_id: "M1" });
  assert.equal(q.simulated, true, "the M-Pesa payout is simulated");
  assert.equal(q.fx.simulated, false);
  assert.equal(q.fx.indicative, true);
  assert.equal(q.fx.source, "exchangerate-api");
  assert.match(q.fx.label, /^Indicative rate, last updated 13 Nov 2026: 1 USDT = 130\.03 KES$/); // shown to 2 decimals, truncated like every amount
  assert.equal(q.local_amount, "12808.45"); // 98.5 USDT net x 130.03512 = 12808.4593, truncated
  assert.deepEqual(q.fx.attribution, { ...FX_ATTRIBUTION });
});
