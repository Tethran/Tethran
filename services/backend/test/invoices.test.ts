import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAmounts, markInvoicePaid, markInvoicePaidForMilestone } from "../src/invoices";
import { clientWallet, contractBody, expectApi, insertEscrowRow, providerWallet, setup, signedContract } from "./contractFixtures";

const invoiceFor = (s: ReturnType<typeof setup>, mid: string, body: object = {}) => s.call("POST", `/milestones/${mid}/invoice`, body);

test("invoice: country fields, line items, sequential number per provider and year", async () => {
  const s = setup();
  const c = await signedContract(s);
  const a = await invoiceFor(s, c.milestones[0].id, { provider_tax_ids: { TIN: "1234567-0001" } });
  const b = await invoiceFor(s, c.milestones[1].id);
  assert.equal(a.number, "INV-2026-0001");
  assert.equal(b.number, "INV-2026-0002");
  assert.equal(a.country, "NG");
  assert.deepEqual(a.provider_tax_ids, { TIN: "1234567-0001" });
  assert.deepEqual(a.missing_required_fields, []);
  assert.deepEqual(b.missing_required_fields, ["provider_tax_ids.TIN"]);
  assert.deepEqual(a.line_items, [{ description: "Brand identity pack", quantity: 1, unit_amount_cents: 10_000, amount_cents: 10_000 }]);
  assert.equal(a.due_date, "2026-03-15");
  assert.equal(a.status, "unpaid");
  assert.equal(a.pay_url, `https://pay.example.test/pay/${a.id}`);

  // another provider starts at 0001; the next year restarts at 0001
  const other = await signedContract(s, { provider_id: "prov-2" });
  assert.equal((await invoiceFor(s, other.milestones[0].id)).number, "INV-2026-0001");
  s.clock.t = new Date("2027-01-05T00:00:00Z");
  const next = await signedContract(s);
  assert.equal((await invoiceFor(s, next.milestones[0].id)).number, "INV-2027-0001");
  assert.equal((await invoiceFor(s, c.milestones[0].id)).number, "INV-2026-0001");
});

test("invoice: refused for an unsigned contract, unknown milestone, bad fee payer or tax field", async () => {
  const s = setup();
  const draft = await s.call("POST", "/contracts", contractBody());
  await expectApi(invoiceFor(s, draft.milestones[0].id), 409, "NOT_SIGNED");
  await expectApi(invoiceFor(s, "00000000-0000-4000-8000-000000000000"), 404);
  const c = await signedContract(s);
  await expectApi(invoiceFor(s, c.milestones[0].id, { fee_payer: "nobody" }), 400);
  await expectApi(invoiceFor(s, c.milestones[0].id, { provider_tax_ids: { KRA_PIN: "A1" } }), 400);
});

test("fees: Tethran's 5% platform fee, paid by the freelancer; the client pays exactly the subtotal", async () => {
  const s = setup();
  const c = await signedContract(s);
  // The old client-paid fee is gone.
  await expectApi(invoiceFor(s, c.milestones[0].id, { fee_payer: "client" }), 400);
  // 10,000 cents: 5% = 500; the client pays 10,000; the freelancer receives 9,500
  const a = await invoiceFor(s, c.milestones[0].id);
  assert.deepEqual([a.subtotal_cents, a.fee_cents, a.total_cents, a.provider_payout_cents, a.fee_payer], [10_000, 500, 10_000, 9_500, "provider"]);
  // 25,050 cents: 5% = 1,252.5, rounded half up to 1,253
  const b = await invoiceFor(s, c.milestones[1].id, { fee_payer: "provider" });
  assert.deepEqual([b.subtotal_cents, b.fee_cents, b.total_cents, b.provider_payout_cents], [25_050, 1_253, 25_050, 23_797]);
});

test("fees: the model is configurable and integer only", () => {
  assert.deepEqual(computeAmounts(999, "client", { bps: 250, fixed_cents: 0 }), { fee_cents: 25, total_cents: 1024, payout_cents: 999 });
  assert.deepEqual(computeAmounts(1000, "provider", { bps: 0, fixed_cents: 50 }), { fee_cents: 50, total_cents: 1000, payout_cents: 950 });
  assert.throws(() => computeAmounts(20, "provider", { bps: 100, fixed_cents: 30 }));
});

