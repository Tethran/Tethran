// Invoice email (v0.12): when an invoice is created for a client email, the pay link is sent by real email through
// the Resend REST API (fetch, no dependency). Configured only by env: EMAIL_PROVIDER ("resend"), EMAIL_API_KEY,
// EMAIL_FROM; optional EMAIL_DAILY_CAP (default 100) and EMAIL_RECIPIENT_ALLOWLIST (comma-separated; empty = any).
// Without them, the message goes to the "Emails" outbox only (status not_configured) and the app says so.
//
// Safety: one invoice sends one email (unique idempotency key, claimed before sending); a daily send cap; reserved
// test domains (example.com/.org/.net, *.test, *.invalid, *.example, localhost) are never sent to; the API key is never
// logged, stored or returned, and provider errors are recorded without it. Every attempt is written to the outbox
// (status, provider message id, time) and becomes a notification.
import type { DatabaseSync } from "node:sqlite";
import type { Notifications } from "./notifications";

export const RESEND_URL = "https://api.resend.com/emails";
export const DEFAULT_DAILY_CAP = 100;
export const FOOTER = "Sent from Tethran, a hackathon prototype. Test tokens only.";

export interface EmailConfig { provider: string; apiKey: string; from: string; dailyCap: number; allowlist: string[] }

