// One test per branch of the decision (lead's rules, 13 Nov 2026):
// - SCHEMA_INVALID always rejects.
// - Hard rules (duplicate, hold, payee, caps, reserves) run only when the proposal has money-moving actions; any
//   violation rejects.
// - A proposal with no money-moving actions is escalated, with reason codes; never rejected for a hard rule.
// - needs_human=true is never approved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INJECTION_FLAG_CODES, evaluateProposal, hashProposal } from "../src/engine";
import { goodProposal, makeCtx, milestoneOf, policy, withActions } from "./helpers";

const pick = (r: { decision: string; reasons: string[] }) => [r.decision, r.reasons];
const payout = (amount: string, payee_id = "payee-1") => ({ type: "payout", payee_id, amount, asset: "USDT" });
const tax = (amount: string) => ({ type: "tax_reserve", amount, reason: "tax" });
const noMoney = (extra: Record<string, unknown> = {}) => withActions([], extra);

// ---- schema ----
test("SCHEMA_INVALID rejects, with or without payouts, even when needs_human is set", () => {
  assert.deepEqual(pick(evaluateProposal({ ...goodProposal(), confidence: "high" }, makeCtx())), ["rejected", ["SCHEMA_INVALID"]]);
  assert.deepEqual(pick(evaluateProposal({ ...noMoney({ needs_human: true }), extra: 1 }, makeCtx())), ["rejected", ["SCHEMA_INVALID"]]);
  assert.deepEqual(pick(evaluateProposal(null, makeCtx())), ["rejected", ["SCHEMA_INVALID"]]);
});

// ---- no money-moving actions: never a hard-rule rejection ----
test("no payouts: the hard rules do not run (owed tax, duplicate hash, active hold, empty vault, reserve)", () => {
  const p = noMoney({ needs_human: true, confidence: 0.2 });
  const ctx = makeCtx({
    milestone: milestoneOf("100000000", { cardFunded: true, releaseEligible: false }), // owes tax; hold active
    seenProposalHashes: new Set([hashProposal(p)]),
    vaultBalance: "0",
    policy: { ...policy, vault_min_reserve: "1000000000", daily_cap: "0" },
    spentTodayBaseUnits: "999999999999",
  });
  const r = evaluateProposal(p, ctx);
  assert.equal(r.decision, "escalated");
  for (const hard of ["TAX_RESERVE_TOO_LOW", "DUPLICATE_PROPOSAL", "HOLD_ACTIVE", "BELOW_VAULT_RESERVE", "OVER_DAILY_CAP"]) {
    assert.ok(!r.reasons.includes(hard as never), hard);
  }
});

test("no payouts + needs_human: escalated NEEDS_HUMAN", () => {
  assert.deepEqual(pick(evaluateProposal(noMoney({ needs_human: true }), makeCtx({ milestone: milestoneOf("100000000") }))), ["escalated", ["NEEDS_HUMAN"]]);
});

test("no payouts + confidence below the threshold: escalated LOW_CONFIDENCE (boundary: exactly the threshold is not low)", () => {
  assert.deepEqual(pick(evaluateProposal(noMoney({ confidence: 0.69 }), makeCtx())), ["escalated", ["LOW_CONFIDENCE"]]);
  assert.deepEqual(pick(evaluateProposal(noMoney({ confidence: 0.7 }), makeCtx())), ["escalated", ["NO_PAYOUTS"]]);
});

test("no payouts + an injection flag: escalated INJECTION_FLAGGED, for every injection code", () => {
  for (const code of INJECTION_FLAG_CODES) {
    const r = evaluateProposal(noMoney({ flags: [{ code, detail: "evidence:ev-2" }] }), makeCtx());
    assert.deepEqual(pick(r), ["escalated", ["INJECTION_FLAGGED"]], code);
  }
});

test("no payouts + a non-injection flag only: escalated NO_PAYOUTS (a plan that pays nobody is never approved)", () => {
  const r = evaluateProposal(noMoney({ flags: [{ code: "EVIDENCE_UNCLEAR", detail: "x" }] }), makeCtx());
  assert.deepEqual(pick(r), ["escalated", ["NO_PAYOUTS"]]);
});

test("no payouts, all triggers at once: every reason is reported, in order", () => {
  const p = noMoney({ needs_human: true, confidence: 0.1, flags: [{ code: "INJECTION_SUSPECTED", detail: "x" }] });
  const r = evaluateProposal(p, makeCtx({ milestone: milestoneOf("0", { identityMatch: false }) }));
  assert.deepEqual(pick(r), ["escalated", ["LOW_CONFIDENCE", "NEEDS_HUMAN", "IDENTITY_MISMATCH", "INJECTION_FLAGGED"]]);
});

