// Demo helper: plays the people who must sign, for the demo steps that need a human signature (no web app here).
//
//   npm run demo:act -- identity  <milestoneId> release|hold     the vault operator decides an identity hold
//   npm run demo:act -- arbitrate <milestoneId> release|refund   client (WDK wallet) and arbiter sign; escrow decides
//   npm run demo:act -- scenario  <name>                          prints the milestone id of a seeded scenario
//
// The keys are TEST keys from .env and are used here, in the presenter's process, not in the services.
// DEMO_MODE only. Talks to the backend started by the seed (DEMO_BACKEND_PORT, default 18788).
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Wallet } from "ethers";
import { parse } from "dotenv";

const ROOT = resolve(__dirname, "../../..");
const fileEnv = existsSync(join(ROOT, ".env")) ? parse(readFileSync(join(ROOT, ".env"))) : {};
const env = (k: string) => process.env[k] ?? fileEnv[k] ?? "";
const BACKEND = `http://127.0.0.1:${env("DEMO_BACKEND_PORT") || 18788}`;

/** The seeded state's platform credential (for the release after an identity decision). */
function platformToken(): string {
  try { return JSON.parse(readFileSync(join(ROOT, process.env.DEMO_DATA_DIR || ".demo-data", "demo.json"), "utf8")).platform_token ?? ""; } catch { return ""; }
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { ...(body ? { "content-type": "application/json" } : {}), "x-platform-token": platformToken() };
  const r = await fetch(BACKEND + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${json.code ?? ""} ${json.error ?? ""}`);
  return json;
}

function scenarioId(name: string): string {
  const s = JSON.parse(readFileSync(join(ROOT, process.env.DEMO_DATA_DIR || ".demo-data", "seed-summary.json"), "utf8"));
  const hit = s.scenarios.find((x: any) => x.scenario === name);
  if (!hit) throw new Error(`no seeded scenario "${name}" (run the seed first)`);
  return hit.milestone;
}

async function main() {
  if (env("DEMO_MODE") !== "1" && env("DEMO_MODE") !== "true") throw new Error("DEMO_MODE=1 is required");
  const [cmd, a, b] = process.argv.slice(2);
  const id = a && /^[0-9a-f-]{36}$/i.test(a) ? a : a ? scenarioId(a) : "";
  if (cmd === "scenario") return console.log(id);
  if (cmd === "identity") {
    if (b !== "release" && b !== "hold") throw new Error("decision must be release or hold");
    const td = await call("GET", `/operator/identity-holds/${id}/typed-data?decision=${b}`);
    const operator = new Wallet(env("OPERATOR_PRIVATE_KEY"));
    const operator_signature = await operator.signTypedData(td.domain, td.types, td.message);
    console.log(JSON.stringify(await call("POST", `/operator/identity-holds/${id}/decision`, { decision: b, operator_signature }), null, 2));
    if (b === "release") console.log(JSON.stringify(await call("POST", `/milestones/${id}/release`), null, 2));
    return;
  }
  if (cmd === "arbitrate") {
    if (b !== "release" && b !== "refund") throw new Error("outcome must be release or refund");
    const release_to_provider = b === "release";
    const client = await call("POST", `/wallets/client/attestations/${id}`, { kind: "client", release_to_provider }); // WDK client wallet
    console.log(JSON.stringify(await call("POST", `/arbiter/disputes/${id}/attestations`, { signer: client.signer, signature: client.signature, release_to_provider }), null, 2));
    const td = await call("GET", `/arbiter/disputes/${id}/typed-data?kind=arbiter&release_to_provider=${release_to_provider}`);
    const arbiter = new Wallet(env("ARBITER_PRIVATE_KEY"));
    const signature = await arbiter.signTypedData(td.domain, td.types, td.message);
    console.log(JSON.stringify(await call("POST", `/arbiter/disputes/${id}/attestations`, { signer: arbiter.address, signature, release_to_provider }), null, 2));
    return;
  }
  throw new Error("usage: demo:act -- identity|arbitrate|scenario <milestoneId or scenario name> [decision]");
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
