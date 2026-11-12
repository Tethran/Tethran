// Checkout: how a client pays a milestone. One interface, two providers.
//
//   StripeCheckout     the real path: Stripe Checkout Sessions over Stripe's REST API. DISABLED until
//                      STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set; Stripe then calls POST /webhooks/stripe.
//   SimulatedCheckout  "Simulated": no money and no Stripe account. When the client completes a session, it builds
//                      the same event Stripe would send (checkout.session.completed, charge.dispute.created), signs
//                      it with the webhook secret exactly as Stripe does, and hands it to the SAME treasury webhook
//                      handler. So signature verification, once-only handling and the amount check all run for real.
//
// Stablecoin is not a card network: choosing it returns the deposit instructions of the treasury flow instead
// (a demo simplification, labelled as such).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { milestones } from "./db";
import { ApiError } from "./errors";
import { signStripePayload } from "./stripe";
import type { Treasury } from "./treasury";

export type PaymentMethod = "card" | "apple_pay" | "google_pay" | "paypal" | "cashapp" | "stablecoin";

export const PAYMENT_METHODS: { id: PaymentMethod; label: string; via: "stripe" | "treasury_deposit"; note?: string }[] = [
  { id: "card", label: "Card", via: "stripe" },
  { id: "apple_pay", label: "Apple Pay", via: "stripe", note: "Shown by Stripe on supported devices and browsers" },
  { id: "google_pay", label: "Google Pay", via: "stripe", note: "Shown by Stripe on supported devices and browsers" },
  { id: "paypal", label: "PayPal", via: "stripe", note: "Availability depends on the Stripe account's country" },
  { id: "cashapp", label: "Cash App Pay", via: "stripe", note: "US customers only" },
  { id: "stablecoin", label: "Stablecoin (test USDT)", via: "treasury_deposit", note: "Demo simplification: pay the treasury deposit address" },
];

export interface CheckoutSession {
  session_id: string;
  provider: "stripe" | "simulated";
  simulated: boolean;
  milestone_id: string;
  method: PaymentMethod;
  amount_usd_cents: number;
  currency: "usd";
  status: "open" | "paid" | "failed" | "cancelled" | "disputed";
  /** Stripe-hosted page (real) or the app's simulated pay page. */
  url: string | null;
  /** For stablecoin: where to send the test USDT. */
  deposit?: unknown;
  label: string;
}

export interface CheckoutProvider {
  readonly name: "stripe" | "simulated";
  createSession(req: { milestone_id: string; method: PaymentMethod; amount_usd_cents: number; title: string; success_url: string; cancel_url: string }): Promise<CheckoutSession>;
}

// ---- real Stripe (disabled until keys are set) ----

/** Stripe's payment_method_types for a chosen method. Apple Pay and Google Pay run through "card". */
export function stripeMethodTypes(method: PaymentMethod): string[] {
  switch (method) {
    case "card": case "apple_pay": case "google_pay": return ["card"];
    case "paypal": return ["paypal"];
    case "cashapp": return ["cashapp"];
    default: throw new ApiError(400, `${method} is not a Stripe payment method`);
  }
}