test("invoice creation is idempotent per milestone", async () => {
  const s = setup();
  const c = await signedContract(s);
  const a = await invoiceFor(s, c.milestones[0].id, { fee_payer: "provider" });
  const b = await invoiceFor(s, c.milestones[0].id, { fee_payer: "provider" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.deepEqual({ ...b, created: undefined }, { ...a, created: undefined });
  assert.equal((await s.call("GET", "/invoices")).invoices.length, 1);
  const ms = (await s.call("GET", `/contracts/${c.id}/milestones`)).milestones;
  assert.equal(ms[0].invoice_number, "INV-2026-0001");
});

test("public pay payload: link, QR data, no client email or wallet", async () => {
  const s = setup();
  const c = await signedContract(s);
  const inv = await invoiceFor(s, c.milestones[0].id, { fee_payer: "provider" });
  const pay = await s.call("GET", `/pay/${inv.id}`);
  assert.deepEqual(pay, {
    invoice_id: inv.id, invoice_number: "INV-2026-0001", provider_name: "Amara Design Studio", amount_usd_cents: 10_000, currency: "USD",
    due_date: "2026-03-15", status: "unpaid", escrow_milestone_id: c.milestones[0].id,
    pay_url: `https://pay.example.test/pay/${inv.id}`, qr_data: `https://pay.example.test/pay/${inv.id}`, payment_options_endpoint: "/checkout/options",
  });
  const text = JSON.stringify(pay).toLowerCase();
  assert.ok(!text.includes("kofi@example.test"));
  assert.ok(!text.includes(clientWallet.address.toLowerCase()));
  assert.ok(!text.includes(providerWallet.address.toLowerCase()));
  assert.ok(!text.includes("kofi traders"));
  await expectApi(s.call("GET", "/pay/nope"), 404);
  insertEscrowRow(s.db, c.milestones[0].id, "funded");
  assert.equal((await s.call("GET", `/pay/${inv.id}`)).status, "paid");
});

test("default public base URL", async () => {
  delete process.env.PUBLIC_BASE_URL;
  const s = setup();
  s.env.publicBaseUrl = undefined as never;
  const c = await signedContract(s);
  const inv = await invoiceFor(s, c.milestones[0].id);
  assert.equal(inv.pay_url, `http://localhost:3000/pay/${inv.id}`);
});

test("receipts exist only after payment (escrow row, or markInvoicePaid); chain link fields are nullable", async () => {
  const s = setup();
  const c = await signedContract(s);
  const a = await invoiceFor(s, c.milestones[0].id, { fee_payer: "provider" });
  const b = await invoiceFor(s, c.milestones[1].id);
  await expectApi(s.call("GET", `/invoices/${a.id}/receipt`), 409, "NOT_PAID");
  insertEscrowRow(s.db, c.milestones[0].id, "draft");
  await expectApi(s.call("GET", `/invoices/${a.id}/receipt`), 409, "NOT_PAID");
  s.db.exec("UPDATE milestones SET state = 'funded'");
  const r = await s.call("GET", `/invoices/${a.id}/receipt`);
  assert.equal(r.receipt_for, "INV-2026-0001");
  assert.equal(r.total_paid_cents, 10_000);
  assert.equal(r.escrow_state, "funded");
  assert.equal(r.receipt_token_id, null);
  assert.equal(r.chain_id, null);
  s.db.prepare("INSERT INTO receipts (milestone_id, chain_id, token_id, mint_tx, holder, invoice_hash, settlement_hash, at) VALUES (?, 11155111, 7, '0xtx', '0xh', '0xi', '0xs', 'x')").run(c.milestones[0].id);
  const r2 = await s.call("GET", `/invoices/${a.id}/receipt`);
  assert.deepEqual([r2.receipt_token_id, r2.chain_id], [7, 11155111]);

  await expectApi(s.call("GET", `/invoices/${b.id}/receipt`), 409);
  markInvoicePaid(s.db, b.id, "pi_test_123", new Date("2026-03-03T00:00:00Z"));
  markInvoicePaid(s.db, b.id, "pi_other", new Date("2026-03-04T00:00:00Z"));
  const r3 = await s.call("GET", `/invoices/${b.id}/receipt`);
  assert.deepEqual([r3.payment_reference, r3.paid_at], ["pi_test_123", "2026-03-03T00:00:00.000Z"]);
  assert.equal(markInvoicePaidForMilestone(s.db, "00000000-0000-4000-8000-000000000000", "x"), 0);
});

test("unpaid tracker lists unpaid invoices with days overdue", async () => {
  const s = setup();
  const c = await signedContract(s);
  const a = await invoiceFor(s, c.milestones[0].id); // due 2026-03-15
  await invoiceFor(s, c.milestones[1].id); // due 2026-04-15
  s.clock.t = new Date("2026-03-20T12:00:00Z");
  let list = (await s.call("GET", "/invoices?status=unpaid")).invoices;
  assert.deepEqual(list.map((i: any) => [i.number, i.days_overdue]), [["INV-2026-0001", 5], ["INV-2026-0002", 0]]);
  markInvoicePaid(s.db, a.id, "ref");
  list = (await s.call("GET", "/invoices?status=unpaid")).invoices;
  assert.deepEqual(list.map((i: any) => i.number), ["INV-2026-0002"]);
  assert.equal((await s.call("GET", "/invoices?status=paid")).invoices.length, 1);
  await expectApi(s.call("GET", "/invoices?status=weird"), 400);
});

test("reminders: 3 days before, on the due date and 7 days after, each sent once, simulated", async () => {
  const s = setup();
  const c = await signedContract(s);
  const a = await invoiceFor(s, c.milestones[0].id); // due 2026-03-15
  const run = async (iso: string) => (await s.call("POST", "/invoices/reminders/run", { now: iso }));
  assert.deepEqual((await run("2026-03-10T09:00:00Z")).reminders, []);
  const r1 = await run("2026-03-12T09:00:00Z");
  assert.deepEqual(r1.reminders.map((r: any) => r.kind), ["before_due"]);
  assert.equal(r1.reminders[0].simulated, true);
  assert.equal(r1.simulated, true);
  assert.deepEqual((await run("2026-03-12T18:00:00Z")).reminders, []);
  assert.deepEqual((await run("2026-03-14T09:00:00Z")).reminders, []);
  assert.deepEqual((await run("2026-03-15T09:00:00Z")).reminders.map((r: any) => r.kind), ["due_today"]);
  assert.deepEqual((await run("2026-03-15T10:00:00Z")).reminders, []);
  const r4 = await run("2026-03-22T09:00:00Z");
  assert.deepEqual(r4.reminders.map((r: any) => [r.kind, r.days_overdue]), [["overdue_7", 7]]);
  assert.deepEqual((await run("2026-04-30T09:00:00Z")).reminders, []);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM invoice_reminders WHERE invoice_id = ?").get(a.id)!.n, 3);
});

test("reminders: a paid invoice gets none, a late first run sends only the latest kind", async () => {
  const s = setup();
  const c = await signedContract(s);
  const a = await invoiceFor(s, c.milestones[0].id);
  const b = await invoiceFor(s, c.milestones[1].id);
  markInvoicePaid(s.db, a.id, "ref");
  const r = await s.call("POST", "/invoices/reminders/run", { now: "2026-05-01T00:00:00Z" });
  assert.deepEqual(r.reminders.map((x: any) => [x.invoice_id, x.kind]), [[b.id, "overdue_7"]]);
  await expectApi(s.call("POST", "/invoices/reminders/run", { now: "yesterday" }), 400);
});

test("recurring invoices: issued when due, idempotent across repeated runs, stop at the count", async () => {
  const s = setup();
  const body = contractBody();
  (body.milestones[0] as any).recurrence = { frequency: "monthly", count: 3 }; // due 03-15, 04-15, 05-15
  const c = await signedContract(s, body);
  await invoiceFor(s, c.milestones[0].id, { fee_payer: "provider" });
  const run = (iso: string) => s.call("POST", "/invoices/recurring/run", { now: iso });
  assert.deepEqual((await run("2026-03-20T00:00:00Z")).issued, []);
  const r1 = await run("2026-04-08T00:00:00Z");
  assert.equal(r1.issued.length, 1);
  assert.deepEqual([r1.issued[0].number, r1.issued[0].due_date, r1.issued[0].fee_payer, r1.issued[0].total_cents, r1.issued[0].occurrence], ["INV-2026-0002", "2026-04-15", "provider", 10_000, 1]);
  assert.deepEqual((await run("2026-04-08T00:00:00Z")).issued, []);
  assert.deepEqual((await run("2026-04-20T00:00:00Z")).issued, []);
  const r2 = await run("2026-06-01T00:00:00Z");
  assert.deepEqual(r2.issued.map((i: any) => [i.number, i.due_date]), [["INV-2026-0003", "2026-05-15"]]);
  assert.deepEqual((await run("2027-06-01T00:00:00Z")).issued, []);
  assert.equal((await s.call("GET", "/invoices")).invoices.length, 3);
  // a recurring occurrence has its own escrow id and an activation body for it
  const occ = r1.issued[0];
  assert.notEqual(occ.escrow_milestone_id, c.milestones[0].id);
  const act = await s.call("POST", `/invoices/${occ.id}/activate`);
  assert.deepEqual([act.id, act.invoice_ref, act.amount_usd_cents], [occ.escrow_milestone_id, "INV-2026-0002", 10_000]);
});

test("recurring: weekly with an end date, contract-level recurrence, month-end clamping", async () => {
  const s = setup();
  const body = contractBody({ recurrence: { frequency: "weekly", end_date: "2026-03-29" } });
  (body.milestones[0] as any).due_date = "2026-03-01";
  const c = await signedContract(s, body);
  await invoiceFor(s, c.milestones[0].id);
  const r = await s.call("POST", "/invoices/recurring/run", { now: "2026-12-01T00:00:00Z" });
  assert.deepEqual(r.issued.map((i: any) => i.due_date), ["2026-03-08", "2026-03-15", "2026-03-22", "2026-03-29"]);

  const s2 = setup();
  const b2 = contractBody();
  (b2.milestones[0] as any).due_date = "2026-01-31";
  (b2.milestones[0] as any).recurrence = { frequency: "monthly", count: 3 };
  const c2 = await signedContract(s2, b2);
  await invoiceFor(s2, c2.milestones[0].id);
  const r2 = await s2.call("POST", "/invoices/recurring/run", { now: "2026-12-01T00:00:00Z" });
  assert.deepEqual(r2.issued.map((i: any) => i.due_date), ["2026-02-28", "2026-03-31"]);
});
