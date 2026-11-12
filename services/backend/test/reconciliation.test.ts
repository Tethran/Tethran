import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors";
import { migratePayouts, processConfirmedPayouts } from "../src/payouts";
import { migrateReconciliation, reconciliationRoutes, setMilestoneCountry } from "../src/reconciliation";
import { CLIENT, M1, fundedAndReleased, harness } from "./helpers";

type H = ReturnType<typeof harness>;
const setup = () => {
  const h = harness();
  migrateReconciliation(h.db);
  return h;
};
const call = (h: H, method: string, path: string) => {
  const routes = reconciliationRoutes({ db: h.db, now: h.now });
  const url = new URL(path, "http://localhost");
  const r = routes.find(([m, re]) => m === method && re.test(url.pathname))!;
  return r[2]({ params: r[1].exec(url.pathname)!.map((p) => decodeURIComponent(p)) as never, body: undefined, url });
};
const ledger = async (h: H, id = M1): Promise<any> => call(h, "GET", `/reconciliation/milestones/${id}`);
const codes = (l: any) => l.gaps.map((g: any) => g.code);

async function fullySettled(h: H) {
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  await processConfirmedPayouts(h.db, h.now);
  h.advance(120); // the simulated M-Pesa leg is delivered after 30 seconds
  await processConfirmedPayouts(h.db, h.now);
}

test("complete chain: every record joined, no gaps", async () => {
  const h = setup();
  await fullySettled(h);
  const l = await ledger(h);
  assert.equal(l.complete, true);
  assert.deepEqual(l.gaps, []);
  assert.equal(l.state, "paid_out");
  assert.equal(l.payment.fundings[0].status, "funded");
  assert.ok(l.escrow_tx && l.release_tx);
  assert.equal(l.settlement_plan.decision, "paid_out");
  assert.ok(l.settlement_plan.trace_id);
  assert.equal(l.payouts.length, 2);
  assert.equal(l.offchain_legs.length, 2);
  assert.ok(l.receipt.mint_tx);
  assert.equal(l.receipt.token_id, 1);
  // 100 gross, 10 tax reserve, 60 + 30 paid on-chain, simulated M-Pesa fee 1.5% of 30 = 0.45
  assert.deepEqual(l.totals, { gross: "100000000", tax_reserve: "10000000", paid_onchain: "90000000", fees: "450000", net_paid: "89550000", fees_simulated: true });
});

test("gap: paid but not released", async () => {
  const h = setup();
  await h.treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000 });
  h.deposits.set("0x" + "dd".repeat(32), [{ from: CLIENT, to: "0x00000000000000000000000000000000000000a0", value: "100000000" }]);
  h.add("0x00000000000000000000000000000000000000a0", 100_000_000n);
  await h.treasury.confirmDeposit(M1, "0x" + "dd".repeat(32));
  const l = await ledger(h);
  assert.equal(l.complete, false);
  assert.deepEqual(codes(l), ["PAID_NOT_RELEASED"]);
});

test("gap: released but not settled", async () => {
  const h = setup();
  await fundedAndReleased(h);
  const l = await ledger(h);
  assert.deepEqual(codes(l), ["RELEASED_NOT_SETTLED"]);
  assert.equal(l.complete, false);
});

test("gap: settled but receipt missing", async () => {
  const h = setup();
  await fullySettled(h);
  h.db.prepare("DELETE FROM receipts").run();
  const l = await ledger(h);
  assert.deepEqual(codes(l), ["SETTLED_NO_RECEIPT"]);
  assert.equal(l.complete, false);
});

test("gap: on-chain payout confirmed but the off-chain leg failed", async () => {
  const h = setup();
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  await processConfirmedPayouts(h.db, h.now, { fail: (p) => (p.rail === "mpesa" ? "timeout" : undefined) });
  h.advance(120);
  await processConfirmedPayouts(h.db, h.now);
  const l = await ledger(h);
  assert.deepEqual(codes(l), ["OFFCHAIN_FAILED"]);
  assert.match(l.gaps[0].message, /provider timeout/);
  assert.deepEqual(l.gaps[0].record.table, "offchain_payouts");
  assert.equal(l.complete, false);
});

test("gaps: off-chain leg missing or in flight are informational; identity mismatch and funding failures are problems", async () => {
  const h = setup();
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  let l = await ledger(h);
  assert.deepEqual(codes(l), ["OFFCHAIN_LEG_MISSING", "OFFCHAIN_LEG_MISSING"]);
  await processConfirmedPayouts(h.db, h.now);
  l = await ledger(h);
  assert.deepEqual(codes(l), ["OFFCHAIN_IN_FLIGHT"]);
  assert.equal(l.gaps[0].severity, "info");
  h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, 'A Payer', 'Someone Else', 'sim-1')").run(M1);
  h.db.prepare("UPDATE fundings SET status = 'mismatch'").run();
  l = await ledger(h);
  assert.ok(codes(l).includes("IDENTITY_MISMATCH") && codes(l).includes("FUNDING_MISMATCH"));
});

