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
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { EvmChainClient, SqliteIdempotencyStore, createWdkWallets, loadChain, loadEnvOnly, newProvider } from "../../chain/src/index";
import { createWalletLayer } from "./wallets";
import { createOperator } from "./operator";
import { migratePayouts } from "./payouts";
import { migratePhoneRegistry } from "./phoneRegistry";
import { migrateReconciliation } from "./reconciliation";
import { configFromEnv, createLlmProvider, createTracerFromEnv } from "../../llm/src/index";
import { createAgentSigner } from "./agentSigner";
import { openDb } from "./db";
import { createHttpServer, listen } from "./http";
import { createIdentityCheck } from "./identity";
import { createOrchestrator } from "./orchestrator";
import { createPolicyClient } from "./policyClient";
import { createTreasury, type Treasury } from "./treasury";
import { randomBytes } from "node:crypto";
import { createSimulatedCheckout, createStripeCheckout } from "./checkout";
import { migrateContracts } from "./contracts";
import { createAgent, loadSavedProposals, parseAgentMode } from "./replay";

// Only the backend's own settings and keys. It never receives the Policy Service or operator key.
loadEnvOnly(resolve(__dirname, "../../../.env"), [
  "CHAIN", "RPC_URL_*", "TREASURY_PRIVATE_KEY", "AGENT_SIGNER_PRIVATE_KEY", "ARBITER_ADDRESS", "POLICY_URL", "INTERNAL_TOKEN",
  "STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "LLM_*", "GROQ_*", "GEMINI_*", "NVIDIA_*", "OPIK_*",
  "BACKEND_DATA_DIR", "BACKEND_PORT", "HOST", "CARD_HOLD_SECONDS", "MILESTONE_TIMEOUT_SECONDS",
  "AGENT_MODE", "PUBLIC_BASE_URL", "FEE_BPS", "FEE_FIXED_CENTS", "DEMO_WALLET_SEED", "PHONE_HASH_SALT",
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
const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
const webhookSecret = stripeEnabled ? process.env.STRIPE_WEBHOOK_SECRET! : `whsec_simulated_${randomBytes(24).toString("hex")}`;
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

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
const policyClient = createPolicyClient(need("POLICY_URL"));
const llm = createLlmProvider(configFromEnv(process.env), { fetch: globalThis.fetch as never, tracer });
const orchestrator = createOrchestrator({
  db, chain, agentSigner, tracer, now, chainName: chainCfg.name,
  policy: policyClient,
  agent: createAgent(llm, loadSavedProposals()),
  defaultAgentMode: parseAgentMode(process.env.AGENT_MODE, "live+replay"),
});
const simulatedCheckout = stripeEnabled ? undefined : createSimulatedCheckout({ db, webhookSecret, treasury: () => treasury, publicBaseUrl, now });
const checkout = stripeEnabled ? createStripeCheckout({ secretKey: process.env.STRIPE_SECRET_KEY! }) : simulatedCheckout!.provider;

// WDK user wallets (client, payees, subcontractor) for the wallet-layer API; demo custody of a test seed.
const wdkWallets = process.env.DEMO_WALLET_SEED
  ? createWdkWallets({ chain: chainCfg, seed: process.env.DEMO_WALLET_SEED, maxTransfer: 10_000_000_000n })
  : undefined;
const wallets = wdkWallets
  ? createWalletLayer({
      db, now,
      wallets: wdkWallets,
      chain: { chainId: chainCfg.chainId, name: chainCfg.name, usdt: chainCfg.usdt, ready: () => chain.ready(), txStatus: (h) => chain.txStatus(h) },
      escrowFor: (role) => new EvmChainClient(chainCfg, wdkWallets!.sender(role), new SqliteIdempotencyStore(`${dir}/chain-idempotency.sqlite`), { provider }),
      attestationTypedData: (id, kind, release) => chain.attestationTypedData(id, kind, release),
    })
  : undefined;
const operator = createOperator({ db, chain, treasury, policy: policyClient, now });

const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 8788);
const host = process.env.HOST ?? "127.0.0.1";
listen(createHttpServer({
  db, treasury, orchestrator, identity, chain, internalToken: process.env.INTERNAL_TOKEN ?? "", now, checkout, simulatedCheckout, publicBaseUrl, wallets, phoneHashSalt: process.env.PHONE_HASH_SALT, operator,
}), port, host).then(
  (p) => console.log(`backend listening on ${host}:${p} (chain ${chainCfg.name} ${chainCfg.chainId}; checkout ${checkout.name}; agent ${process.env.AGENT_MODE ?? "live+replay"})`),
  (e) => {
    console.error("could not start:", (e as Error).message);
    process.exit(1);
  },
);
