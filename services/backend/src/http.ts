// Backend HTTP API (node:http, JSON). Routes are documented in docs/API.md.
// Errors are { error, code? } with a safe message: no stack traces, URLs or key material.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { allPayees, milestones } from "./db";
import { ApiError, safeErrorMessage } from "./errors";
import type { IdentityCheck } from "./identity";
import type { Orchestrator } from "./orchestrator";
import type { Treasury } from "./treasury";
import type { TreasuryChain } from "./chainPort";

const MAX_BODY = 256 * 1024;

export interface HttpDeps {
  db: DatabaseSync;
  treasury: Treasury;
  orchestrator: Orchestrator;
  identity: IdentityCheck;
  chain: TreasuryChain;
  /** Shared secret for /internal/* (the Policy Service). Empty disables the internal routes. */
  internalToken: string;
  now: () => Date;
}

type Handler = (ctx: { params: Record<string, string>; body: any; raw: string; req: IncomingMessage; url: URL }) => Promise<unknown>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
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

  const internal = (h: Handler): Handler => async (ctx) => {
    const token = String(ctx.req.headers["x-internal-token"] ?? "");
    if (!deps.internalToken || !sameSecret(token, deps.internalToken)) throw new ApiError(401, "internal route");
    return h(ctx);
  };

  const timeline = (id: string) => {
    const m = milestones.get(db, id);
    if (!m) throw new ApiError(404, "milestone not found");
    return {
      milestone: m,
      fundings: db.prepare("SELECT source, reference, amount, chain_id, escrow_tx, status, at FROM fundings WHERE milestone_id = ? ORDER BY id").all(id),
      evidence: db.prepare("SELECT id, at FROM evidence WHERE milestone_id = ? ORDER BY id").all(id),
      settlement_plans: (db.prepare("SELECT id, proposal_hash, trace_id, decision, reasons, at FROM settlement_plans WHERE milestone_id = ? ORDER BY id").all(id) as any[])
        .map((p) => ({ ...p, reasons: JSON.parse(p.reasons) })),
      payouts: db.prepare("SELECT action_index, action_id, payee_id, rail, to_address, amount, tx, status, simulated, at FROM payouts WHERE milestone_id = ? ORDER BY action_index").all(id),
      receipt: db.prepare("SELECT * FROM receipts WHERE milestone_id = ?").get(id) ?? null,
    };
  };

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/health$/, async () => ({ ok: true })],
    ["POST", /^\/milestones$/, async ({ body }) => treasury.createMilestone(body ?? {})],
    ["GET", /^\/milestones\/([^/]+)$/, async ({ params }) => treasury.sync(params[1])],
    ["GET", /^\/milestones\/([^/]+)\/timeline$/, async ({ params }) => {
      await treasury.sync(params[1]).catch(() => undefined);
      return timeline(params[1]);
    }],
    ["GET", /^\/milestones\/([^/]+)\/deposit$/, async ({ params }) => treasury.depositInstructions(params[1])],
    ["POST", /^\/milestones\/([^/]+)\/deposit\/confirm$/, async ({ params, body }) => treasury.confirmDeposit(params[1], String(body?.tx_hash ?? ""))],
    ["POST", /^\/milestones\/([^/]+)\/evidence$/, async ({ params, body }) => {
      const m = milestones.get(db, params[1]);
      if (!m) throw new ApiError(404, "milestone not found");
      const text = body?.text;
      if (typeof text !== "string" || text.length === 0 || text.length > 20_000) throw new ApiError(400, "text is required (max 20000 chars)");
      // Stored as untrusted data; it reaches the agent only inside the evidence delimiters.
      const id = db.prepare("INSERT INTO evidence (milestone_id, text, at) VALUES (?, ?, ?)").run(m.id, text, deps.now().toISOString()).lastInsertRowid;
      if (m.state === "funded") milestones.setState(db, m.id, "in_review");
      return { evidence_id: Number(id), milestone_state: milestones.get(db, m.id)!.state };
    }],
    ["POST", /^\/milestones\/([^/]+)\/release$/, async ({ params }) => treasury.release(params[1])],
    ["POST", /^\/milestones\/([^/]+)\/refund$/, async ({ params }) => treasury.refund(params[1])],
    ["POST", /^\/milestones\/([^/]+)\/settle$/, async ({ params }) => orchestrator.settle(params[1])],
    ["POST", /^\/webhooks\/stripe$/, async ({ raw, req }) => treasury.handleStripeWebhook(raw, req.headers["stripe-signature"] as string | undefined)],
    // Public receipt verification: read from the chain, not from the database.
    ["GET", /^\/receipts\/([^/]+)$/, async ({ params }) => {
      const r = await deps.chain.receiptOf(params[1]);
      if (!r) throw new ApiError(404, "no receipt for this milestone");
      return { ...r, verified_on_chain: true, chain_id: deps.chain.chainId };
    }],
    // For the Policy Service only.
    ["GET", /^\/internal\/payees$/, internal(async () =>
      Object.fromEntries(allPayees(db).map((p) => [p.payee_id, { address: p.address, rail: p.rail, simulated: p.simulated === 1 }])))],
    ["GET", /^\/internal\/milestones\/([^/]+)\/identity$/, internal(async ({ params }) => {
      const m = milestones.get(db, params[1]);
      if (!m) throw new ApiError(404, "milestone not found");
      return deps.identity.check(m);
    })],
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const matching = routes.filter(([, re]) => re.test(url.pathname));
      if (matching.length === 0) return send(res, 404, { error: "not found" });
      const route = matching.find(([m]) => m === req.method);
      if (!route) {
        res.setHeader("allow", matching.map(([m]) => m).join(", "));
        return send(res, 405, { error: "method not allowed" });
      }
      const raw = req.method === "GET" ? "" : await readBody(req);
      let body: any;
      if (raw && !/^\/webhooks\//.test(url.pathname)) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "body is not valid JSON" });
        }
      }
      const params = route[1].exec(url.pathname)!.map((p) => decodeURIComponent(p));
      send(res, 200, await route[2]({ params: params as unknown as Record<string, string>, body, raw, req, url }));
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: safeErrorMessage(e), ...(e.code ? { code: e.code } : {}) });
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
