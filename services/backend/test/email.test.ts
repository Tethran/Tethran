// Invoice email with the Resend API mocked: sent once per invoice, outbox without config, reserved domains,
// allowlist, daily cap, provider errors without the key, and the message content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMailer, emailConfigFromEnv, FOOTER, invoiceMessage, type InvoiceMail } from "../src/email";

const KEY = "re_test_0123456789abcdef";
const mail = (over: Partial<InvoiceMail> = {}): InvoiceMail => ({
  invoiceId: "inv-1", number: "INV-2026-0001", to: "kofi@mensah-ltd.co", senderName: "Amara Studio", clientName: "Kofi Mensah Ltd",
  amountCents: 40_000, description: "Logo design", payUrl: "http://localhost:3000/pay/inv-1", ...over,
});
function setup(env: Record<string, string>, reply: (n: number) => Response | Promise<Response> = () => new Response(JSON.stringify({ id: "msg_1" }))) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(calls.length); }) as unknown as typeof fetch;
  const m = createMailer({ db: new DatabaseSync(":memory:"), config: emailConfigFromEnv(env as never), now: () => new Date("2026-11-13T10:00:00Z"), fetch: fakeFetch, timeoutMs: 200, retryDelaysMs: [5, 5, 5] });
  return { m, calls };
}
const CONF = { EMAIL_PROVIDER: "resend", EMAIL_API_KEY: KEY, EMAIL_FROM: "Tethran <invoices@tethran.example.dev>" };

test("configured: one invoice sends one email through Resend with the pay link and the footer", async () => {
  const s = setup(CONF);
  const r = await s.m.sendInvoice(mail());
  assert.deepEqual([r.status, r.provider_message_id], ["sent", "msg_1"]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, "https://api.resend.com/emails");
  assert.equal((s.calls[0].init.headers as any).authorization, `Bearer ${KEY}`);
  const body = JSON.parse(String(s.calls[0].init.body));
  assert.deepEqual(body.to, ["kofi@mensah-ltd.co"]);
  assert.match(body.text, /Amara Studio sent you invoice INV-2026-0001 for \$400\.00/);
  assert.match(body.text, /Pay it here: http:\/\/localhost:3000\/pay\/inv-1/);
  assert.ok(body.text.endsWith(FOOTER));
  // Retried: no second email.
  const again = await s.m.sendInvoice(mail());
  assert.deepEqual([again.status, again.repeated, s.calls.length], ["sent", true, 1]);
  const list = s.m.list();
  assert.equal(list.items.length, 1);
  assert.ok(!JSON.stringify(list).includes(KEY), "the key never appears in the Emails view");
});

test("not configured: outbox only, nothing sent, the app can say so", async () => {
  const s = setup({});
  const r = await s.m.sendInvoice(mail());
  assert.equal(r.status, "not_configured");
  assert.equal(s.calls.length, 0);
  assert.equal(s.m.list().configured, false);
});

test("reserved test domains and bad addresses are never sent to", async () => {
  const s = setup(CONF);
  for (const [i, to] of ["client@example.com", "a@b.test", "x@mail.invalid", "nobody"].entries()) {
    const r = await s.m.sendInvoice(mail({ invoiceId: `inv-${i + 10}`, to }));
    assert.ok(r.status === "skipped" || r.status === "invalid_address", `${to}: ${r.status}`);
  }
  assert.equal(s.calls.length, 0);
});

test("optional allowlist and the daily cap", async () => {
  const a = setup({ ...CONF, EMAIL_RECIPIENT_ALLOWLIST: "@mensah-ltd.co" });
  assert.equal((await a.m.sendInvoice(mail())).status, "sent");
  assert.equal((await a.m.sendInvoice(mail({ invoiceId: "inv-2", to: "someone@else.co" }))).status, "blocked");
  const c = setup({ ...CONF, EMAIL_DAILY_CAP: "2" });
  for (const i of [1, 2, 3]) await c.m.sendInvoice(mail({ invoiceId: `inv-c${i}` }));
  assert.deepEqual(c.m.list().items.map((x: any) => x.status).reverse(), ["sent", "sent", "capped"]);
  assert.equal(c.calls.length, 2);
});

