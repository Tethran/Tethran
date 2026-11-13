// Tethran's 5% platform fee in the backend: the fee line the orchestrator adds, a wrong fee from the agent passed on
// unchanged (the Policy Service rejects it: services/policy/test/fee.test.ts), replays rebuilt with the fee, and no
// fee on a refund.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPlatformFee } from "../src/orchestrator";
import { instantiate, type SavedProposal } from "../src/replay";
import { createSimulatedCheckout } from "../src/checkout";
import { CLIENT, harness, fundedAndReleased, M1, WEBHOOK_SECRET } from "./helpers";

const create = (h: ReturnType<typeof harness>) =>
  h.treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000 });
const simulated = (h: ReturnType<typeof harness>) =>
  createSimulatedCheckout({ db: h.db, webhookSecret: WEBHOOK_SECRET, treasury: () => h.treasury, publicBaseUrl: "http://app.test", now: h.now });

const payout = (amount: string, payee_id = "payee_amara") => ({ type: "payout", payee_id, amount, asset: "USDT" });

test("the orchestrator adds the exact 5% fee line to a plan that pays, and only then", () => {
  const p = withPlatformFee({ actions: [payout("85000000"), { type: "tax_reserve", amount: "10000000" }] }, "100000000");
  assert.deepEqual(p.actions.at(-1), { type: "payout", payee_id: "tethran_earnings", amount: "5000000", asset: "USDT" });
  // A plan that pays nobody gets no fee line (it is escalated NO_PAYOUTS, never approved automatically).
  assert.equal(withPlatformFee({ actions: [{ type: "tax_reserve", amount: "10000000" }] }, "100000000").actions.length, 1);
});

test("a wrong fee from the agent is passed on unchanged, so the Policy Service sees it and rejects it (FEE_MISMATCH)", async () => {
  const wrong = { actions: [payout("86000000"), payout("4000000", "tethran_earnings"), { type: "tax_reserve", amount: "10000000", reason: "tax" }] };
  assert.deepEqual(withPlatformFee(wrong, "100000000"), wrong);
  // Through the orchestrator: the submitted plan carries the agent's 4 USDT fee line, not a corrected one.
  const h = harness({ decision: "rejected", reply: { milestone_id: M1, confidence: 0.9, evidence_used: ["ev-1"], flags: [], needs_human: false, actions: wrong.actions } });
  await fundedAndReleased(h);
  const r: any = await h.orchestrator.settle(M1);
  assert.equal(r.decision, "rejected");
  const feeLines = h.submitted[0].proposal.actions.filter((a: any) => a.payee_id === "tethran_earnings");
  assert.deepEqual(feeLines.map((a: any) => a.amount), ["4000000"]);
  assert.equal(h.sent.includes("vaultExecute"), false);
});

test("replay: the saved split is rebuilt as gross - tax - fee, plus the exact fee line", () => {
  const saved: SavedProposal = {
    scenario: "clean_delivery", source: "test",
    proposal: { confidence: 0.9, evidence_used: [], flags: [], needs_human: false, actions: [
      { type: "payout", payee_id: "payee_amara", amount_ppm: 600_000 },
      { type: "mobile_money_payout", payee_id: "payee_kofi", amount_ppm: 300_000, provider: "mpesa" },
      { type: "tax_reserve", amount_ppm: 100_000, reason: "tax" },
    ] },
  };
  const input: any = { milestone: { id: M1, gross_amount: "400000000" }, platform_fee: { payee_id: "tethran_earnings", amount: "20000000" } };
  const p: any = instantiate(saved, input);
  const amounts = p.actions.map((a: any) => [a.payee_id ?? a.type, a.amount]);
  // 400 gross: 40 tax, 20 fee, 340 left split 2:1 -> 226.666666 and 113.333334 (the last takes the remainder).
  assert.deepEqual(amounts, [["payee_amara", "226666666"], ["payee_kofi", "113333334"], ["tax_reserve", "40000000"], ["tethran_earnings", "20000000"]]);
  const total = p.actions.reduce((n: bigint, a: any) => n + BigInt(a.amount), 0n);
  assert.equal(total, 400_000_000n);
});

test("a refund takes no fee: nothing is paid to the earnings account", async () => {
  const h = harness();
  await create(h);
  const sim = simulated(h);
  const s = await sim.provider.createSession({ milestone_id: M1, method: "card", amount_usd_cents: 10_000, title: "t", success_url: "a", cancel_url: "b" });
  await sim.complete(s.session_id, "paid");
  h.chain.approve(M1);
  const d: any = await sim.dispute(s.session_id);
  assert.match(d.webhook.outcome, /^refunded/);
  assert.equal(h.escrow.get(M1)?.state, "Refunded");
  assert.equal(h.bal("0x00000000000000000000000000000000000000e0"), 0n);
  assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE payee_id = 'tethran_earnings'").get() as any).n, 0);
});
