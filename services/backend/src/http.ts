// Backend HTTP API (node:http, JSON). Routes are documented in docs/API.md.
// Errors are { error, code? } with a safe message: no stack traces, URLs or key material.
import { approveCall, createExternalMint, createIpLimiter, depositCall } from "./externalWallet";
import type { Mailer } from "./email";
import type { FxService } from "./fx";
import { createNotifications, type Notifications } from "./notifications";
import { createEvidenceStore, MAX_EVIDENCE_BODY, type EvidenceStore } from "./evidence";
import { PLATFORM_FEE_BPS } from "../../policy/src/fee";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { allPayees, milestones } from "./db";
import { ApiError, safeErrorMessage } from "./errors";
import type { IdentityCheck } from "./identity";
import type { Orchestrator } from "./orchestrator";
import type { Treasury } from "./treasury";
import type { TreasuryChain } from "./chainPort";
import { PAYMENT_METHODS, startCheckout, type CheckoutProvider, type SimulatedCheckout } from "./checkout";
import { contractRoutes } from "./contractRoutes";
import { signContract, signingPayload } from "./contracts";
import { parseAgentMode } from "./replay";
import { relayVaultActions } from "./vaultRelay";
import type { WalletLayer } from "./wallets";
import type { createX402Server } from "./x402";
import { operatorRoutes, type Operator } from "./operator";
import { recordIdentity } from "./identity";
import { payoutRoutes, processConfirmedPayouts } from "./payouts";
import { phoneRegistryRoutes } from "./phoneRegistry";
import { reconciliationRoutes, type RawResponse } from "./reconciliation";

const MAX_BODY = 256 * 1024;

export interface HttpDeps {
  /** Credential for platform actions (release, refund, settle); those routes refuse every caller when it is empty. */
  platformToken?: string;
  /** Origins allowed by CORS (default http://localhost:3000, the web app in development). */
  corsOrigins?: string[];
  db: DatabaseSync;
  treasury: Treasury;
  orchestrator: Orchestrator;
  identity: IdentityCheck;
  chain: TreasuryChain;
  /** Shared secret for /internal/* (the Policy Service). Empty disables the internal routes. */
  internalToken: string;
  now: () => Date;
  checkout: CheckoutProvider;
  /** Present when the simulated checkout is active (no Stripe keys). */
  simulatedCheckout?: SimulatedCheckout;
  publicBaseUrl: string;
  /** WDK user wallets; absent when DEMO_WALLET_SEED is not set. */
  wallets?: WalletLayer;
  phoneHashSalt?: string;
  operator?: Operator;
  /** Indicative exchange rates (fx.ts) for the app's own screens and payout quotes only; never for a paid endpoint. */
  fx?: FxService;
  /** The escrow contract address, for calls a connected wallet sends itself. */
  escrowAddress?: string;
  /** DEMO_MODE only: mint test USDT to a connected address (Get test USDT). */
  externalMint?: (to: string, amount: string, key: string) => Promise<{ txHash: string }>;
  externalMintWait?: (h: string) => Promise<void>;
  /** Invoice email (Resend REST, or the outbox when not configured). */
  mailer?: Mailer;
  /** Invoice creations allowed per IP per minute (default 30). */
  invoiceRateLimitPerMin?: number;
  /** Trust X-Forwarded-For for the client IP (only behind our own proxy). */
  trustProxy?: boolean;
  /** Notifications per role. Created from db when not given (links under publicBaseUrl, i.e. APP_BASE_URL). */
  notifications?: Notifications;
  /** Delivery evidence store (notes, links, files on the data disk). Created from db when not given. */
  evidence?: EvidenceStore;
  x402?: ReturnType<typeof createX402Server>;
}

