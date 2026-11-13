// The full vertical slice through the real services, as separate processes with separate keys:
//
//   Policy Service process: holds only the POLICY_SIGNER key.
//   Backend process:        holds only the TREASURY key and the AGENT_SIGNER key (signer module, not the LLM).
//   This script:            plays the people around them. The client wallet (deposit, approve) and the
//                           operator (the provider's own wallet signing limits) are user wallets.
//
// Steps: seed provider, vault and payees -> operator signs vault limits and payees (on-chain) and the Policy
// Service policy -> start both services -> create milestone -> client deposits test USDT -> backend confirms the
// deposit and funds the escrow -> client approves on-chain -> provider submits evidence -> backend releases ->
// backend settles: agent (LLM) -> Policy Service decision and co-signature -> agent signer -> vault payouts ->
// receipt mint. One Opik trace for the settlement.
//
// Usage: CHAIN=localhost npm run slice   (or CHAIN=sepolia)
// TEST NETWORKS ONLY. Needs the contracts deployed on that chain (deploy.ts, deploy-vault.ts, deploy-receipt.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Wallet, getAddress, id as keccakUtf8 } from "ethers";
import { parse } from "dotenv";
import { EvmChainClient, InMemoryIdempotencyStore, VAULT_TYPES, createWdkWallets, loadChain, newProvider, safeErrorMessage } from "../../chain/src/index";
import { openDb } from "../src/db";
import { policyDocumentTypes, policyDocumentValue, policyDomain } from "../../policy/src/typed";

const ROOT = resolve(__dirname, "../../..");
const fileEnv = parse(readFileSync(join(ROOT, ".env")));
// The API-key RPC (Alchemy) is the primary for this process too; the public RPC in chains.json becomes its fallback.
for (const [k, v] of Object.entries(fileEnv)) if (k.startsWith("RPC_URL_") && process.env[k] === undefined) process.env[k] = v;
const env = (k: string) => process.env[k] ?? fileEnv[k] ?? "";
const wallet = (role: string) => {
  const pk = env(`${role}_PRIVATE_KEY`);
  if (!pk) throw new Error(`${role}_PRIVATE_KEY is not set`);
  return new Wallet(pk);
};
const usdt = (n: number) => (BigInt(n) * 1_000_000n).toString();
const say = (label: string, text: string) => console.log(`${label.padEnd(18)} ${text}`);

/** Starts a service with exactly the env it is allowed to have (the parent's secrets are not inherited). */
function start(name: string, entry: string, allowed: Record<string, string>): ChildProcess {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec"]) {
    if (process.env[k]) base[k] = process.env[k]!;
  }
  const tsx = join(ROOT, "services/backend/node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsx, entry], { env: { ...base, ...allowed }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`  [${name}] ${l.replace(/\bhttps?:\/\/\S+/g, "[url removed]")}`));
  child.stdout!.on("data", prefix);
  child.stderr!.on("data", prefix);
  return child;
}

async function waitHealthy(url: string, what: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start`);
}

/** The platform credential for release, refund and settle (random per run). */
const PLATFORM_TOKEN = randomBytes(24).toString("hex");

async function call(base: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { ...(body ? { "content-type": "application/json" } : {}), "x-platform-token": PLATFORM_TOKEN };
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${json.code ?? ""} ${json.error ?? ""}`);
  return json;
}

