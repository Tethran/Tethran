// x402: pay-per-request data endpoints, and the agent's purchase tool that pays them.
//
// Protocol: HTTP 402 Payment Required with an x402 "exact" payment requirement; the client retries with an
// X-PAYMENT header carrying an EIP-3009 TransferWithAuthorization signed by the payer; the server verifies it and
// settles it on-chain, then answers with the data and an X-PAYMENT-RESPONSE header.
//
// As built: the x402 message shapes are implemented directly here, and the facilitator role (verify + settle) is
// this backend itself, settling on our TestUSDT (which implements EIP-3009) through ChainClient. The @x402 npm
// SDK and a hosted facilitator are NOT used (hosted facilitators settle USDC on their own networks, not our test
// token). Settlement is real on the test network; the data served is demo data and is labelled.
import type { DatabaseSync } from "node:sqlite";
import { getAddress, hexlify, randomBytes, verifyTypedData } from "ethers";
import { getCountryProfile, listCountryProfiles } from "./countryProfiles";
import { milestones } from "./db";
import { ApiError } from "./errors";

export const X402_VERSION = 1;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

export interface PaymentRequirement {
  scheme: "exact";
  network: string;          // CAIP-2, e.g. eip155:11155111
  maxAmountRequired: string; // base units of the asset
  resource: string;
  description: string;
  mimeType: "application/json";
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  };
}

export interface X402Chain {
  chainId: number;
  usdtDomain(): { name: string; version: string; chainId: number; verifyingContract: string };
  authorizationUsed(from: string, nonce: string): Promise<boolean>;
  submitTransferWithAuthorization(auth: PaymentPayload["payload"]["authorization"], signature: string, key: string): Promise<{ txHash: string }>;
  waitConfirmed(h: string): Promise<void>;
}

