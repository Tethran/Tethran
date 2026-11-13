// Notifications (v0.12): stored in the backend, one per event and recipient, never duplicated.
//
// Recipients are roles: client, freelancer, operator, arbiter (the app's "Switch role"; each role sees its own).
// Events are derived from the records the services already write (invoices, fundings, evidence and delivery checks,
// escrow state, settlement plans, payouts, receipts, dispute attestations, wallet top-ups, invoice reminders), so no
// action path needs a separate hook and a retried action cannot notify twice: every notification has an idempotency
// key (event + record + recipient) with a UNIQUE constraint. Other modules (the invoice email) add their own with
// notify(). Links are absolute, built from APP_BASE_URL.
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors";

export const RECIPIENTS = ["client", "freelancer", "operator", "arbiter"] as const;
export type Recipient = (typeof RECIPIENTS)[number];

export interface NewNotification {
  recipient: Recipient;
  type: string;
  title: string;
  body: string;
  /** App path, e.g. /app/milestone/<id>; stored as an absolute link under APP_BASE_URL. */
  path: string;
  key: string;
  at?: string;
}

export function migrateNotifications(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, link TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, idempotency_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications (recipient, created_at);
  `);
}

const usd = (base: string | number | bigint) => {
  const b = BigInt(base);
  const cents = (b + 5_000n) / 10_000n;
  return `$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
};
const exists = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

