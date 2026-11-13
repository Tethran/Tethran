// Starts the backend. Config from environment variables (see .env.example); keys are read once and never printed.
//   TREASURY_PRIVATE_KEY     treasury: FUNDER, RELEASER and MINTER (test key)
//   AGENT_SIGNER_PRIVATE_KEY the agent signer module (first vault co-signer; never given to the LLM)
//   ARBITER_ADDRESS          the platform arbiter (address only)
//   POLICY_URL               the Policy Service, e.g. http://127.0.0.1:8787
//   INTERNAL_TOKEN           shared secret the Policy Service sends to /internal/*
//   STRIPE_WEBHOOK_SECRET    whsec_... from the Stripe dashboard (optional until Stripe is set up)
//   CHAIN, BACKEND_DATA_DIR (default "."), PORT (default 8788), HOST (default 127.0.0.1)
//   CARD_HOLD_SECONDS (default 600), MILESTONE_TIMEOUT_SECONDS (default 7 days)
//   LLM_* and OPIK_* as in services/llm
import { join, resolve } from "node:path";
import { createEvidenceStore } from "./evidence";
import { createNotifications } from "./notifications";
import { createFxService } from "./fx";
import { usePayoutFx } from "./payouts";
import { runReminders } from "./invoices";
import { safeErrorMessage as safeMsg } from "./errors";
import { Wallet } from "ethers";
import { EvmChainClient, SqliteIdempotencyStore, createWdkWallets, loadChain, loadEnvOnly, newProvider } from "../../chain/src/index";
import { createWalletLayer } from "./wallets";
import { createOperator } from "./operator";
import { createX402Client, createX402Server } from "./x402";
import { getCountryProfile } from "./countryProfiles";
import { migratePayouts } from "./payouts";
import { migratePhoneRegistry } from "./phoneRegistry";
import { migrateReconciliation } from "./reconciliation";
import { configFromEnv, createLlmProvider, createTracerFromEnv, traceTool } from "../../llm/src/index";
import { createAgentSigner } from "./agentSigner";
import { openDb } from "./db";
import { createHttpServer, listen } from "./http";
import { createIdentityCheck } from "./identity";
import { createOrchestrator } from "./orchestrator";
import { createPolicyClient } from "./policyClient";
import { createTreasury, maxMilestoneCents, type Treasury } from "./treasury";
import { assertWebhookSecret } from "./stripe";
import { randomBytes } from "node:crypto";
import { createSimulatedCheckout, createStripeCheckout } from "./checkout";
import { migrateContracts } from "./contracts";
import { createAgent, loadSavedProposals, parseAgentMode } from "./replay";

// Only the backend's own settings and keys. It never receives the Policy Service or operator key.
loadEnvOnly(resolve(__dirname, "../../../.env"), [
  "CHAIN", "RPC_URL_*", "TREASURY_PRIVATE_KEY", "AGENT_SIGNER_PRIVATE_KEY", "ARBITER_ADDRESS", "POLICY_URL", "INTERNAL_TOKEN",
  "STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "DEMO_MODE", "PLATFORM_TOKEN", "MAX_MILESTONE_USD_CENTS", "LLM_*", "GROQ_*", "GEMINI_*", "NVIDIA_*", "OPIK_*",
  "BACKEND_DATA_DIR", "BACKEND_PORT", "HOST", "CARD_HOLD_SECONDS", "MILESTONE_TIMEOUT_SECONDS",
  "AGENT_MODE", "PUBLIC_BASE_URL", "APP_BASE_URL", "FEE_BPS", "FEE_FIXED_CENTS", "DEMO_WALLET_SEED", "PHONE_HASH_SALT", "X402_CAP_PER_RUN", "CORS_ORIGINS",
]);

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error("missing environment variable " + name);
  return v;
}