export function migrateX402(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS x402_payments (
    payer TEXT NOT NULL, nonce TEXT NOT NULL, resource TEXT NOT NULL, amount TEXT NOT NULL, tx TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (payer, nonce)
  )`);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** Prices in test-USDT base units. */
export const X402_PRICES = { corridor_rules: 20_000n, fx_quote: 10_000n, invoice_status: 10_000n, settlement_proof: 10_000n };

/** SIMULATED demo rates: placeholders, not market data. */
const DEMO_RATES: Record<string, string> = { NGN: "1500.00", KES: "129.00", ZAR: "18.20", GHS: "15.50" };

export function createX402Server(deps: { db: DatabaseSync; chain: X402Chain; payTo: string; now: () => Date }) {
  const { db, chain } = deps;
  migrateX402(db);
  const network = `eip155:${chain.chainId}`;
  const nowS = () => Math.floor(deps.now().getTime() / 1000);

  const requirement = (resource: string, price: bigint, description: string): PaymentRequirement => {
    const d = chain.usdtDomain();
    return {
      scheme: "exact", network, maxAmountRequired: price.toString(), resource, description, mimeType: "application/json",
      payTo: getAddress(deps.payTo), maxTimeoutSeconds: 300, asset: d.verifyingContract, extra: { name: d.name, version: d.version },
    };
  };

  /** Returns a 402 response, or settles the payment and returns the data (with X-PAYMENT-RESPONSE). */
  async function paid(header: string | undefined, req: PaymentRequirement, data: () => unknown) {
    const required = { __raw: true, status: 402, contentType: "application/json", body: JSON.stringify({ x402Version: X402_VERSION, error: "X-PAYMENT header is required", accepts: [req] }) };
    if (!header) return required;
    let p: PaymentPayload;
    try {
      p = unb64(header);
    } catch {
      return { ...required, body: JSON.stringify({ x402Version: X402_VERSION, error: "X-PAYMENT is not base64 JSON", accepts: [req] }) };
    }
    const fail = (error: string) => ({ ...required, body: JSON.stringify({ x402Version: X402_VERSION, error, accepts: [req] }) });
    const a = p?.payload?.authorization;
    if (p?.scheme !== "exact" || p?.network !== network || !a || typeof p.payload.signature !== "string") return fail("unsupported scheme or network");
    if (getAddress(a.to) !== getAddress(req.payTo)) return fail("payment is not to this resource's payTo address");
    if (BigInt(a.value) < BigInt(req.maxAmountRequired)) return fail("payment is below the price");
    if (!(nowS() > Number(a.validAfter) && nowS() < Number(a.validBefore))) return fail("authorization is outside its validity window");
    let signer: string;
    try {
      signer = getAddress(verifyTypedData(chain.usdtDomain(), TRANSFER_WITH_AUTHORIZATION_TYPES, a, p.payload.signature));
    } catch {
      return fail("signature is malformed");
    }
    if (signer !== getAddress(a.from)) return fail("signature does not match the payer");
    const prior = db.prepare("SELECT tx FROM x402_payments WHERE payer = ? AND nonce = ?").get(signer, a.nonce) as { tx: string } | undefined;
    if (!prior && (await chain.authorizationUsed(signer, a.nonce))) return fail("authorization nonce already used");
    let tx = prior?.tx;
    if (!tx) {
      const ref = await chain.submitTransferWithAuthorization(a, p.payload.signature, `x402:${signer}:${a.nonce}`);
      await chain.waitConfirmed(ref.txHash);
      tx = ref.txHash;
      db.prepare("INSERT OR IGNORE INTO x402_payments VALUES (?, ?, ?, ?, ?, ?)").run(signer, a.nonce, req.resource, a.value, tx, deps.now().toISOString());
    }
    return {
      __raw: true, status: 200, contentType: "application/json",
      headers: { "x-payment-response": b64({ success: true, transaction: tx, network, payer: signer }) },
      body: JSON.stringify({ ...(data() as object), x402: { paid: a.value, asset: req.asset, transaction: tx } }),
    };
  }

  const header = (req: { headers: Record<string, unknown> }) => req.headers["x-payment"] as string | undefined;

  return {
    routes(): [string, RegExp, (ctx: any) => Promise<unknown>][] {
      return [
        ["GET", /^\/x402$/, async () => ({
          x402Version: X402_VERSION, network, facilitator: "this backend (verify and settle on TestUSDT via EIP-3009)",
          resources: ["/x402/corridor-rules?corridor=US-NG", "/x402/fx-quote?to=NGN", "/x402/invoices/{id}/status", "/x402/milestones/{id}/settlement-proof"],
          prices: Object.fromEntries(Object.entries(X402_PRICES).map(([k, v]) => [k, v.toString()])),
        })],
        ["GET", /^\/x402\/corridor-rules$/, async ({ url, req }) => {
          const corridor = String(url.searchParams.get("corridor") ?? "");
          const code = corridor.split("-")[1];
          const profile = getCountryProfile(code);
          if (!profile) throw new ApiError(400, `corridor must look like US-NG; known countries: ${listCountryProfiles().map((c) => c.code).join(", ")}`);
          return paid(header(req), requirement(url.pathname + url.search, X402_PRICES.corridor_rules, `Corridor rules for ${corridor}`), () => ({
            corridor, country: profile.code, currency: profile.currency, payout_rails: profile.payout_rails,
            required_invoice_fields: profile.required_invoice_fields, tax_rates: profile.tax_rates,
            min_amount: "1000000", max_amount: "10000000000", settlement_days: profile.code === "KE" ? 0 : 1,
            notes: "Demo data from the country profile; tax rates are unverified placeholders.", simulated_data: true,
          }));
        }],
        ["GET", /^\/x402\/fx-quote$/, async ({ url, req }) => {
          const to = String(url.searchParams.get("to") ?? "").toUpperCase();
          if (!DEMO_RATES[to]) throw new ApiError(400, `to must be one of ${Object.keys(DEMO_RATES).join(", ")}`);
          return paid(header(req), requirement(url.pathname + url.search, X402_PRICES.fx_quote, `USD to ${to} quote`), () => ({
            from: "USD", to, rate: DEMO_RATES[to], valid_seconds: 300, simulated_data: true, note: "SIMULATED rate, not market data",
          }));
        }],
        ["GET", /^\/x402\/invoices\/([^/]+)\/status$/, async ({ params, url, req }) => {
          const inv = db.prepare("SELECT number, status, total_cents, due_date, escrow_milestone_id FROM invoices WHERE id = ?").get(params[1]) as any;
          if (!inv) throw new ApiError(404, "invoice not found");
          return paid(header(req), requirement(url.pathname, X402_PRICES.invoice_status, `Status of invoice ${inv.number}`), () => {
            const m = milestones.get(db, inv.escrow_milestone_id);
            return { invoice: inv.number, status: inv.status, total_cents: inv.total_cents, due_date: inv.due_date, milestone_state: m?.state ?? "draft" };
          });
        }],
        ["GET", /^\/x402\/milestones\/([^/]+)\/settlement-proof$/, async ({ params, url, req }) => {
          const m = milestones.get(db, params[1]);
          if (!m) throw new ApiError(404, "milestone not found");
          return paid(header(req), requirement(url.pathname, X402_PRICES.settlement_proof, `Settlement proof for ${m.id}`), () => {
            const plan = db.prepare("SELECT proposal_hash, trace_id, decision FROM settlement_plans WHERE milestone_id = ? ORDER BY id DESC LIMIT 1").get(m.id) as any;
            const receipt = db.prepare("SELECT token_id, mint_tx, settlement_hash, chain_id FROM receipts WHERE milestone_id = ?").get(m.id) as any;
            const payouts = db.prepare("SELECT action_index, amount, tx, status FROM payouts WHERE milestone_id = ? ORDER BY action_index").all(m.id);
            return { milestone_id: m.id, state: m.state, chain_id: m.chain_id, escrow_tx: m.escrow_tx, release_tx: m.release_tx, settlement: plan ?? null, payouts, receipt: receipt ?? null };
          });
        }],
      ];
    },
  };
}

/**
 * The agent's purchase tool: an x402 client that pays from a dedicated WDK budget wallet. The spending cap is
 * enforced here before anything is signed, and the wallet's WDK policy caps each authorization again.
 * The agent (LLM) never sees this wallet or any signature; the orchestrator calls this before the model call.
 */
export function createX402Client(deps: {
  baseUrl: string;
  payer: { address(): Promise<string>; signTypedData(t: { domain: any; types: any; message: any }): Promise<string> };
  capPerRun: bigint;
  now: () => Date;
  fetch?: typeof fetch;
}) {
  const f = deps.fetch ?? fetch;
  let spent = 0n;
  return {
    spent: () => spent,
    remaining: () => deps.capPerRun - spent,
    async get(path: string): Promise<{ data: any; paid: string; transaction: string }> {
      const url = new URL(path, deps.baseUrl);
      const first = await f(url, { signal: AbortSignal.timeout(60_000) });
      if (first.status !== 402) {
        if (!first.ok) throw new ApiError(502, `x402 resource answered ${first.status}`);
        return { data: await first.json(), paid: "0", transaction: "" };
      }
      const offer = (await first.json()) as { accepts: PaymentRequirement[] };
      const req = offer.accepts?.[0];
      if (!req || req.scheme !== "exact") throw new ApiError(502, "x402 resource offered no usable payment option");
      const price = BigInt(req.maxAmountRequired);
      if (spent + price > deps.capPerRun) throw new ApiError(409, `x402 spending cap: ${price} would exceed the ${deps.capPerRun} cap for this run (spent ${spent})`, "SPENDING_CAP");
      const nowS = Math.floor(deps.now().getTime() / 1000);
      const authorization = {
        from: await deps.payer.address(), to: req.payTo, value: req.maxAmountRequired,
        validAfter: String(nowS - 60), validBefore: String(nowS + req.maxTimeoutSeconds), nonce: hexlify(randomBytes(32)),
      };
      const chainId = Number(req.network.split(":")[1]);
      const signature = await deps.payer.signTypedData({
        domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES, message: authorization,
      });
      const payment: PaymentPayload = { x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { signature, authorization } };
      const second = await f(url, { headers: { "x-payment": b64(payment) }, signal: AbortSignal.timeout(300_000) });
      const body: any = await second.json();
      if (second.status !== 200) throw new ApiError(502, `x402 payment refused: ${body?.error ?? second.status}`, "X402_REFUSED");
      spent += price;
      const settled = second.headers.get("x-payment-response");
      return { data: body, paid: price.toString(), transaction: settled ? unb64(settled).transaction : body?.x402?.transaction };
    },
  };
}

export type X402Client = ReturnType<typeof createX402Client>;