test("unknown milestone is 404", async () => {
  const h = setup();
  await assert.rejects(ledger(h, "nope"), (e: unknown) => e instanceof ApiError && e.status === 404);
});

test("queue: failed funding, chargeback, rejected plan, failed leg, identity mismatch, each with reason and record", async () => {
  const h = setup();
  await fundedAndReleased(h);
  await h.orchestrator.settle(M1);
  await processConfirmedPayouts(h.db, h.now, { fail: (p) => (p.rail === "mpesa" ? "rejected" : undefined) });
  h.advance(120);
  await processConfirmedPayouts(h.db, h.now);
  h.db.prepare("INSERT INTO fundings (milestone_id, source, reference, amount, chain_id, timeout_at, escrow_tx, status, at) VALUES ('m2', 'card', 'ref-2', '1', 31337, 0, NULL, 'failed', 'now')").run();
  h.db.prepare("INSERT INTO stripe_events VALUES ('evt_1', 'charge.dispute.created', ?, 'flagged for a human: escrow is Released', 'now')").run(M1);
  h.db.prepare("INSERT INTO settlement_plans (milestone_id, proposal_json, proposal_hash, trace_id, decision, reasons, at) VALUES ('m3', NULL, NULL, 't3', 'rejected', '[\"OVER_PER_TX_CAP\"]', 'now')").run();
  h.db.prepare("INSERT INTO settlement_plans (milestone_id, proposal_json, proposal_hash, trace_id, decision, reasons, at) VALUES ('m4', NULL, NULL, 't4', 'escalated', '[\"LOW_CONFIDENCE\"]', 'now')").run();
  h.db.prepare("INSERT INTO identity_records VALUES ('m5', 'A', 'B', 'sim')").run();
  const q: any = await call(h, "GET", "/reconciliation/queue");
  const kinds = q.items.map((i: any) => i.kind).sort();
  assert.deepEqual(kinds, ["dispute_or_chargeback", "funding_failed", "identity_mismatch", "offchain_failed", "plan_escalated", "plan_rejected"]);
  assert.equal(q.count, 6);
  const rej = q.items.find((i: any) => i.kind === "plan_rejected");
  assert.match(rej.reason, /OVER_PER_TX_CAP/);
  assert.deepEqual(rej.record.table, "settlement_plans");
  assert.equal(q.items.find((i: any) => i.kind === "offchain_failed").simulated, true);
  assert.equal(q.items.find((i: any) => i.kind === "dispute_or_chargeback").record.id, "evt_1");
});

test("list: filters by date and country; counts complete", async () => {
  const h = setup();
  await fullySettled(h);
  const all: any = await call(h, "GET", "/reconciliation");
  assert.deepEqual([all.count, all.complete, all.items[0].country], [1, 1, "KE"]); // derived from the M-Pesa leg
  assert.equal(((await call(h, "GET", "/reconciliation?country=ng")) as any).count, 0);
  assert.equal(((await call(h, "GET", "/reconciliation?country=ke&from=2026-11-12&to=2026-11-12")) as any).count, 1);
  assert.equal(((await call(h, "GET", "/reconciliation?from=2027-01-01")) as any).count, 0);
  setMilestoneCountry(h.db, M1, "gh", "INV-GH-1");
  assert.equal(((await call(h, "GET", "/reconciliation?country=GH")) as any).items[0].invoice_number, "INV-GH-1");
  await assert.rejects(call(h, "GET", "/reconciliation?from=yesterday"), (e: unknown) => e instanceof ApiError && e.status === 400);
});

test("CSV: raw text/csv response with the tax columns and proper escaping", async () => {
  const h = setup();
  await fullySettled(h);
  setMilestoneCountry(h.db, M1, "KE", '=HYPERLINK("x"),"quoted"\nline');
  const res: any = await call(h, "GET", "/reconciliation/export.csv?country=KE");
  assert.equal(res.__raw, true);
  assert.equal(res.contentType, "text/csv");
  const lines: string = res.body;
  assert.ok(lines.startsWith("invoice_number,invoice_date,country,funded_at,settled_at,gross,fee,tax_reserve,net_paid,currency,chain_id,escrow_tx,release_tx,payout_txs,receipt_id,receipt_mint_tx,trace_id,complete\r\n"));
  // formula guard, doubled quotes, comma and newline kept inside quotes
  assert.ok(lines.includes('"\'=HYPERLINK(""x""),""quoted""\nline"'));
  assert.ok(lines.includes(",100.000000,0.450000,10.000000,89.550000,USDT,31337,"));
  assert.ok(lines.trimEnd().endsWith(",true"));
  const empty: any = await call(h, "GET", "/reconciliation/export.csv?country=NG");
  assert.equal(empty.body.trim().split("\r\n").length, 1);
});
