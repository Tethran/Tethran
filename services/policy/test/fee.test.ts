// Tethran's 5% platform fee: computed deterministically (fee.ts) and enforced by the Policy Service (FEE_MISMATCH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProposal } from "../src/engine";
import { EARNINGS_PAYEE_ID, PLATFORM_FEE_BPS, platformFee } from "../src/fee";
import { EARNINGS_ADDR, makeCtx, milestoneOf, policy, withActions } from "./helpers";
import { makeHarness, submit } from "./service-helpers";
import { openPolicyStore } from "../src/stores";

const FEE = { bps: PLATFORM_FEE_BPS, payeeId: EARNINGS_PAYEE_ID, address: EARNINGS_ADDR };
const payees = {
  "payee-1": { address: "0x00000000000000000000000000000000000000a1", rail: "usdt", simulated: false },
  [EARNINGS_PAYEE_ID]: { address: EARNINGS_ADDR, rail: "usdt", simulated: false },
};
const pol = { ...policy, payee_allowlist: ["payee-1", EARNINGS_PAYEE_ID] };
const ctx = (over: Record<string, unknown> = {}) => makeCtx({ policy: pol, payees, platformFee: FEE, milestone: milestoneOf("500000000"), ...over } as never);
const payout = (amount: string, payee_id = "payee-1") => ({ type: "payout", payee_id, amount, asset: "USDT" });
const fee = (amount = "25000000") => payout(amount, EARNINGS_PAYEE_ID);
const tax = (amount = "50000000") => ({ type: "tax_reserve", amount, reason: "tax" });
const pick = (r: { decision: string; reasons: string[] }) => [r.decision, r.reasons];

test("fee: 5% of the gross, round half up in base units; exact for whole cents", () => {
  assert.equal(PLATFORM_FEE_BPS, 500);
  assert.equal(platformFee(500_000_000n), 25_000_000n); // $500 -> $25
  assert.equal(platformFee(400_000_000n), 20_000_000n);
  assert.equal(platformFee(10n), 1n); // 0.5 rounds up
  assert.equal(platformFee(9n), 0n); // 0.45 rounds down
  for (const cents of [1n, 99n, 12_345n, 10_000_000n]) assert.equal(platformFee(cents * 10_000n), cents * 500n);
  assert.throws(() => platformFee(-1n));
});

test("correct fee: net to the freelancer, 5% to the earnings account, 10% tax reserve of the gross -> approved", () => {
  const r = evaluateProposal(withActions([payout("425000000"), fee(), tax()]), ctx());
  assert.deepEqual(pick(r), ["approved", []]);
});

test("a missing, wrong, doubled or mobile-money fee line is FEE_MISMATCH", () => {
  for (const actions of [
    [payout("450000000"), tax()], // missing
    [payout("426000000"), fee("24000000"), tax()], // wrong amount (budget still fine)
    [payout("400000000"), fee("12500000"), fee("12500000"), tax()], // doubled
    [payout("425000000"), { type: "mobile_money_payout", payee_id: EARNINGS_PAYEE_ID, amount: "25000000", provider: "mpesa" }, tax()],
  ]) {
    const r = evaluateProposal(withActions(actions), ctx());
    assert.equal(r.decision, "rejected");
    assert.ok(r.reasons.includes("FEE_MISMATCH" as never), JSON.stringify(r.reasons));
  }
});

test("the earnings payee resolving to any other address is FEE_MISMATCH", () => {
  const other = { ...payees, [EARNINGS_PAYEE_ID]: { address: "0x00000000000000000000000000000000000000ee", rail: "usdt", simulated: false } };
  const r = evaluateProposal(withActions([payout("425000000"), fee(), tax()]), ctx({ payees: other }));
  assert.deepEqual(pick(r), ["rejected", ["FEE_MISMATCH"]]);
});

test("the fee line counts for the budget and the caps", () => {
  // 450 + 25 + 50 = 525 > 500: over the milestone.
  assert.ok(evaluateProposal(withActions([payout("450000000"), fee(), tax()]), ctx()).reasons.includes("OVER_MILESTONE_AMOUNT"));
  // A per-payment cap below the fee refuses the fee line itself.
  const capped = { ...pol, per_tx_cap: "20000000", per_tx_soft_limit: "20000000" };
  assert.ok(evaluateProposal(withActions([payout("425000000"), fee(), tax()]), ctx({ policy: capped })).reasons.includes("OVER_PER_TX_CAP"));
  // The daily cap counts the fee: 1,980 already today + 425 + 25 > 2,000.
  assert.ok(evaluateProposal(withActions([payout("425000000"), fee(), tax()]), ctx({ spentTodayBaseUnits: "1580000000" })).reasons.includes("OVER_DAILY_CAP"));
});

test("a plan that moves no money needs no fee line (escalated, not FEE_MISMATCH)", () => {
  const r = evaluateProposal(withActions([tax()]), ctx());
  assert.equal(r.decision, "escalated");
  assert.ok(!r.reasons.includes("FEE_MISMATCH" as never));
});

test("service: the fee line is co-signed to the configured earnings address; a wrong fee is rejected with nothing signed", async () => {
  const base = makeHarness();
  base.fake.allowed.add(EARNINGS_ADDR.toLowerCase());
  const h = makeHarness({
    platformFee: FEE,
    policyStore: openPolicyStore(":memory:", pol),
    chain: { ...base.chain, async payees() { return payees; } },
  });
  h.fake.allowed.add(EARNINGS_ADDR.toLowerCase());
  const proposal = (actions: unknown[], id: string) => ({ milestone_id: id, confidence: 0.9, evidence_used: ["ev-1"], actions, flags: [], needs_human: false });
  const wrong = await submit(h, proposal([payout("426000000"), fee("24000000"), tax()], "11111111-1111-4111-8111-111111111111"), "t-wrong");
  assert.deepEqual([wrong.decision, wrong.cosignatures], ["rejected", undefined]);
  assert.ok(wrong.reasons.includes("FEE_MISMATCH" as never));
  const ok = await submit(h, proposal([payout("425000000"), fee(), tax()], "22222222-2222-4222-8222-222222222222"), "t-ok");
  assert.equal(ok.decision, "approved");
  const feeSig = ok.cosignatures!.find((c) => c.amount === "25000000")!;
  assert.equal(feeSig.to.toLowerCase(), EARNINGS_ADDR);
  assert.equal(ok.cosignatures!.length, 2);
});