export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const cap = Number(env.EMAIL_DAILY_CAP);
  return {
    provider: (env.EMAIL_PROVIDER ?? "").trim().toLowerCase(),
    apiKey: (env.EMAIL_API_KEY ?? "").trim(),
    from: (env.EMAIL_FROM ?? "").trim(),
    dailyCap: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP,
    allowlist: (env.EMAIL_RECIPIENT_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
export const emailConfigured = (c: EmailConfig) => c.provider === "resend" && c.apiKey.length > 0 && c.from.length > 0;

const RESERVED = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.(test|invalid|example|localhost)|localhost)$/i;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Never let a key-like string through into a stored error. */
const scrub = (s: string, key: string) => (key ? s.split(key).join("[key]") : s).replace(/re_[A-Za-z0-9_]{8,}/g, "[key]").slice(0, 300);

export interface InvoiceMail {
  invoiceId: string; number: string; to: string; senderName: string; clientName: string; amountCents: number; description: string; payUrl: string;
}

export function invoiceMessage(m: InvoiceMail) {
  const amount = `$${(m.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const subject = `Invoice ${m.number} from ${m.senderName}: ${amount}`;
  const text = [
    `Hello ${m.clientName},`, "",
    `${m.senderName} sent you invoice ${m.number} for ${amount}.`,
    `For: ${m.description}`, "",
    `Pay it here: ${m.payUrl}`,
    "The money waits in escrow and is released only when you approve the work.", "",
    "--", FOOTER,
  ].join("\n");
  const html = `<p>Hello ${esc(m.clientName)},</p><p><strong>${esc(m.senderName)}</strong> sent you invoice ${esc(m.number)} for <strong>${esc(amount)}</strong>.</p>`
    + `<p>For: ${esc(m.description)}</p><p><a href="${esc(m.payUrl)}">Pay the invoice</a></p>`
    + `<p>The money waits in escrow and is released only when you approve the work.</p><hr><p style="color:#666;font-size:12px">${esc(FOOTER)}</p>`;
  return { subject, text, html };
}

/** Per attempt: 15 seconds. A timeout, a network error, 408, 429 or 5xx is retried up to 3 times; other errors are final. */
export const ATTEMPT_TIMEOUT_MS = 15_000;
export const RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

export function createMailer(opts: { db: DatabaseSync; config: EmailConfig; now: () => Date; fetch?: typeof fetch; notifications?: Notifications; timeoutMs?: number; retryDelaysMs?: number[] }) {
  const { db, config } = opts;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  db.exec(`CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, invoice_id TEXT,
    to_address TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
    provider_message_id TEXT, error TEXT, created_at TEXT NOT NULL, sent_at TEXT
  )`);
  for (const col of ["body_html TEXT", "attempts INTEGER NOT NULL DEFAULT 0"]) {
    try { db.exec(`ALTER TABLE emails ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  const sentToday = () => (db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status = 'sent' AND substr(sent_at, 1, 10) = ?").get(opts.now().toISOString().slice(0, 10)) as { n: number }).n;

  async function sendInvoice(m: InvoiceMail) {
    const key = `invoice:${m.invoiceId}`;
    const existing = db.prepare("SELECT * FROM emails WHERE idempotency_key = ?").get(key) as any;
    if (existing) return view(existing, true);
    const to = m.to.trim();
    const msg = invoiceMessage(m);
    const at = opts.now().toISOString();
    const claimed = db.prepare("INSERT OR IGNORE INTO emails (idempotency_key, kind, invoice_id, to_address, subject, body_text, body_html, provider, status, created_at) VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, 'sending', ?)")
      .run(key, m.invoiceId, to, msg.subject, msg.text, msg.html, config.provider || "outbox", at);
    if (Number(claimed.changes) !== 1) return view(db.prepare("SELECT * FROM emails WHERE idempotency_key = ?").get(key), true);
    const finish = (status: string, fields: { provider_message_id?: string | null; error?: string | null } = {}) => finishRow(key, m.number, status, fields, "");
    if (!EMAIL.test(to)) return finish("invalid_address", { error: "not an email address" });
    const domain = to.split("@").pop()!.toLowerCase();
    if (RESERVED.test(domain)) return finish("skipped", { error: `reserved test domain (${domain}); nothing sent` });
    if (!emailConfigured(config)) return finish("not_configured", { error: "email is not configured (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM); outbox only" });
    if (config.allowlist.length > 0 && !config.allowlist.includes(to.toLowerCase()) && !config.allowlist.includes(`@${domain}`)) {
      return finish("blocked", { error: "recipient is not on EMAIL_RECIPIENT_ALLOWLIST" });
    }
    if (sentToday() >= config.dailyCap) return finish("capped", { error: `daily send cap of ${config.dailyCap} reached` });
    const r = await deliver(key, to, msg.subject, msg.text, msg.html);
    return finish(r.status, r);
  }

  /** Sends one message: up to 1 + 3 attempts, 15 s each, all with the same idempotency key (Resend never sends twice). */
  async function deliver(key: string, to: string, subject: string, text: string, html: string): Promise<{ status: "sent" | "failed"; provider_message_id?: string; error?: string }> {
    let last = "";
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      db.prepare("UPDATE emails SET attempts = attempts + 1 WHERE idempotency_key = ?").run(key);
      try {
        // The abort signal ends the request; the timer ends the attempt even if a fetch ignores the signal.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs); });
        const body: any = {};
        const res = await Promise.race([(async () => {
          const r = await doFetch(RESEND_URL, {
            method: "POST",
            headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify({ from: config.from, to: [to], subject, text, html }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          Object.assign(body, await r.json().catch(() => ({})));
          return r;
        })(), timedOut]).finally(() => clearTimeout(timer));
        if (res.ok && typeof body?.id === "string") return { status: "sent", provider_message_id: body.id };
        last = scrub(`HTTP ${res.status}: ${body?.message ?? body?.name ?? "no message"}`, config.apiKey);
        if (!(res.status === 408 || res.status === 429 || res.status >= 500)) return { status: "failed", error: last };
      } catch (e) {
        last = scrub(String((e as Error)?.message ?? e), config.apiKey);
      }
    }
    return { status: "failed", error: `${last} (after ${delays.length + 1} attempts)` };
  }

  function finishRow(key: string, number: string, status: string, fields: { provider_message_id?: string | null; error?: string | null }, noteSuffix: string) {
    db.prepare("UPDATE emails SET status = ?, provider_message_id = ?, error = ?, sent_at = ? WHERE idempotency_key = ?")
      .run(status, fields.provider_message_id ?? null, fields.error ?? null, status === "sent" ? opts.now().toISOString() : null, key);
    const row = db.prepare("SELECT * FROM emails WHERE idempotency_key = ?").get(key) as any;
    opts.notifications?.notify({
      recipient: "freelancer", type: "invoice_email", key: `email:${row.id}${noteSuffix}`, path: `/app/invoice/${row.invoice_id}`,
      title: status === "sent" ? `Invoice ${number} emailed to the client` : `Invoice ${number} email: ${status.replace(/_/g, " ")}`,
      body: status === "sent" ? `The pay link was emailed (message ${row.provider_message_id}).` : `Not sent: ${row.error ?? status}. The pay link is in the Emails view.`,
    });
    return view(row, false);
  }

  /** Retry a failed email (the Emails view's "Retry"): back to "sending", delivered in the background. */
  function retry(id: number) {
    const row = db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as any;
    if (!row) return null;
    if (row.status !== "failed") return view(row, true);
    if (sentToday() >= config.dailyCap) return view(row, true);
    db.prepare("UPDATE emails SET status = 'sending', error = NULL WHERE id = ?").run(id);
    const number = String(row.subject).match(/Invoice (S+)/)?.[1] ?? "";
    const html = row.body_html ?? `<pre>${esc(row.body_text)}</pre>`;
    const attemptsBefore = Number(row.attempts ?? 0);
    void deliver(row.idempotency_key, row.to_address, row.subject, row.body_text, html)
      .then((r) => finishRow(row.idempotency_key, number, r.status, r, `:retry${attemptsBefore}`))
      .catch(() => db.prepare("UPDATE emails SET status = 'failed' WHERE id = ?").run(id));
    return view(db.prepare("SELECT * FROM emails WHERE id = ?").get(id), false);
  }

  function view(row: any, repeated: boolean) {
    return { id: row.id, invoice_id: row.invoice_id, to: row.to_address, subject: row.subject, status: row.status, attempts: Number(row.attempts ?? 0), provider: row.provider, provider_message_id: row.provider_message_id ?? null, error: row.error ?? null, created_at: row.created_at, sent_at: row.sent_at ?? null, repeated };
  }

  return {
    configured: () => emailConfigured(config),
    sendInvoice,
    retry,
    /** The Emails view: every attempt, newest first (never the key). */
    list(limit = 100) {
      const rows = db.prepare("SELECT * FROM emails ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(1, limit), 500)) as any[];
      return { configured: emailConfigured(config), provider: config.provider || null, daily_cap: config.dailyCap, sent_today: sentToday(), items: rows.map((r) => ({ ...view(r, false), body_text: r.body_text })) };
    },
  };
}
export type Mailer = ReturnType<typeof createMailer>;