type Handler = (ctx: { params: Record<string, string>; body: any; raw: string; req: IncomingMessage; url: URL }) => Promise<unknown>;

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createHttpServer(deps: HttpDeps): Server {
  const { db, treasury, orchestrator } = deps;
  // Created on first use (some servers in tests have no database).
  let ev: EvidenceStore | undefined;
  const evidenceStore = () => (ev ??= deps.evidence ?? createEvidenceStore(db));
  // Per-IP rate limit on invoice creation: a fixed one-minute window per address.
  const hits = new Map<string, { at: number; n: number }>();
  const limitInvoices = (req: IncomingMessage) => {
    const fwd = deps.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const ip = fwd || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.at > 60_000) { hits.set(ip, { at: now, n: 1 }); return; }
    if (++h.n > (deps.invoiceRateLimitPerMin ?? 30)) throw new ApiError(429, "too many invoices from this address; try again in a minute", "RATE_LIMITED");
  };
  // The invoice email: the pay link to the contract's client email. Fire and forget: its outcome is in the Emails view.
  const emailInvoice = (invoiceId: string) => {
    if (!deps.mailer) return;
    try {
      const inv = db.prepare("SELECT i.id, i.number, i.provider_name, i.client_name, i.total_cents, i.contract_id, i.milestone_id FROM invoices i WHERE i.id = ?").get(invoiceId) as any;
      const c = inv && (db.prepare("SELECT terms_json FROM contracts WHERE id = ?").get(inv.contract_id) as { terms_json: string } | undefined);
      const terms = c ? JSON.parse(c.terms_json) : null;
      const to = terms?.client_email;
      if (!inv || typeof to !== "string" || !to) return;
      const title = (db.prepare("SELECT title FROM contract_milestones WHERE id = ?").get(inv.milestone_id) as { title: string } | undefined)?.title ?? "Milestone";
      void deps.mailer.sendInvoice({
        invoiceId: inv.id, number: inv.number, to, senderName: inv.provider_name, clientName: inv.client_name, amountCents: inv.total_cents,
        description: title, payUrl: `${deps.publicBaseUrl.replace(/\/+$/, "")}/pay/${inv.id}`,
      }).catch((e) => console.error("invoice email failed: " + safeErrorMessage(e)));
    } catch (e) {
      console.error("invoice email failed: " + safeErrorMessage(e));
    }
  };
  // Wallet top-ups (simulated card, a treasury mint each): at most 5 per 10 minutes per IP.
  const limitTopUps = createIpLimiter({ max: 5, windowMs: 10 * 60 * 1000, now: deps.now, trustProxy: deps.trustProxy, what: "wallet top-ups" });
  const externalMint = createExternalMint({ mint: deps.externalMint, waitConfirmed: deps.externalMintWait, now: deps.now, trustProxy: deps.trustProxy });
  let nt: Notifications | undefined;
  const notes = () => (nt ??= deps.notifications ?? createNotifications(db, { now: deps.now, appBaseUrl: deps.publicBaseUrl }));

  const internal = (h: Handler): Handler => async (ctx) => {
    const token = String(ctx.req.headers["x-internal-token"] ?? "");
    if (!deps.internalToken || !sameSecret(token, deps.internalToken)) throw new ApiError(401, "internal route");
    return h(ctx);
  };

  const platform = (h: Handler): Handler => async (ctx) => {
    const token = String(ctx.req.headers["x-platform-token"] ?? "");
    if (!deps.platformToken || !sameSecret(token, deps.platformToken)) throw new ApiError(401, "platform action: x-platform-token required", "PLATFORM_ONLY");
    return h(ctx);
  };

  const needWallets = () => {
    if (!deps.wallets) throw new ApiError(404, "WDK wallets are not configured (set DEMO_WALLET_SEED)");
    return deps.wallets;
  };

  const timeline = (id: string) => {
    const m = milestones.get(db, id);
    if (!m) throw new ApiError(404, "milestone not found");
    return {
      milestone: m,
      fundings: db.prepare("SELECT source, reference, amount, chain_id, escrow_tx, status, at FROM fundings WHERE milestone_id = ? ORDER BY id").all(id),
      // The actual note, link and files of every submission, and the agent's latest delivery check (advisory).
      evidence: evidenceStore().list(id),
      delivery_check: evidenceStore().latestCheck(id),
      // The agent's proposal is shown as data (it is untrusted output, already schema-checked); the decision and its
      // reason codes are the Policy Service's.
      settlement_plans: (db.prepare("SELECT id, proposal_json, proposal_hash, trace_id, decision, reasons, approval_id, agent_mode, at FROM settlement_plans WHERE milestone_id = ? ORDER BY id").all(id) as any[])
        .map(({ proposal_json, ...p }) => ({ ...p, reasons: JSON.parse(p.reasons), proposal: proposal_json ? JSON.parse(proposal_json) : null })),
      // Each payout with its SIMULATED off-chain leg (local amount) and the indicative rate it used (milestone-locked).
      payouts: (db.prepare(`SELECT p.id, p.action_index, p.action_id, p.payee_id, p.rail, p.to_address, p.amount, p.tx, p.status, p.simulated, p.at,
          o.local_amount, o.currency, o.fx_rate, o.status AS leg_status
        FROM payouts p LEFT JOIN offchain_payouts o ON o.payout_id = p.id WHERE p.milestone_id = ? ORDER BY p.action_index`).all(id) as any[])
        .map(({ id: _pid, local_amount, currency, fx_rate, leg_status, ...p }) => {
          if (!local_amount || !currency || currency === "USDT") return p;
          const r = deps.fx ? deps.fx.rateFor(currency, id) : null;
          return { ...p, offchain: { simulated: true, local_amount, currency, fx_rate, status: leg_status,
            fx_label: r?.label ?? "Sample rate", fx_attribution: r?.attribution ?? null } };
        }),
      receipt: db.prepare("SELECT * FROM receipts WHERE milestone_id = ?").get(id) ?? null,
    };
  };

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/health$/, async () => ({ ok: true })],
    // Connected (external) wallets: the deposit and approve transactions they send themselves; Get test USDT.
    ["GET", /^\/milestones\/([^/]+)\/calls\/deposit$/, async ({ params }) => depositCall(treasury.depositInstructions(params[1]) as never)],
    ["GET", /^\/milestones\/([^/]+)\/calls\/approve$/, async ({ params }) => {
      const m = milestones.get(db, params[1]);
      if (!m) throw new ApiError(404, "milestone not found");
      if (!deps.escrowAddress) throw new ApiError(503, "escrow address not configured");
      return approveCall(m.chain_id, deps.escrowAddress, m.id);
    }],
    ["POST", /^\/wallets\/external\/mint$/, async ({ req, body }) => externalMint(req, body ?? {})],
    // Notifications for one role (client, freelancer, operator, arbiter): newest first, with the unread count.
    ["GET", /^\/notifications$/, async ({ url }) => notes().list(url.searchParams.get("recipient"), Number(url.searchParams.get("limit") ?? 50))],
    ["POST", /^\/notifications\/read-all$/, async ({ body }) => notes().markAllRead(body?.recipient)],
    ["POST", /^\/notifications\/([^/]+)\/read$/, async ({ params, body }) => notes().markRead(params[1], body?.recipient)],
    ["POST", /^\/milestones$/, async ({ body }) => {
      const created: any = await treasury.createMilestone(body ?? {});
      // Lock today's indicative rates to the milestone, so a later rate change never alters amounts already shown.
      if (deps.fx && created?.id) deps.fx.lock(String(created.id));
      return created;
    }],
    // List for the app's dashboard (local records; GET /milestones/{id} syncs one with the chain).
    ["GET", /^\/milestones$/, async ({ url }) => {
      const q = (k: string) => url.searchParams.get(k);
      const rows = db.prepare(
        `SELECT * FROM milestones WHERE (? IS NULL OR provider_id = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR scenario = ?)
         ORDER BY created_at DESC, id LIMIT 200`,
      ).all(q("provider_id"), q("provider_id"), q("state"), q("state"), q("scenario"), q("scenario"));
      return { count: rows.length, milestones: rows };
    }],
    ["GET", /^\/milestones\/([^/]+)$/, async ({ params }) => treasury.sync(params[1])],
    ["GET", /^\/milestones\/([^/]+)\/timeline$/, async ({ params }) => {
      await treasury.sync(params[1]).catch(() => undefined);
      return timeline(params[1]);
    }],
    ["GET", /^\/milestones\/([^/]+)\/deposit$/, async ({ params }) => treasury.depositInstructions(params[1])],
    ["POST", /^\/milestones\/([^/]+)\/deposit\/confirm$/, async ({ params, body }) => treasury.confirmDeposit(params[1], String(body?.tx_hash ?? ""))],
    // Delivery: a note, a link and up to 5 files (untrusted data; they reach the agent only inside the evidence
    // delimiters). Then the agent's advisory delivery check against the acceptance criteria, shown to the client.
    ["POST", /^\/milestones\/([^/]+)\/evidence$/, async ({ params, body }) => {
      const m = milestones.get(db, params[1]);
      if (!m) throw new ApiError(404, "milestone not found");
      const id = evidenceStore().submit(m.id, body ?? {}, deps.now());
      if (m.state === "funded") milestones.setState(db, m.id, "in_review");
      const check = await orchestrator.checkDelivery(m.id, id);
      return { evidence_id: id, milestone_state: milestones.get(db, m.id)!.state, delivery_check: check };
    }],
    ["GET", /^\/milestones\/([^/]+)\/delivery-check$/, async ({ params }) => {
      if (!milestones.get(db, params[1])) throw new ApiError(404, "milestone not found");
      return evidenceStore().latestCheck(params[1]) ?? { checks: [], agent_mode: null, error: null, at: null };
    }],
    // Download an evidence file: always an attachment (octet-stream, nosniff, sandboxed); never rendered or executed.
    ["GET", /^\/evidence\/files\/([^/]+)$/, async ({ params }) => evidenceStore().download(params[1])],
    // Platform actions: only the platform (x-platform-token) may release, refund or settle. Funding never has a public
    // route of its own: card funding comes only through the signature-verified webhook (or, in DEMO_MODE, the
    // simulated checkout), stablecoin funding only from a deposit proven on-chain.
    ["POST", /^\/milestones\/([^/]+)\/release$/, platform(async ({ params }) => treasury.release(params[1]))],
    ["POST", /^\/milestones\/([^/]+)\/refund$/, platform(async ({ params }) => treasury.refund(params[1]))],
    ["POST", /^\/milestones\/([^/]+)\/settle$/, platform(async ({ params, body }) => {
      let agentMode;
      // No mode in the request: the server default (AGENT_MODE) applies. Passing undefined as the fallback would
      // fall through to parseAgentMode's own default of "live".
      if (body?.agent_mode !== undefined && body?.agent_mode !== null && body?.agent_mode !== "") {
        try { agentMode = parseAgentMode(body.agent_mode); } catch (e) { throw new ApiError(400, (e as Error).message); }
      }
      const result: any = await orchestrator.settle(params[1], { agentMode });
      // Start the off-chain leg (SIMULATED rails) of every payout the vault just confirmed.
      if (result?.decision === "approved") result.offchain = await processConfirmedPayouts(db, deps.now);
      return result;
    })],
    ["POST", /^\/milestones\/([^/]+)\/evidence\/summary$/, async ({ params }) => orchestrator.summarize(params[1])],
    ["POST", /^\/milestones\/([^/]+)\/escalations\/([^/]+)\/execute$/, async ({ params, body }) => {
      const result: any = await orchestrator.executeApproval(params[1], params[2], body ?? {});
      if (result?.decision === "approved") result.offchain = await processConfirmedPayouts(db, deps.now);
      return result;
    }],
    // Checkout. Real Stripe when its keys are set; otherwise Simulated (signed events into the same webhook path).
    ["GET", /^\/checkout\/options$/, async () => ({
      provider: deps.checkout.name, simulated: deps.checkout.name === "simulated",
      label: deps.checkout.name === "simulated" ? "Simulated: no money moves and no Stripe account is used" : "Stripe test mode",
      methods: PAYMENT_METHODS,
    })],
    ["POST", /^\/checkout\/sessions$/, async ({ body }) => startCheckout({
      db, provider: deps.checkout, treasury, publicBaseUrl: deps.publicBaseUrl, milestone_id: body?.milestone_id, method: body?.method,
    })],
    ["GET", /^\/checkout\/sessions\/([^/]+)$/, async ({ params }) => {
      if (!deps.simulatedCheckout) throw new ApiError(404, "session lookup is only available for the simulated checkout");
      return deps.simulatedCheckout.get(params[1]);
    }],
    ["POST", /^\/checkout\/sessions\/([^/]+)\/complete$/, async ({ params, body }) => {
      if (!deps.simulatedCheckout) throw new ApiError(404, "only the simulated checkout can be completed here; Stripe calls the webhook");
      return deps.simulatedCheckout.complete(params[1], body?.outcome);
    }],
    ["POST", /^\/checkout\/sessions\/([^/]+)\/dispute$/, async ({ params }) => {
      if (!deps.simulatedCheckout) throw new ApiError(404, "only the simulated checkout can simulate a dispute");
      return deps.simulatedCheckout.dispute(params[1]);
    }],
    ...contractRoutes({ db, now: deps.now, publicBaseUrl: deps.publicBaseUrl, onInvoiceCreated: emailInvoice, limitInvoices }),
    // The Emails view: every invoice email attempt (status, provider message id, time; never the key).
    ["GET", /^\/emails$/, async () => deps.mailer ? deps.mailer.list() : { configured: false, provider: null, daily_cap: 0, sent_today: 0, items: [] }],
    ...(payoutRoutes({ db, now: deps.now }) as [string, RegExp, Handler][]),
    ...(phoneRegistryRoutes({ db, now: deps.now, salt: deps.phoneHashSalt }) as [string, RegExp, Handler][]),
    ...(reconciliationRoutes({ db, now: deps.now }) as [string, RegExp, Handler][]),
    // Wallet layer (WDK user wallets) for the review screen.
    ["GET", /^\/wallets$/, async () => needWallets().list()],
    ["GET", /^\/wallets\/transfers\/([^/]+)$/, async ({ params }) => needWallets().status(params[1])],
    ["GET", /^\/wallets\/([^/]+)\/balance$/, async ({ params }) => needWallets().balance(params[1])],
    ["GET", /^\/wallets\/([^/]+)\/recipients$/, async ({ params }) => needWallets().recipients(params[1])],
    ["POST", /^\/wallets\/([^/]+)\/recipients$/, async ({ params, body }) => needWallets().saveRecipient(params[1], body ?? {})],
    // Demo wallet: add funds by SIMULATED card (DEMO_MODE only) and the wallet's recent activity.
    ["POST", /^\/wallets\/([^/]+)\/fund$/, async ({ params, body, req }) => { limitTopUps(req); return needWallets().fund(params[1], body ?? {}); }],
    ["GET", /^\/wallets\/([^/]+)\/activity$/, async ({ params }) => needWallets().activity(params[1])],
    ["POST", /^\/wallets\/([^/]+)\/transfers\/review$/, async ({ params, body }) => needWallets().review(params[1], body ?? {})],
    ["POST", /^\/wallets\/([^/]+)\/transfers$/, async ({ params, body }) => needWallets().send(params[1], body ?? {})],
    ["POST", /^\/wallets\/([^/]+)\/escrow\/([^/]+)\/(approve|dispute)$/, async ({ params }) => needWallets().escrowAction(params[1], params[2], params[3])],
    ["POST", /^\/wallets\/([^/]+)\/attestations\/([^/]+)$/, async ({ params, body }) => needWallets().signAttestation(params[1], params[2], body ?? {})],
    // The client signs a contract with its WDK wallet (demo custody); any user wallet can be a contract's client (the
    // freelancer paying for work from their own wallet). signContract checks the signer is the contract's client.
    // The provider signs with its own wallet.
    ["POST", /^\/wallets\/([^/]+)\/contracts\/([^/]+)\/sign$/, async ({ params }) => {
      const typed = signingPayload(db, params[2], "client");
      const s = await needWallets().signContractTypedData(params[1], typed as never);
      return signContract(db, params[2], { party: "client", signer: s.signer, signature: s.signature }, deps.now());
    }],
    // Tethran earnings (operator view): every confirmed 5% platform fee line and the earnings account. The account is a
    // demo wallet (DEMO earnings account); in production it would be a company treasury.
    ["GET", /^\/earnings$/, async () => {
      const lines = (db.prepare(
        `SELECT p.milestone_id, m.title, m.amount AS gross, p.amount, p.tx, p.status, p.at, p.to_address FROM payouts p
           LEFT JOIN milestones m ON m.id = p.milestone_id WHERE p.payee_id = 'tethran_earnings' ORDER BY p.at DESC`,
      ).all() as any[]);
      const confirmed = lines.filter((l) => l.status === "confirmed");
      const total = confirmed.reduce((n, l) => n + BigInt(l.amount), 0n);
      const payee = db.prepare("SELECT address FROM payees WHERE payee_id = 'tethran_earnings' LIMIT 1").get() as { address: string } | undefined;
      let balance: string | null = null;
      if (deps.wallets) { try { balance = ((await deps.wallets.balance("earnings")) as any).usdt.base_units; } catch { /* RPC read failed: shown as unavailable */ } }
      return {
        label: "Tethran earnings account (a company treasury in production). Test USDT on a test network.",
        fee: { bps: PLATFORM_FEE_BPS, rule: "5% of each milestone's gross, paid by the freelancer, enforced by the Policy Service (FEE_MISMATCH)" },
        account: { address: payee?.address ?? null, balance },
        total_collected: total.toString(),
        lines: lines.map((l) => ({ milestone_id: l.milestone_id, title: l.title, gross: l.gross, fee: l.amount, tx: l.tx, status: l.status, at: l.at })),
      };
    }],
    // What the app needs to create a contract for a provider: its payout address (the vault's fixed payee) and payees.
    ["GET", /^\/providers\/([^/]+)$/, async ({ params }) => {
      const v = db.prepare("SELECT * FROM vaults WHERE provider_id = ?").get(params[1]) as Record<string, unknown> | undefined;
      if (!v) throw new ApiError(404, "provider not found");
      // The Tethran earnings account is not one of the provider's payees (it only receives the platform fee).
      const payees = (db.prepare("SELECT payee_id, name, rail, simulated FROM payees WHERE provider_id = ? AND payee_id != 'tethran_earnings' ORDER BY payee_id").all(params[1]) as any[])
        .map((p) => ({ ...p, simulated: p.simulated === 1 }));
      return { provider_id: params[1], chain_id: v.chain_id, vault: v.vault, operator: v.operator, provider_address: v.provider_payout, payees };
    }],
    // SIMULATED identity verification provider
    ["POST", /^\/milestones\/([^/]+)\/identity$/, async ({ params, body }) => {
      if (!milestones.get(db, params[1])) throw new ApiError(404, "milestone not found");
      return recordIdentity(db, params[1], body ?? {});
    }],
    ...(deps.operator ? operatorRoutes(deps.operator) : []),
    ...(deps.x402 ? deps.x402.routes() : []),
    ["POST", /^\/webhooks\/stripe$/, async ({ raw, req }) => treasury.handleStripeWebhook(raw, req.headers["stripe-signature"] as string | undefined)],
    // Public receipt verification: read from the chain, not from the database.
    ["GET", /^\/receipts\/([^/]+)$/, async ({ params }) => {
      const r = await deps.chain.receiptOf(params[1]);
      if (!r) throw new ApiError(404, "no receipt for this milestone");
      return { ...r, verified_on_chain: true, chain_id: deps.chain.chainId };
    }],
    // For the Policy Service only.
    ["POST", /^\/internal\/vault-actions$/, internal(async ({ body }) => relayVaultActions(deps.chain, body?.vault, body?.actions))],
    ["GET", /^\/internal\/payees$/, internal(async () =>
      Object.fromEntries(allPayees(db).map((p) => [p.payee_id, { address: p.address, rail: p.rail, simulated: p.simulated === 1 }])))],
    ["GET", /^\/internal\/milestones\/([^/]+)\/identity$/, internal(async ({ params }) => {
      const m = milestones.get(db, params[1]);
      if (!m) throw new ApiError(404, "milestone not found");
      return deps.identity.check(m);
    })],
  ];

  const corsOrigins = new Set((deps.corsOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"]).map((o) => o.trim()).filter(Boolean));
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // CORS for the web app (only the configured origins; never for /internal, which is service-to-service).
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
      if (origin && corsOrigins.has(origin) && !url.pathname.startsWith("/internal/")) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader("access-control-expose-headers", "x-payment-response, content-disposition");
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, x-payment, idempotency-key",
            "access-control-max-age": "600",
          });
          return res.end();
        }
      }
      const matching = routes.filter(([, re]) => re.test(url.pathname));
      if (matching.length === 0) return send(res, 404, { error: "not found" });
      const route = matching.find(([m]) => m === req.method);
      if (!route) {
        res.setHeader("allow", matching.map(([m]) => m).join(", "));
        return send(res, 405, { error: "method not allowed" });
      }
      // A delivery submission may carry up to 5 files of 10 MB (base64); every other route keeps the small limit.
      const raw = req.method === "GET" ? "" : await readBody(req, /^\/milestones\/[^/]+\/evidence$/.test(url.pathname) ? MAX_EVIDENCE_BODY : MAX_BODY);
      let body: any;
      if (raw && !/^\/webhooks\//.test(url.pathname)) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "body is not valid JSON" });
        }
      }
      const params = route[1].exec(url.pathname)!.map((p) => decodeURIComponent(p));
      const out = await route[2]({ params: params as unknown as Record<string, string>, body, raw, req, url });
      if (out && typeof out === "object" && (out as RawResponse).__raw === true) {
        const r = out as RawResponse & { status?: number; headers?: Record<string, string> };
        res.writeHead(r.status ?? 200, { "content-type": r.contentType, ...(r.headers ?? {}), ...(r.filename ? { "content-disposition": `attachment; filename="${r.filename}"` } : {}) });
        return res.end(r.body);
      }
      send(res, 200, out);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: safeErrorMessage(e), ...(e.code ? { code: e.code } : {}) });
      // Logged for the operator (URLs and keys stripped); the client only sees "internal error".
      console.error(`internal error on ${req.method} ${(req.url ?? "").split("?")[0]}: ${safeErrorMessage(e)}`);
      send(res, 500, { error: "internal error" });
    }
  });
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : port);
    });
  });
}