const chainCfg = loadChain();
const dir = process.env.BACKEND_DATA_DIR ?? ".";
const provider = newProvider(chainCfg);
const treasuryWallet = new Wallet(need("TREASURY_PRIVATE_KEY"), provider);
const chain = new EvmChainClient(chainCfg, treasuryWallet, new SqliteIdempotencyStore(`${dir}/chain-idempotency.sqlite`), { provider });
const db = openDb(`${dir}/backend.sqlite`);
migrateContracts(db);
migratePayouts(db);
migratePhoneRegistry(db);
migrateReconciliation(db);
const now = () => new Date();
const identity = createIdentityCheck(db);
const tracer = createTracerFromEnv(process.env);

// Real Stripe only when both keys are set. Otherwise the Simulated checkout signs its events with a secret of
// its own, and the treasury verifies them with that secret through the same webhook code.
const demoMode = process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
// Outside DEMO_MODE a real webhook secret is required; the simulated checkout (random secret) is DEMO_MODE only.
try {
  assertWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET, demoMode);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
maxMilestoneCents(); // fails at startup if MAX_MILESTONE_USD_CENTS is set to something unusable
const webhookSecret = stripeEnabled ? process.env.STRIPE_WEBHOOK_SECRET! : `whsec_simulated_${randomBytes(24).toString("hex")}`;
// APP_BASE_URL: where the web app is served. Pay links, notification links and email links use it.
const publicBaseUrl = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

const treasury: Treasury = createTreasury({
  db, chain, identity, now, tracer,
  config: {
    chainId: chainCfg.chainId, chainName: chainCfg.name, treasuryAddress: treasuryWallet.address, usdtAddress: chainCfg.usdt,
    arbiterAddress: need("ARBITER_ADDRESS"),
    defaultTimeoutSeconds: Number(process.env.MILESTONE_TIMEOUT_SECONDS ?? 7 * 24 * 3600),
    cardHoldSeconds: Number(process.env.CARD_HOLD_SECONDS ?? 600),
    stripeWebhookSecret: webhookSecret,
  },
});
const agentSigner = createAgentSigner(
  new Wallet(need("AGENT_SIGNER_PRIVATE_KEY")),
  async (vault) => (await chain.vaultState(vault)).policySigner,
  now,
);
const policyClient = createPolicyClient(need("POLICY_URL"), need("INTERNAL_TOKEN"));
const llm = createLlmProvider(configFromEnv(process.env), { fetch: globalThis.fetch as never, tracer });
const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 8788);
const host = process.env.HOST ?? "127.0.0.1";

// x402: this backend sells corridor data and proofs; the agent's purchase tool pays from a WDK budget wallet.
const x402 = createX402Server({ db, chain, payTo: treasuryWallet.address, now });
const wdkWallets = process.env.DEMO_WALLET_SEED
  ? createWdkWallets({ chain: chainCfg, seed: process.env.DEMO_WALLET_SEED, maxTransfer: 10_000_000_000n })
  : undefined;
const capPerRun = BigInt(process.env.X402_CAP_PER_RUN ?? "50000"); // 0.05 test USDT per settlement run
const buyPaidData = wdkWallets
  ? async (m: { id: string }) => {
      const inv = db.prepare("SELECT country FROM invoices WHERE escrow_milestone_id = ? LIMIT 1").get(m.id) as { country: string } | undefined;
      const profile = inv ? getCountryProfile(inv.country) : undefined;
      if (!profile) return [];
      const budget = await wdkWallets.account("agent_budget");
      const client = createX402Client({
        baseUrl: `http://127.0.0.1:${port}`, capPerRun, now,
        payer: { address: () => budget.getAddress(), signTypedData: (t) => budget.signTypedData(t) },
      });
      const rules = await traceTool("buy_corridor_rules", { input: { corridor: `US-${profile.code}` }, output: (x) => ({ paid: x.paid, tx: x.transaction }) },
        () => client.get(`/x402/corridor-rules?corridor=US-${profile.code}`));
      const fx = await traceTool("buy_fx_quote", { input: { to: profile.currency }, output: (x) => ({ paid: x.paid, tx: x.transaction }) },
        () => client.get(`/x402/fx-quote?to=${profile.currency}`));
      return [
        { tool: "buy_corridor_rules", simulated: false, data: { ...rules.data, paid_via: "x402", paid: rules.paid, tx: rules.transaction } },
        { tool: "buy_fx_quote", simulated: false, data: { ...fx.data, paid_via: "x402", paid: fx.paid, tx: fx.transaction } },
      ];
    }
  : undefined;