test("tax-reserve-only and conversion-only plans move no money: escalated, not rejected", () => {
  const ctx = makeCtx({ milestone: milestoneOf("100000000") });
  assert.deepEqual(pick(evaluateProposal(withActions([tax("1")]), ctx)), ["escalated", ["NO_PAYOUTS"]]);
  assert.deepEqual(pick(evaluateProposal(withActions([{ type: "conversion", amount: "5", target: "NGN", condition: "x" }]), ctx)), ["escalated", ["NO_PAYOUTS"]]);
});

// ---- money-moving actions: every hard rule rejects ----
test("payouts: each hard rule rejects on its own", () => {
  const cases: [string, Parameters<typeof makeCtx>[0], Record<string, unknown>][] = [
    ["HOLD_ACTIVE", { milestone: milestoneOf("0", { cardFunded: true, releaseEligible: false }) }, goodProposal()],
    ["PAYEE_NOT_ALLOWED", {}, withActions([payout("1", "payee-x")])],
    ["OVER_PER_TX_CAP", { policy: { ...policy, per_tx_soft_limit: policy.per_tx_cap } }, withActions([payout((BigInt(policy.per_tx_cap) + 1n).toString())])],
    ["OVER_DAILY_CAP", { spentTodayBaseUnits: policy.daily_cap }, withActions([payout("1")])],
    ["BELOW_VAULT_RESERVE", { vaultBalance: "0" }, withActions([payout("1")])],
    ["TAX_RESERVE_TOO_LOW", { milestone: milestoneOf("100000000") }, withActions([payout("90000000")])],
  ];
  for (const [code, ctx, p] of cases) {
    const r = evaluateProposal(p, makeCtx(ctx));
    assert.equal(r.decision, "rejected", code);
    assert.ok(r.reasons.includes(code as never), `${code}: got ${r.reasons}`);
  }
});

test("payouts: DUPLICATE_PROPOSAL rejects a hash already signed or pending", () => {
  const p = goodProposal();
  assert.deepEqual(pick(evaluateProposal(p, makeCtx({ seenProposalHashes: new Set([hashProposal(p)]) }))), ["rejected", ["DUPLICATE_PROPOSAL"]]);
});

test("payouts: a rejection wins over escalations (needs_human and an injection flag do not soften it)", () => {
  const p = withActions([payout("1", "payee-x")], { needs_human: true, flags: [{ code: "IGNORE_RULES", detail: "x" }] });
  assert.deepEqual(pick(evaluateProposal(p, makeCtx())), ["rejected", ["PAYEE_NOT_ALLOWED"]]);
});

test("payouts: the tax reserve is still required whenever money is paid out", () => {
  const ctx = makeCtx({ milestone: milestoneOf("100000000") }); // 10% of 100 = 10
  assert.equal(evaluateProposal(withActions([payout("90000000"), tax("10000000")]), ctx).decision, "approved");
  assert.deepEqual(pick(evaluateProposal(withActions([payout("90000000"), tax("9999999")]), ctx)), ["rejected", ["TAX_RESERVE_TOO_LOW"]]);
});

// ---- money-moving actions, no hard-rule violation: escalations ----
test("payouts within all limits: each escalation reason escalates", () => {
  const cases: [string, Parameters<typeof makeCtx>[0], Record<string, unknown>][] = [
    ["OVER_SOFT_LIMIT", {}, withActions([payout((BigInt(policy.per_tx_soft_limit) + 1n).toString())])],
    ["LOW_CONFIDENCE", {}, { ...goodProposal(), confidence: 0.5 }],
    ["NEEDS_HUMAN", {}, { ...goodProposal(), needs_human: true }],
    ["IDENTITY_MISMATCH", { milestone: milestoneOf("0", { identityMatch: false }) }, goodProposal()],
    ["INJECTION_FLAGGED", {}, { ...goodProposal(), flags: [{ code: "INJECTION_SUSPECTED", detail: "x" }] }],
  ];
  for (const [code, ctx, p] of cases) assert.deepEqual(pick(evaluateProposal(p, makeCtx(ctx))), ["escalated", [code]], code);
});

test("needs_human=true is never approved, whatever else is true", () => {
  for (const p of [{ ...goodProposal(), needs_human: true }, noMoney({ needs_human: true })]) {
    assert.notEqual(evaluateProposal(p, makeCtx()).decision, "approved");
  }
});

// ---- approval ----
test("payouts within all limits, confident, no flags, no human: approved with no reasons", () => {
  assert.deepEqual(pick(evaluateProposal(goodProposal(), makeCtx())), ["approved", []]);
  // A non-injection flag alone does not escalate a paying plan.
  assert.deepEqual(pick(evaluateProposal({ ...goodProposal(), flags: [{ code: "EVIDENCE_PARTIAL", detail: "x" }] }, makeCtx())), ["approved", []]);
});