test("a provider error is recorded with its text, never with the key", async () => {
  const s = setup(CONF, () => new Response(JSON.stringify({ name: "validation_error", message: `The domain is not verified (key ${KEY})` }), { status: 403 }));
  const r = await s.m.sendInvoice(mail());
  assert.equal(r.status, "failed");
  assert.match(r.error!, /HTTP 403: The domain is not verified/);
  assert.ok(!r.error!.includes(KEY));
});

test("timeouts and 5xx are retried (up to 3 times, same idempotency key); a 4xx is final", async () => {
  // Two timeouts, then success: sent on the third attempt.
  const slow = setup(CONF, (n) => n <= 2 ? new Promise<Response>(() => {}) : new Response(JSON.stringify({ id: "msg_3" })));
  const r = await slow.m.sendInvoice(mail());
  assert.deepEqual([r.status, r.provider_message_id, r.attempts, slow.calls.length], ["sent", "msg_3", 3, 3]);
  assert.ok(slow.calls.every((c) => (c.init.headers as any)["idempotency-key"] === "invoice:inv-1"));
  // 503 every time: failed after 4 attempts.
  const down = setup(CONF, () => new Response("{}", { status: 503 }));
  const f = await down.m.sendInvoice(mail());
  assert.equal(f.status, "failed");
  assert.equal(down.calls.length, 4);
  assert.match(f.error!, /HTTP 503.*after 4 attempts/);
  // 422: final at once.
  const bad = setup(CONF, () => new Response(JSON.stringify({ message: "invalid to" }), { status: 422 }));
  assert.equal((await bad.m.sendInvoice(mail())).status, "failed");
  assert.equal(bad.calls.length, 1);
});

test("Retry: a failed email goes back to sending, then sent; a sent email is not sent again", async () => {
  let up = false;
  const s = setup(CONF, () => up ? new Response(JSON.stringify({ id: "msg_ok" })) : new Response("{}", { status: 503 }));
  const first = await s.m.sendInvoice(mail());
  assert.equal(first.status, "failed");
  up = true;
  const r = s.m.retry(first.id)!;
  assert.equal(r.status, "sending");
  for (let i = 0; i < 50 && s.m.list().items[0]!.status === "sending"; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(s.m.list().items[0]!.status, "sent");
  const calls = s.calls.length;
  assert.equal(s.m.retry(first.id)!.status, "sent");
  assert.equal(s.calls.length, calls);
  assert.equal(s.m.retry(999), null);
});

test("the HTML escapes names and descriptions", () => {
  const m = invoiceMessage(mail({ senderName: "<script>x</script>", description: "a & b" }));
  assert.ok(!m.html.includes("<script>"));
  assert.match(m.html, /a &amp; b/);
});

// ---- wiring: invoice creation calls the email hook once, and is rate limited per IP ----
import { contractRoutes } from "../src/contractRoutes";
import { ApiError } from "../src/errors";
import { setup as contractSetup, signedContract } from "./contractFixtures";

test("a new invoice triggers one email; activating again does not; creation is rate limited per IP", async () => {
  const s = contractSetup();
  const c = await signedContract(s);
  const created: string[] = [];
  let n = 0;
  const routes = contractRoutes({ ...s.env, onInvoiceCreated: (id) => created.push(id), limitInvoices: () => { if (++n > 2) throw new ApiError(429, "too many", "RATE_LIMITED"); } });
  const call = (path: string) => {
    for (const [m, re, h] of routes) if (m === "POST" && re.test(path)) return h({ params: re.exec(path)!.map(decodeURIComponent) as never, body: {}, raw: "", req: {} as never, url: new URL(path, "http://x") });
    throw new Error("no route");
  };
  await call(`/contracts/${c.id}/milestones/${c.milestones[0].id}/activate`);
  await call(`/contracts/${c.id}/milestones/${c.milestones[0].id}/activate`);
  assert.equal(created.length, 1, "one email per invoice");
  await assert.rejects(call(`/contracts/${c.id}/milestones/${c.milestones[1].id}/activate`) as Promise<unknown>, (e: unknown) => e instanceof ApiError && e.status === 429);
});
