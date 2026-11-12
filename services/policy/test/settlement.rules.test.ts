// Review findings 1 and 2 (lead, 13 Nov 2026): payouts need a released escrow milestone, and one milestone is
// settled at most once, within its budget, using the Policy Service's own record of what it signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProposal } from "../src/engine";
import { openDecisionStore } from "../src/stores";
import { goodProposal, makeCtx, milestoneOf, withActions } from "./helpers";
import { escalatingProposal, makeHarness, signApproval, submit } from "./service-helpers";

const pick = (r: { decision: string; reasons: string[] }) => [r.decision, r.reasons];
const payout = (amount: string, payee_id = "payee-1") => ({ type: "payout", payee_id, amount, asset: "USDT" });
const tax = (amount: string) => ({ type: "tax_reserve", amount, reason: "tax" });

// ---- 1. MILESTONE_NOT_RELEASED ----

test("engine: a payout for a milestone that is not released is rejected, for any funding source", () => {
  for (const cardFunded of [false, true]) {
    const ctx = makeCtx({ milestone: milestoneOf("500000000", { cardFunded, releaseEligible: false, released: false }) });
    const r = evaluateProposal(goodProposal(), ctx);
    assert.equal(r.decision, "rejected");
    assert.ok(r.reasons.includes("MILESTONE_NOT_RELEASED"), `cardFunded=${cardFunded}: ${r.reasons}`);
  }
  // Stablecoin-funded and not released: only the release rule (no card hold).
  const r = evaluateProposal(goodProposal(), makeCtx({ milestone: milestoneOf("500000000", { released: false }) }));
  assert.deepEqual(pick(r), ["rejected", ["MILESTONE_NOT_RELEASED"]]);
});

test("engine: released milestone passes; a plan that moves no money is not rejected for the release rule", () => {
  assert.equal(evaluateProposal(goodProposal(), makeCtx({ milestone: milestoneOf("500000000") })).decision, "approved");
  const none = evaluateProposal(withActions([]), makeCtx({ milestone: milestoneOf("500000000", { released: false }) }));
  assert.deepEqual(pick(none), ["escalated", ["NO_PAYOUTS"]]);
});

test("service: the release fact comes from the chain reader, not from the caller", async () => {
  const h = makeHarness();
  h.fake.facts = { ...h.fake.facts, released: false };
  const r = await submit(h, { ...goodProposal() });
  assert.equal(r.decision, "rejected");
  assert.ok(r.reasons.includes("MILESTONE_NOT_RELEASED"));
  assert.equal(r.cosignatures, undefined);
});

// ---- 2. cumulative budget and ALREADY_SETTLED ----

test("engine: earlier approved allocations count against the milestone amount (exact boundary)", () => {
  const m = milestoneOf("500000000"); // 500; the 10% tax rule applies
  // 450 + 50 already approved for this milestone: nothing is left.
  const spent = makeCtx({ milestone: m, settled: { approvedCount: 0, allocated: "400000000" } });
  assert.deepEqual(pick(evaluateProposal(withActions([payout("50000000"), tax("50000000")]), spent)), ["approved", []]); // 400 + 100 = 500
  assert.ok(evaluateProposal(withActions([payout("50000001"), tax("50000000")]), spent).reasons.includes("OVER_MILESTONE_AMOUNT"));
});

test("engine: any plan for a milestone that already has an approved settlement is ALREADY_SETTLED", () => {
  const settled = makeCtx({ milestone: milestoneOf("500000000"), settled: { approvedCount: 1, allocated: "500000000" } });
  const r = evaluateProposal(goodProposal(), settled);
  assert.equal(r.decision, "rejected");
  assert.ok(r.reasons.includes("ALREADY_SETTLED") && r.reasons.includes("OVER_MILESTONE_AMOUNT"));
  // Even a plan that pays nobody (it would otherwise be escalated NO_PAYOUTS).
  assert.deepEqual(pick(evaluateProposal(withActions([]), settled)), ["rejected", ["ALREADY_SETTLED"]]);
  // The context must carry the facts.
  assert.throws(() => evaluateProposal(goodProposal(), makeCtx({ settled: { approvedCount: -1, allocated: "0" } })));
  assert.throws(() => evaluateProposal(goodProposal(), makeCtx({ settled: { approvedCount: 0, allocated: "1.5" } })));
});