export function createNotifications(db: DatabaseSync, opts: { now: () => Date; appBaseUrl: string }) {
  migrateNotifications(db);
  const base = opts.appBaseUrl.replace(/\/+$/, "");
  const ins = db.prepare("INSERT OR IGNORE INTO notifications (recipient, type, title, body, link, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)");

  function notify(n: NewNotification): boolean {
    if (!RECIPIENTS.includes(n.recipient)) throw new Error(`unknown recipient ${n.recipient}`);
    const r = ins.run(n.recipient, n.type, n.title.slice(0, 200), n.body.slice(0, 2000), `${base}${n.path}`, n.at ?? opts.now().toISOString(), `${n.key}:${n.recipient}`);
    return Number(r.changes) === 1;
  }
  const to = (who: Recipient[], n: Omit<NewNotification, "recipient">) => who.forEach((recipient) => notify({ ...n, recipient }));

  /** Creates the notifications for every event found in the records. Idempotent: run it as often as needed. */
  function sync() {
    const ms = new Map<string, any>();
    if (exists(db, "milestones")) for (const m of db.prepare("SELECT * FROM milestones").all() as any[]) ms.set(m.id, m);
    const title = (id: string) => ms.get(id)?.title ?? "Milestone";
    const mpath = (id: string) => `/app/milestone/${id}`;

    if (exists(db, "invoices")) {
      for (const i of db.prepare("SELECT id, number, provider_name, client_name, total_cents, created_at FROM invoices").all() as any[]) {
        to(["client"], { type: "invoice_sent", key: `invoice:${i.id}`, at: i.created_at, path: `/pay/${i.id}`,
          title: `Invoice ${i.number} from ${i.provider_name}`, body: `${i.provider_name} sent you an invoice for ${usd(BigInt(i.total_cents) * 10_000n)}. Pay it into escrow; the money is released only when you approve the work.` });
      }
    }
    if (exists(db, "invoice_reminders") && exists(db, "invoices")) {
      for (const r of db.prepare("SELECT r.invoice_id, r.kind, r.at, i.number FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id").all() as any[]) {
        const when = r.kind === "before_due" ? "is due in 3 days" : r.kind === "due_today" ? "is due today" : "is 7 days overdue";
        to(["client"], { type: "invoice_reminder", key: `reminder:${r.invoice_id}:${r.kind}`, at: r.at, path: `/pay/${r.invoice_id}`, title: `Reminder: invoice ${r.number} ${when}`, body: `Invoice ${r.number} ${when}. Pay it from the link.` });
      }
    }
    for (const m of ms.values()) {
      if (m.escrow_tx) to(["freelancer"], { type: "milestone_funded", key: `funded:${m.id}`, path: mpath(m.id), title: `Funded: ${m.title}`, body: `The client paid ${usd(m.amount)} into escrow for "${m.title}". Deliver the work and submit it.` });
      const disputed = exists(db, "attestations") && !!db.prepare("SELECT 1 FROM attestations WHERE milestone_id = ?").get(m.id);
      if (m.state === "disputed" || disputed) {
        to(["freelancer", "arbiter", "client"], { type: "dispute_opened", key: `dispute-opened:${m.id}`, path: m.state === "disputed" ? "/app/arbiter" : mpath(m.id), title: `Dispute opened: ${m.title}`, body: `The client disputed "${m.title}". Two of client, freelancer and arbiter decide on-chain.` });
      }
      if (disputed && ["released", "paid_out", "refunded"].includes(m.state)) {
        const outcome = m.state === "refunded" ? "refunded to the client" : "released to the freelancer";
        to(["freelancer", "client", "arbiter"], { type: "dispute_decided", key: `dispute-decided:${m.id}`, path: mpath(m.id), title: `Dispute decided: ${m.title}`, body: `The escrow ${outcome} after two matching votes.` });
      } else if (!disputed && ["approved", "released", "paid_out"].includes(m.state)) {
        to(["freelancer"], { type: "client_approved", key: `approved:${m.id}`, path: mpath(m.id), title: `Approved: ${m.title}`, body: `The client approved the work on-chain. The settlement follows.` });
      }
      if (m.state === "refunded") to(["client", "freelancer"], { type: "refund", key: `refund:${m.id}`, path: mpath(m.id), title: `Refunded: ${m.title}`, body: `The escrow for "${m.title}" was refunded to the client. No platform fee is taken on a refund.` });
    }
    if (exists(db, "evidence")) {
      const hasChecks = exists(db, "delivery_checks");
      for (const e of db.prepare("SELECT id, milestone_id, at FROM evidence").all() as any[]) {
        let summary = "";
        if (hasChecks) {
          const c = db.prepare("SELECT checks_json FROM delivery_checks WHERE evidence_id = ? ORDER BY id DESC LIMIT 1").get(e.id) as { checks_json: string } | undefined;
          const checks = c ? (JSON.parse(c.checks_json) as { status: string }[]) : [];
          if (checks.length) {
            const n = (s: string) => checks.filter((x) => x.status === s).length;
            summary = ` The AI's delivery check: ${n("met")} met, ${n("unmet")} unmet, ${n("unclear")} unclear (advisory).`;
          }
        }
        to(["client"], { type: "work_submitted", key: `submitted:${e.id}`, at: e.at, path: mpath(e.milestone_id), title: `Work submitted: ${title(e.milestone_id)}`, body: `The freelancer submitted the delivery.${summary} Please review it and approve the work, or open a dispute.` });
      }
    }
    if (exists(db, "settlement_plans")) {
      for (const p of db.prepare("SELECT id, milestone_id, decision, reasons, at FROM settlement_plans").all() as any[]) {
        const reasons = (JSON.parse(p.reasons ?? "[]") as string[]).join(", ");
        const t = title(p.milestone_id);
        if (p.decision === "escalated") {
          to(["freelancer", "client"], { type: "settlement_escalated", key: `plan:${p.id}:escalated`, at: p.at, path: mpath(p.milestone_id), title: `Settlement waits for a person: ${t}`, body: `The Policy Service escalated the AI's plan (${reasons}). An operator decides.` });
          to(["operator"], { type: "settlement_escalated", key: `plan:${p.id}:escalated`, at: p.at, path: "/app/operator", title: `Needs your decision: ${t}`, body: `The Policy Service escalated a settlement plan (${reasons}).` });
        } else if (p.decision === "rejected") {
          to(["freelancer", "client"], { type: "settlement_rejected", key: `plan:${p.id}:rejected`, at: p.at, path: mpath(p.milestone_id), title: `Settlement plan rejected: ${t}`, body: `The Policy Service rejected the AI's plan (${reasons}). Nothing was paid.` });
        } else {
          to(["freelancer", "client"], { type: "settlement_proposed", key: `plan:${p.id}:proposed`, at: p.at, path: mpath(p.milestone_id), title: `Settlement approved: ${t}`, body: `The AI proposed the payout and the Policy Service approved it. The vault pays next.` });
        }
      }
    }
    if (exists(db, "payouts")) {
      for (const f of db.prepare("SELECT id, milestone_id, amount, at FROM payouts WHERE payee_id = 'tethran_earnings' AND status = 'confirmed'").all() as any[]) {
        to(["operator"], { type: "fee_collected", key: `fee:${f.id}`, at: f.at, path: "/app/earnings", title: `Platform fee collected: ${usd(f.amount)}`, body: `5% of "${title(f.milestone_id)}" was paid to the Tethran earnings account.` });
      }
      const paid = db.prepare(`SELECT milestone_id, SUM(CASE WHEN payee_id != 'tethran_earnings' THEN CAST(amount AS INTEGER) ELSE 0 END) AS net, MAX(at) AS at,
        SUM(CASE WHEN status != 'confirmed' THEN 1 ELSE 0 END) AS open FROM payouts GROUP BY milestone_id`).all() as any[];
      for (const p of paid) {
        if (p.open > 0) continue;
        to(["freelancer", "client"], { type: "settlement_paid", key: `paid:${p.milestone_id}`, at: p.at, path: mpath(p.milestone_id), title: `Paid: ${title(p.milestone_id)}`, body: `The vault paid ${usd(String(p.net))} to the freelancer's payees, after the 5% platform fee and the tax reserve.` });
      }
    }
    if (exists(db, "receipts")) {
      for (const r of db.prepare("SELECT milestone_id, token_id, at FROM receipts").all() as any[]) {
        to(["freelancer", "client"], { type: "receipt_minted", key: `receipt:${r.milestone_id}`, at: r.at, path: `/receipt/${r.milestone_id}`, title: `Receipt #${r.token_id ?? "?"} minted: ${title(r.milestone_id)}`, body: `A non-transferable receipt was minted on the test network. Anyone with the link can verify it.` });
      }
    }
    if (exists(db, "wallet_topups")) {
      for (const t of db.prepare("SELECT idempotency_key, role, amount, created_at FROM wallet_topups WHERE status = 'confirmed'").all() as any[]) {
        const who: Recipient | null = t.role === "client" ? "client" : t.role === "payee_amara" ? "freelancer" : null;
        if (who) notify({ recipient: who, type: "wallet_funded", key: `topup:${t.idempotency_key}`, at: t.created_at, path: "/app/wallet", title: `Wallet funded: ${usd(t.amount)}`, body: `${usd(t.amount)} in test USDT was added to your wallet by card (simulated).` });
      }
    }
  }

  const role = (r: unknown): Recipient => {
    if (typeof r !== "string" || !RECIPIENTS.includes(r as Recipient)) throw new ApiError(400, `recipient must be one of ${RECIPIENTS.join(", ")}`, "BAD_RECIPIENT");
    return r as Recipient;
  };

  return {
    notify,
    sync,
    /** A role's notifications, newest first, and its unread count. */
    list(recipient: unknown, limit = 50) {
      const who = role(recipient);
      sync();
      const items = db.prepare("SELECT id, recipient, type, title, body, link, created_at, read_at FROM notifications WHERE recipient = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(who, Math.min(Math.max(1, limit), 200)) as { id: number; recipient: string; type: string; title: string; body: string; link: string; created_at: string; read_at: string | null }[];
      const unread = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient = ? AND read_at IS NULL").get(who) as { n: number }).n;
      return { recipient: who, unread, items };
    },
    /** Marks one as read; only its own recipient can (a role cannot read another role's). */
    markRead(id: unknown, recipient: unknown) {
      const who = role(recipient);
      if (typeof id !== "string" || !/^\d+$/.test(id)) throw new ApiError(404, "notification not found");
      const r = db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient = ?").run(opts.now().toISOString(), Number(id), who);
      if (Number(r.changes) === 0) throw new ApiError(404, "notification not found");
      return { id: Number(id), read: true };
    },
    markAllRead(recipient: unknown) {
      const who = role(recipient);
      const r = db.prepare("UPDATE notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL").run(opts.now().toISOString(), who);
      return { recipient: who, marked: Number(r.changes) };
    },
  };
}
export type Notifications = ReturnType<typeof createNotifications>;
