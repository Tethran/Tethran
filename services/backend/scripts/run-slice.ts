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
import { EvmChainClient, InMemoryIdempotencyStore, VAULT_TYPES, loadChain, newProvider, safeErrorMessage } from "../../chain/src/index";
import { openDb } from "../src/db";
import { policyDocumentTypes, policyDocumentValue, policyDomain } from "../../policy/src/typed";

const ROOT = resolve(__dirname, "../../..");
const fileEnv = parse(readFileSync(join(ROOT, ".env")));
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

async function call(base: string, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
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
  const client = wallet("CLIENT").connect(provider);
  const operator = wallet("OPERATOR");
  const relay = new EvmChainClient(chain, treasury, store, { provider }); // only relays operator-signed actions here
  const clientChain = new EvmChainClient(chain, client, store, { provider });

  // Payee wallets: deterministic test addresses standing in for a USDT wallet and a SIMULATED M-Pesa rail wallet.
  const amara = new Wallet(keccakUtf8("tethran demo payee amara")).address;
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
  db.close();
  say("seeded", "provider vault and two payees (one on a simulated M-Pesa rail)");

  // 2. operator (the provider's wallet) signs the vault limits and payees; the treasury only relays them
  const domain = relay.vaultDomain(vault);
  let version = vs.policyVersion;
  if (vs.perTxCap !== usdt(1000)) {
    version++;
    const p = { version, perTxCap: usdt(1000), dailyCap: usdt(1_000_000), minReserve: "0" };
    const tx = await relay.setPolicy({ vault, ...p, operatorSig: await operator.signTypedData(domain, { SetPolicy: [...VAULT_TYPES.SetPolicy] }, p) }, `slice:policy:${vault}:${version}`);
    await relay.waitConfirmed(tx.txHash);
    say("vault policy", `per-tx 1000, daily 1,000,000 (operator-signed, v${version})`);
  }
  version++;
  const payees = { version, payees: [amara, kofiRail], allowed: true };
  const ptx = await relay.setPayees({ vault, ...payees, operatorSig: await operator.signTypedData(domain, { SetPayees: [...VAULT_TYPES.SetPayees] }, payees) }, `slice:payees:${vault}:${version}`);
  await relay.waitConfirmed(ptx.txHash);
  say("vault payees", `2 payees allowed (operator-signed, v${version})`);

  // 3. start the two services, each with only its own key
  const children: ChildProcess[] = [];
  const stop = () => children.forEach((c) => c.kill());
  process.on("exit", stop);
  try {
    children.push(start("policy", join(ROOT, "services/policy/src/main.ts"), {
      ...rpcEnv, CHAIN: chain.key, POLICY_SIGNER_PRIVATE_KEY: env("POLICY_SIGNER_PRIVATE_KEY"), OPERATOR_ADDRESS: operator.address,
      BACKEND_URL: BACKEND, INTERNAL_TOKEN: internalToken, POLICY_DATA_DIR: dir, POLICY_PORT: String(policyPort),
    }));
    const llmEnv = Object.fromEntries(Object.entries(fileEnv).filter(([k]) => /^(LLM_|GROQ_|GEMINI_|NVIDIA_|OPIK_)/.test(k)));
    children.push(start("backend", join(ROOT, "services/backend/src/main.ts"), {
      ...rpcEnv, ...llmEnv, LLM_TIMEOUT_MS: "90000", CHAIN: chain.key, TREASURY_PRIVATE_KEY: env("TREASURY_PRIVATE_KEY"),
      AGENT_SIGNER_PRIVATE_KEY: env("AGENT_SIGNER_PRIVATE_KEY"), ARBITER_ADDRESS: wallet("ARBITER").address,
      POLICY_URL: POLICY, INTERNAL_TOKEN: internalToken, BACKEND_DATA_DIR: dir, BACKEND_PORT: String(backendPort),
    }));
    await waitHealthy(`${POLICY}/v1/policy`, "Policy Service");
    await waitHealthy(`${BACKEND}/health`, "backend");

    // 4. the operator signs the Policy Service policy (off-chain rules plus the same caps and payees)
    const current = await call(POLICY, "GET", "/v1/policy");
    const doc = {
      version: current.version + 1, per_tx_cap: usdt(1000), per_tx_soft_limit: usdt(800), daily_cap: usdt(1_000_000),
      vault_min_reserve: "0", payee_allowlist: ["payee_amara", "payee_kofi"], min_tax_reserve_bps: 1000,
      confidence_threshold: 0.7, chargeback_hold_seconds: 600,
    };
    const operator_signature = await operator.signTypedData(policyDomain as never, policyDocumentTypes as never, policyDocumentValue(doc.version, doc as never) as never);
    await call(POLICY, "POST", "/v1/policy", { policy: doc, version: doc.version, operator_signature });
    say("policy service", `policy v${doc.version} accepted (operator-signed): tax reserve 10%, soft limit 800`);

    // 5. milestone: create, client deposits, backend funds the escrow
    const id = randomUUID();
    await call(BACKEND, "POST", "/milestones", { id, provider_id: "prov-demo", title: "Brand identity pack, final delivery", client_address: client.address, amount_usd_cents: 10_000 });
    const dep = await call(BACKEND, "GET", `/milestones/${id}/deposit`);
    const mint = await relay.mintTestUsdt(client.address, dep.amount, `slice:faucet:${id}`); // test faucet for the client wallet
    await relay.waitConfirmed(mint.txHash);
    const pay = await clientChain.transferUsdt(getAddress(dep.deposit_address), dep.amount, `slice:deposit:${id}`);
    await clientChain.waitConfirmed(pay.txHash);
    say("client deposit", `${pay.txHash} (100 tUSDT to the treasury, demo simplification)`);
    const funded = await call(BACKEND, "POST", `/milestones/${id}/deposit/confirm`, { tx_hash: pay.txHash });
    say("escrow funded", `${funded.escrow_tx} (verified on-chain after funding)`);

    // 6. client approves on-chain from its own wallet; provider adds evidence; backend releases
    const appr = await clientChain.approve(id, `slice:approve:${id}`);
    await clientChain.waitConfirmed(appr.txHash);
    say("client approved", appr.txHash);
    await call(BACKEND, "POST", `/milestones/${id}/evidence`, { text: "All brand files delivered on 12 Nov 2026. The client confirmed receipt by email. Split: 60 to Amara Studio, 30 to Kofi Print Works by M-Pesa." });
    const rel = await call(BACKEND, "POST", `/milestones/${id}/release`);
    say("released", `${rel.release_tx} (identity check simulated: match)`);

    // 7. settlement through the agent, the Policy Service and the vault
    const s = await call(BACKEND, "POST", `/milestones/${id}/settle`);
    say("settlement", `${s.decision}${s.reasons?.length ? " " + s.reasons.join(",") : ""}  trace ${s.trace_id}`);
    if (s.decision !== "approved") {
      if (s.agent_attempts) for (const a of s.agent_attempts) say("  agent attempt", `#${a.attempt} ${a.provider}/${a.model}: ${a.reason}`);
      console.log(`STOPPED: ${s.rejected_by ?? "the Policy Service"} decided ${s.decision}. Nothing was paid. Timeline: GET ${BACKEND}/milestones/${id}/timeline`);
      process.exitCode = 2;
      return;
    }
    for (const p of s.payouts) say(`  payout ${p.action_index}`, `${p.amount} to ${p.payee_id} (${p.rail}${p.simulated ? ", rail simulated" : ""}) ${p.tx}`);
    const receipt = await call(BACKEND, "GET", `/receipts/${id}`);
    say("receipt", `token #${receipt.tokenId} held by ${receipt.holder} (read from the chain)`);
    console.log(`PASS: milestone ${id} funded, released, settled through the Policy Service and paid out; receipt minted. Trace ${s.trace_id}`);
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(`FAILED: ${safeErrorMessage(e)}`);
  process.exit(1);
});