export function createStripeCheckout(opts: { secretKey: string; fetch?: typeof fetch }): CheckoutProvider {
  const f = opts.fetch ?? fetch;
  return {
    name: "stripe",
    async createSession(req) {
      const form = new URLSearchParams();
      form.set("mode", "payment");
      form.set("line_items[0][quantity]", "1");
      form.set("line_items[0][price_data][currency]", "usd");
      form.set("line_items[0][price_data][unit_amount]", String(req.amount_usd_cents));
      form.set("line_items[0][price_data][product_data][name]", req.title.slice(0, 120));
      stripeMethodTypes(req.method).forEach((t, i) => form.set(`payment_method_types[${i}]`, t));
      form.set("metadata[milestone_id]", req.milestone_id);
      // So charges and disputes carry the milestone too (the webhook handler reads metadata.milestone_id).
      form.set("payment_intent_data[metadata][milestone_id]", req.milestone_id);
      form.set("success_url", req.success_url);
      form.set("cancel_url", req.cancel_url);
      const res = await f("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(502, `Stripe error ${res.status}: ${String(json?.error?.message ?? "").slice(0, 200)}`, "STRIPE_ERROR");
      return {
        session_id: json.id, provider: "stripe", simulated: false, milestone_id: req.milestone_id, method: req.method,
        amount_usd_cents: req.amount_usd_cents, currency: "usd", status: "open", url: json.url ?? null, label: "Stripe (test mode)",
      };
    },
  };
}

// ---- simulated ----

export function migrateCheckout(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS checkout_sessions (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, milestone_id TEXT NOT NULL, method TEXT NOT NULL,
    amount_usd_cents INTEGER NOT NULL, status TEXT NOT NULL, payment_ref TEXT, created_at TEXT NOT NULL
  )`);
}

export function createSimulatedCheckout(opts: {
  db: DatabaseSync;
  webhookSecret: string;
  treasury: () => Treasury;
  publicBaseUrl: string;
  now: () => Date;
}) {
  const { db } = opts;
  migrateCheckout(db);
  const get = (id: string) => db.prepare("SELECT * FROM checkout_sessions WHERE session_id = ?").get(id) as any;
  const nowS = () => Math.floor(opts.now().getTime() / 1000);
  const view = (r: any): CheckoutSession => ({
    session_id: r.session_id, provider: "simulated", simulated: true, milestone_id: r.milestone_id, method: r.method,
    amount_usd_cents: r.amount_usd_cents, currency: "usd", status: r.status,
    url: `${opts.publicBaseUrl}/pay/simulated/${r.session_id}`, label: "Simulated",
  });

  /** Signs a Stripe-shaped event and feeds it to the real webhook handler. */
  async function emit(type: string, object: Record<string, unknown>) {
    const raw = JSON.stringify({ id: `evt_sim_${randomUUID().replace(/-/g, "")}`, type, livemode: false, data: { object } });
    return opts.treasury().handleStripeWebhook(raw, signStripePayload(raw, opts.webhookSecret, nowS()));
  }

  const provider: CheckoutProvider = {
    name: "simulated",
    async createSession(req) {
      const id = `cs_sim_${randomUUID().replace(/-/g, "")}`;
      db.prepare("INSERT INTO checkout_sessions VALUES (?, 'simulated', ?, ?, ?, 'open', NULL, ?)")
        .run(id, req.milestone_id, req.method, req.amount_usd_cents, opts.now().toISOString());
      return view(get(id));
    },
  };

  return {
    provider,
    get(id: string): CheckoutSession {
      const r = get(id);
      if (!r) throw new ApiError(404, "checkout session not found");
      return view(r);
    },
    /**
     * The client "pays" (or fails or cancels) a simulated session. A paid card-type session becomes a signed
     * checkout.session.completed event through the treasury webhook path, which funds the escrow.
     */
    async complete(id: string, outcome: unknown) {
      const r = get(id);
      if (!r) throw new ApiError(404, "checkout session not found");
      if (outcome !== "paid" && outcome !== "failed" && outcome !== "cancelled") throw new ApiError(400, 'outcome must be "paid", "failed" or "cancelled"');
      if (r.status !== "open") return { session: view(r), already: true };
      if (outcome !== "paid") {
        db.prepare("UPDATE checkout_sessions SET status = ? WHERE session_id = ?").run(outcome, id);
        return { session: view(get(id)), already: false, webhook: null };
      }
      const paymentRef = `pi_sim_${id.slice(7)}`;
      const webhook = await emit("checkout.session.completed", {
        id, object: "checkout.session", payment_status: "paid", payment_intent: paymentRef, amount_total: r.amount_usd_cents,
        currency: "usd", payment_method_types: stripeMethodTypes(r.method), metadata: { milestone_id: r.milestone_id, method: r.method, simulated: "true" },
      });
      db.prepare("UPDATE checkout_sessions SET status = 'paid', payment_ref = ? WHERE session_id = ?").run(paymentRef, id);
      return { session: view(get(id)), already: false, webhook };
    },
    /** A simulated chargeback on a paid session: a signed charge.dispute.created event through the same path. */
    async dispute(id: string) {
      const r = get(id);
      if (!r) throw new ApiError(404, "checkout session not found");
      if (r.status !== "paid") throw new ApiError(409, "only a paid session can be disputed");
      const webhook = await emit("charge.dispute.created", {
        id: `dp_sim_${id.slice(7)}`, object: "dispute", payment_intent: r.payment_ref, amount: r.amount_usd_cents, currency: "usd",
        reason: "fraudulent", metadata: { milestone_id: r.milestone_id, simulated: "true" },
      });
      db.prepare("UPDATE checkout_sessions SET status = 'disputed' WHERE session_id = ?").run(id);
      return { session: view(get(id)), webhook };
    },
  };
}

export type SimulatedCheckout = ReturnType<typeof createSimulatedCheckout>;

/** Creates a session for a draft milestone, through whichever provider is active. */
export async function startCheckout(args: {
  db: DatabaseSync; provider: CheckoutProvider; treasury: Treasury; publicBaseUrl: string;
  milestone_id: unknown; method: unknown;
}): Promise<CheckoutSession> {
  if (typeof args.milestone_id !== "string") throw new ApiError(400, "milestone_id is required");
  const method = PAYMENT_METHODS.find((m) => m.id === args.method);
  if (!method) throw new ApiError(400, `method must be one of ${PAYMENT_METHODS.map((m) => m.id).join(", ")}`);
  const m = milestones.get(args.db, args.milestone_id);
  if (!m) throw new ApiError(404, "milestone not found");
  if (m.state !== "draft") throw new ApiError(409, `milestone is ${m.state}; it has already been paid`);
  if (method.via === "treasury_deposit") {
    return {
      session_id: `deposit:${m.id}`, provider: args.provider.name, simulated: true, milestone_id: m.id, method: "stablecoin",
      amount_usd_cents: m.amount_usd_cents, currency: "usd", status: "open", url: null,
      deposit: args.treasury.depositInstructions(m.id), label: "Stablecoin deposit (demo simplification)",
    };
  }
  return args.provider.createSession({
    milestone_id: m.id, method: method.id, amount_usd_cents: m.amount_usd_cents, title: m.title,
    success_url: `${args.publicBaseUrl}/pay/done?milestone=${m.id}`, cancel_url: `${args.publicBaseUrl}/pay/cancelled?milestone=${m.id}`,
  });
}