test("service: two different proposals for one milestone are never both approved", async () => {
  const h = makeHarness();
  const first = await submit(h, goodProposal());
  assert.equal(first.decision, "approved");
  // A different plan (different split, so a different hash) for the same milestone.
  const other = { ...goodProposal(), actions: [payout("400000000"), tax("50000000")] };
  const second = await submit(h, other);
  assert.equal(second.decision, "rejected");
  assert.ok(second.reasons.includes("ALREADY_SETTLED"));
  assert.equal(second.cosignatures, undefined);
});

test("service: two escalated plans for one milestone; the operator approves both; only the first is signed", async () => {
  const h = makeHarness();
  const a = await submit(h, escalatingProposal());
  const b = await submit(h, { ...escalatingProposal(), actions: [payout("400000000"), tax("50000000")] });
  assert.equal(a.decision, "escalated");
  assert.equal(b.decision, "escalated");
  const sa = await signApproval(h.operator, a.approval_id!, "approve", a.proposal_hash);
  const ra = await h.service.decideApproval(a.approval_id!, { decision: "approve", operator_signature: sa });
  assert.equal(ra.decision, "approved");
  const sb = await signApproval(h.operator, b.approval_id!, "approve", b.proposal_hash);
  const rb = await h.service.decideApproval(b.approval_id!, { decision: "approve", operator_signature: sb });
  assert.equal(rb.decision, "rejected"); // the rules run again on approval, and the milestone is settled
  assert.ok(rb.reasons.includes("ALREADY_SETTLED"));
  assert.equal((rb as { cosignatures?: unknown }).cosignatures, undefined);
});

test("service: another milestone is unaffected by a settled one", async () => {
  const h = makeHarness();
  assert.equal((await submit(h, goodProposal())).decision, "approved");
  const otherMilestone = { ...goodProposal(), milestone_id: "33333333-3333-4333-8333-333333333333" };
  assert.equal((await submit(h, otherMilestone)).decision, "approved");
});

test("store: settledFor counts only signed proposals of that milestone; old rows without a milestone count for none", () => {
  const d = openDecisionStore(":memory:");
  assert.deepEqual(d.settledFor("m-1"), { approvedCount: 0, allocated: "0" });
  d.markSigned("h1", "m-1", "450000000");
  d.markSigned("h2", "m-2", "10");
  d.markSigned("h1", "m-1", "450000000"); // same hash again: ignored
  assert.deepEqual(d.settledFor("m-1"), { approvedCount: 1, allocated: "450000000" });
  assert.deepEqual(d.settledFor("m-2"), { approvedCount: 1, allocated: "10" });
  assert.throws(() => d.markSigned("h3", "m-1", "-5"));
  assert.ok(d.signedHashes().has("h1") && d.signedHashes().has("h2"));
});

test("store migration: an existing signed_proposals table without the new columns is upgraded in place", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "tethran-policy-")), "decisions.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE signed_proposals (proposal_hash TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')))");
  old.prepare("INSERT INTO signed_proposals (proposal_hash) VALUES ('old-hash')").run();
  old.close();
  const d = openDecisionStore(path);
  assert.ok(d.signedHashes().has("old-hash")); // still a duplicate
  assert.deepEqual(d.settledFor("m-1"), { approvedCount: 0, allocated: "0" }); // counts for no milestone
  d.markSigned("new-hash", "m-1", "5");
  assert.deepEqual(d.settledFor("m-1"), { approvedCount: 1, allocated: "5" });
  d.close();
});