// Delivery evidence: notes, links and files; files on the data disk (${dir}/uploads, git-ignored with the data dir).
const evidence = createEvidenceStore(db, join(dir, "uploads"));
const orchestrator = createOrchestrator({
  evidence,
  buyPaidData,
  db, chain, agentSigner, tracer, now, chainName: chainCfg.name,
  policy: policyClient,
  agent: createAgent(llm, loadSavedProposals()),
  defaultAgentMode: parseAgentMode(process.env.AGENT_MODE, "live+replay"),
});
const simulatedCheckout = stripeEnabled || !demoMode ? undefined : createSimulatedCheckout({ db, webhookSecret, treasury: () => treasury, publicBaseUrl, now });
const checkout = stripeEnabled ? createStripeCheckout({ secretKey: process.env.STRIPE_SECRET_KEY! }) : simulatedCheckout!.provider;

// WDK user wallets (client, payees, subcontractor) for the wallet-layer API; demo custody of a test seed.
const wallets = wdkWallets
  ? createWalletLayer({
      db, now,
      wallets: wdkWallets,
      chain: { chainId: chainCfg.chainId, name: chainCfg.name, usdt: chainCfg.usdt, ready: () => chain.ready(), txStatus: (h) => chain.txStatus(h) },
      escrowFor: (role) => new EvmChainClient(chainCfg, wdkWallets!.sender(role), new SqliteIdempotencyStore(`${dir}/chain-idempotency.sqlite`), { provider }),
      attestationTypedData: (id, kind, release) => chain.attestationTypedData(id, kind, release),
      // DEMO_MODE only: wallet top-ups by simulated card, minted by the treasury (1 USD = 1 test USDT).
      ...(demoMode ? { faucet: { mint: (to: string, amount: string, key: string) => chain.mintTestUsdt(to, amount, key), waitConfirmed: (h: string) => chain.waitConfirmed(h) } } : {}),
    })
  : undefined;
const operator = createOperator({ db, chain, treasury, policy: policyClient, now });

// Notifications (per role) and the invoice reminder job: reminders are due 3 days before, on, and 7 days after the
// due date of an unpaid invoice; each kind once per invoice. The job runs hourly and its reminders become client
// notifications (no email for reminders).
const notifications = createNotifications(db, { now, appBaseUrl: publicBaseUrl });
// Indicative exchange rates for the app's own screens and payout quotes (fx.ts): ExchangeRate-API's open endpoint,
// cached 6 hours (refresh tried hourly; a fresh cache makes no call), locked per milestone. Never served by a paid or
// programmatic endpoint (their terms forbid it): /x402/fx-quote keeps its own "Sample rates".
const fx = createFxService({ db, now });
usePayoutFx(fx);
void fx.refresh();
setInterval(() => void fx.refresh(), 60 * 60 * 1000).unref();
const reminderJob = () => { try { runReminders({ db, now, publicBaseUrl }, now()); notifications.sync(); } catch (e) { console.error("reminder job failed: " + safeMsg(e)); } };
reminderJob();
setInterval(reminderJob, 60 * 60 * 1000).unref();

listen(createHttpServer({
  fx,
  notifications,
  evidence,
  db, treasury, orchestrator, identity, chain, internalToken: process.env.INTERNAL_TOKEN ?? "", now, checkout, simulatedCheckout, publicBaseUrl, wallets, phoneHashSalt: process.env.PHONE_HASH_SALT, operator, x402,
  platformToken: process.env.PLATFORM_TOKEN ?? "",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(","),
}), port, host).then(
  (p) => console.log(`backend listening on ${host}:${p} (chain ${chainCfg.name} ${chainCfg.chainId}; checkout ${checkout.name}; agent ${process.env.AGENT_MODE ?? "live+replay"})`),
  (e) => {
    console.error("could not start:", (e as Error).message);
    process.exit(1);
  },
);