async function main() {
  const chain = loadChain(env("CHAIN") || undefined);
  const chainsFile = JSON.parse(readFileSync(join(ROOT, "config/chains.json"), "utf8"));
  const vault: string = chainsFile.chains[chain.key].demoVault;
  if (!vault || !chain.receiptNft) throw new Error(`deploy the vault and ReceiptNFT on "${chain.key}" first`);
  const rpcEnv = Object.fromEntries(Object.entries(fileEnv).filter(([k]) => k.startsWith("RPC_URL_")));
  const provider = newProvider(chain);
  const store = new InMemoryIdempotencyStore();
  const treasury = wallet("TREASURY").connect(provider);
  const operator = wallet("OPERATOR");
  const relay = new EvmChainClient(chain, treasury, store, { provider }); // only relays operator-signed actions here
  // The client and the first payee are WDK wallets (accounts 0 and 1 of the demo seed). The client signs its own
  // escrow approval through WDK; its deposit goes through the backend's wallet-layer API (review, then send).
  const seed = env("DEMO_WALLET_SEED");
  if (!seed) throw new Error("DEMO_WALLET_SEED is not set (run: cd contracts && npm run wallets)");
  const wdk = createWdkWallets({ chain, seed, maxTransfer: 10_000_000_000n });
  const client = { address: await wdk.address("client") };

  // Payee wallets: deterministic test addresses standing in for a USDT wallet and a SIMULATED M-Pesa rail wallet.
  const amara = await wdk.address("payee_amara"); // WDK wallet
  const earnings = await wdk.address("earnings"); // the Tethran earnings account (demo): receives the 5% platform fee
  const kofiRail = new Wallet(keccakUtf8("tethran demo rail wallet mpesa")).address;

  const dir = mkdtempSync(join(tmpdir(), "tethran-slice-"));
  const internalToken = randomBytes(24).toString("hex");
  const policyPort = 18787 + Math.floor(Math.random() * 500);
  const backendPort = policyPort + 1;
  const POLICY = `http://127.0.0.1:${policyPort}`;
  const BACKEND = `http://127.0.0.1:${backendPort}`;
  console.log(`Chain: ${chain.name} (${chain.chainId})  vault ${vault}  data ${dir}`);

  // 1. seed the backend database: provider vault and payees
  const db = openDb(join(dir, "backend.sqlite"));
  const vs = await relay.vaultState(vault);
  db.prepare("INSERT INTO vaults VALUES ('prov-demo', ?, ?, ?, ?)").run(chain.chainId, vault, vs.operator, vs.providerPayout);
  db.prepare("INSERT INTO payees VALUES ('payee_amara', 'prov-demo', 'Amara Studio (demo)', ?, 'usdt', 0, 'Amara Studio')").run(amara);
  db.prepare("INSERT INTO payees VALUES ('payee_kofi', 'prov-demo', 'Kofi Print Works (demo, simulated M-Pesa)', ?, 'mpesa', 1, 'Kofi Print Works')").run(kofiRail);
  db.prepare("INSERT INTO payees VALUES ('tethran_earnings', 'prov-demo', 'Tethran earnings account (demo)', ?, 'usdt', 0, 'Tethran')").run(earnings);
  db.close();
  say("seeded", "provider vault and two payees (one on a simulated M-Pesa rail)");

  // 2. the operator is the provider's own wallet. It signs every change; services only relay.
  const domain = relay.vaultDomain(vault);
  const signPolicyChange = async (doc: Record<string, any>, onChain: { policyVersion: number; perTxCap: string; dailyCap: string; minReserve: string }, addPayees: string[]) => {
    // Vault actions in the vault's own typed-data format, for whatever on-chain values change.
    const actions: Record<string, unknown>[] = [];
    let v = onChain.policyVersion;
    if (onChain.perTxCap !== doc.per_tx_cap || onChain.dailyCap !== doc.daily_cap || onChain.minReserve !== doc.vault_min_reserve) {
      const a = { version: ++v, perTxCap: doc.per_tx_cap, dailyCap: doc.daily_cap, minReserve: doc.vault_min_reserve };
      actions.push({ type: "setPolicy", ...a, operator_signature: await operator.signTypedData(domain, { SetPolicy: [...VAULT_TYPES.SetPolicy] }, a) });
    }
    if (addPayees.length > 0) {
      const a = { version: ++v, payees: addPayees, allowed: true };
      actions.push({ type: "setPayees", ...a, operator_signature: await operator.signTypedData(domain, { SetPayees: [...VAULT_TYPES.SetPayees] }, a) });
    }
    const operator_signature = await operator.signTypedData(policyDomain as never, policyDocumentTypes as never, policyDocumentValue(doc.version, doc as never) as never);
    return { policy: doc, version: doc.version, operator_signature, vault, vault_actions: actions };
  };

  // 3. start the two services, each with only its own key
  const children: ChildProcess[] = [];
  const stop = () => children.forEach((c) => c.kill());
  process.on("exit", stop);
  try {
    children.push(start("policy", join(ROOT, "services/policy/src/main.ts"), {
      ...rpcEnv, CHAIN: chain.key, POLICY_SIGNER_PRIVATE_KEY: env("POLICY_SIGNER_PRIVATE_KEY"), OPERATOR_ADDRESS: operator.address, EARNINGS_ADDRESS: earnings,
      BACKEND_URL: BACKEND, INTERNAL_TOKEN: internalToken, POLICY_DATA_DIR: dir, POLICY_PORT: String(policyPort),
    }));
    const llmEnv = Object.fromEntries(Object.entries(fileEnv).filter(([k]) => /^(LLM_|GROQ_|GEMINI_|NVIDIA_|OPIK_)/.test(k)));
    children.push(start("backend", join(ROOT, "services/backend/src/main.ts"), {
      ...rpcEnv, ...llmEnv, LLM_TIMEOUT_MS: "90000", CHAIN: chain.key, TREASURY_PRIVATE_KEY: env("TREASURY_PRIVATE_KEY"),
      AGENT_SIGNER_PRIVATE_KEY: env("AGENT_SIGNER_PRIVATE_KEY"), ARBITER_ADDRESS: wallet("ARBITER").address,
      POLICY_URL: POLICY, INTERNAL_TOKEN: internalToken, BACKEND_DATA_DIR: dir, BACKEND_PORT: String(backendPort),
      DEMO_MODE: "1", PLATFORM_TOKEN,
      DEMO_WALLET_SEED: seed, AGENT_MODE: env("AGENT_MODE") || "live+replay",
    }));
    await waitHealthy(`${POLICY}/v1/policy`, "Policy Service");
    await waitHealthy(`${BACKEND}/health`, "backend");

    // 4. the operator sets the policy through the Policy Service: off-chain rules signed with the policy typed
    //    data, on-chain limits and payees signed in the vault's format and relayed to the vault
    const current = await call(POLICY, "GET", "/v1/policy");
    const doc = {
      version: current.version + 1, per_tx_cap: usdt(1000), per_tx_soft_limit: usdt(800), daily_cap: usdt(1_000_000),
      vault_min_reserve: "0", payee_allowlist: ["payee_amara", "payee_kofi", "tethran_earnings"], min_tax_reserve_bps: 1000,
      confidence_threshold: 0.7, chargeback_hold_seconds: 600,
    };
    const set = await call(POLICY, "POST", "/v1/policy", await signPolicyChange(doc, await relay.vaultState(vault), [amara, kofiRail, earnings]));
    say("policy service", `policy v${doc.version} accepted: per-tx 1000, tax reserve 10%, soft limit 800`);
    for (const t of set.vault_transactions) say(`  vault ${t.type}`, `v${t.version} relayed on-chain ${t.tx}`);

    // 5. milestone: create, client deposits, backend funds the escrow
    const id = randomUUID();
    await call(BACKEND, "POST", "/milestones", { id, provider_id: "prov-demo", title: "Brand identity pack, final delivery", client_address: client.address, amount_usd_cents: 10_000 });
    const dep = await call(BACKEND, "GET", `/milestones/${id}/deposit`);
    const mint = await relay.mintTestUsdt(client.address, dep.amount, `slice:faucet:${id}`); // test faucet for the client wallet
    await relay.waitConfirmed(mint.txHash);
    const transfer = { to: dep.deposit_address, amount: dep.amount, chain_id: chain.chainId, payment_reference: `deposit:${id}` };
    // The app thinks it is on another network: the review refuses before anything is signed.
    const wrong = await call(BACKEND, "POST", "/wallets/client/transfers/review", { ...transfer, chain_id: 84532 });
    say("wrong network", `review blocked before signing: ${wrong.blocked.map((b: any) => b.code).join(", ")}`);
    const review = await call(BACKEND, "POST", "/wallets/client/transfers/review", transfer);
    say("review screen", `to ${review.recipient.address} on ${review.network.name}: ${review.amount.display}, fee ${review.fee?.display ?? "unavailable"} (separate)${review.can_sign ? "" : " BLOCKED: " + review.blocked.map((b: any) => b.code).join(",")}`);
    const sent = await call(BACKEND, "POST", "/wallets/client/transfers", transfer);
    say("client deposit", `${sent.tx_hash} signed by the WDK client wallet (demo simplification: pay the treasury)`);
    const dup = await fetch(`${BACKEND}/wallets/client/transfers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transfer) });
    say("duplicate send", `refused: ${dup.status} ${(await dup.json()).code}`);
    let st = await call(BACKEND, "GET", `/wallets/transfers/${encodeURIComponent(transfer.payment_reference)}`);
    for (let i = 0; st.status === "pending" && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      st = await call(BACKEND, "GET", `/wallets/transfers/${encodeURIComponent(transfer.payment_reference)}`); // same hash, never resent
    }
    if (st.status !== "confirmed") throw new Error(`deposit is ${st.status}`);
    await relay.waitConfirmed(sent.tx_hash);
    const funded = await call(BACKEND, "POST", `/milestones/${id}/deposit/confirm`, { tx_hash: sent.tx_hash });
    say("escrow funded", `${funded.escrow_tx} (verified on-chain after funding)`);

    // 6. client approves on-chain from its own wallet; provider adds evidence; backend releases
    const appr = await call(BACKEND, "POST", `/wallets/client/escrow/${id}/approve`);
    say("client approved", `${appr.tx_hash} (signed by the WDK client wallet)`);
    const idr = await call(BACKEND, "POST", `/milestones/${id}/identity`, { payer_verified_name: "Demo Client Ltd", customer_verified_name: "Demo Client Ltd" });
    say("identity", `payer and customer verified (${idr.simulated_id_ref}, simulated)`);
    await call(BACKEND, "POST", `/milestones/${id}/evidence`, { text: "All brand files delivered on 12 Nov 2026. The client confirmed receipt by email. Split: 60 to Amara Studio, 30 to Kofi Print Works by M-Pesa." });
    const rel = await call(BACKEND, "POST", `/milestones/${id}/release`);
    say("released", `${rel.release_tx} (identity matched, simulated)`);

    // 7. settlement through the agent, the Policy Service and the vault
    const s = await call(BACKEND, "POST", `/milestones/${id}/settle`, { agent_mode: env("AGENT_MODE") || "live+replay" });
    say("settlement", `${s.decision}${s.reasons?.length ? " " + s.reasons.join(",") : ""}  agent ${s.agent_mode}  trace ${s.trace_id}`);
    if (s.decision !== "approved") {
      if (s.agent_attempts) for (const a of s.agent_attempts) say("  agent attempt", `#${a.attempt} ${a.provider}/${a.model}: ${a.reason}`);
      console.log(`STOPPED: ${s.rejected_by ?? "the Policy Service"} decided ${s.decision}. Nothing was paid. Timeline: GET ${BACKEND}/milestones/${id}/timeline`);
      process.exitCode = 2;
      return;
    }
    for (const p of s.payouts) say(`  payout ${p.action_index}`, `${p.amount} to ${p.payee_id} (${p.rail}${p.simulated ? ", rail simulated" : ""}) ${p.tx}`);
    say("off-chain legs", `${s.offchain?.count ?? 0} started (simulated rails)`);
    const rec = await call(BACKEND, "GET", `/reconciliation/milestones/${id}`);
    say("reconciliation", `complete=${rec.complete} gaps=${(rec.gaps ?? []).map((g: any) => g.code).join(",") || "none"}`);
    const receipt = await call(BACKEND, "GET", `/receipts/${id}`);
    say("receipt", `token #${receipt.tokenId} held by ${receipt.holder} (read from the chain)`);
    // 8. the operator lowers the per-transaction cap; the on-chain guard obeys at once
    // 6 USDT fits the vault balance (the 10 USDT tax reserve stays there), so only the cap can block it
    const before = await relay.vaultCheck(vault, amara, usdt(6));
    const lower = { ...doc, version: doc.version + 1, per_tx_cap: usdt(5), per_tx_soft_limit: usdt(4) };
    const lowered = await call(POLICY, "POST", "/v1/policy", await signPolicyChange(lower, await relay.vaultState(vault), []));
    for (const t of lowered.vault_transactions) say(`  vault ${t.type}`, `v${t.version} relayed on-chain ${t.tx}`);
    // Wait until this script's RPC node has seen the relayed change (public nodes can lag a block or two).
    for (let i = 0; i < 20 && (await relay.vaultState(vault)).perTxCap !== usdt(5); i++) await new Promise((r) => setTimeout(r, 3000));
    const after = await relay.vaultCheck(vault, amara, usdt(6));
    say("limit change", `per-tx cap 1000 -> 5: a 6 USDT payout was ${before.ok ? "allowed" : "blocked (" + before.reason + ")"}, now ${after.ok ? "allowed" : "blocked (" + after.reason + ")"} by the vault`);
    if (!before.ok || after.ok) throw new Error("the vault did not follow the operator's limit change");
    // restore the demo limits for the next run
    await call(POLICY, "POST", "/v1/policy", await signPolicyChange({ ...doc, version: lower.version + 1 }, await relay.vaultState(vault), []));
    say("limit restored", "per-tx cap back to 1000");
    console.log(`PASS: milestone ${id} funded, released, settled through the Policy Service and paid out; receipt minted; the operator's limit change was enforced on-chain. Trace ${s.trace_id}`);
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(`FAILED: ${safeErrorMessage(e)}`);
  process.exit(1);
});
