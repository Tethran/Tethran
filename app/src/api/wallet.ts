// Signing with the user's own browser wallet (an injected EIP-1193 provider such as a browser extension).
// Operator and arbiter decisions must be signed by those parties' keys. The backend never holds them, and neither
// does this app: it only asks the wallet to sign typed data the backend prepared. Test networks and test keys only.
import { ApiError } from "./http";
import { externalWallet } from "@/wallet/external";

interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
type Typed = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType?: string; message: Record<string, unknown> };

function provider(): Eip1193 {
  // The wallet connected through "Connect wallet" first; else an injected browser wallet.
  if (externalWallet.state.connected) {
    if (externalWallet.wrongNetwork()) throw new ApiError("WRONG_NETWORK", "Your wallet is on another network. Switch to Sepolia first.");
    return externalWallet.provider();
  }
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) {
    throw new ApiError("WALLET_REQUIRED",
      "This step needs a signature from your own wallet. Open the app in a browser with a wallet extension (test key), or run the demo helper: npm run demo:act.");
  }
  return eth;
}

const DOMAIN_FIELDS: [string, string][] = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];

/** Signs EIP-712 typed data with the connected account; returns the account and the signature. */
export async function signTyped(typed: Typed): Promise<{ signer: string; signature: string }> {
  const eth = provider();
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const signer = accounts[0];
  if (!signer) throw new ApiError("WALLET_REQUIRED", "No wallet account is connected.");
  const primaryType = typed.primaryType ?? Object.keys(typed.types).find((k) => k !== "EIP712Domain")!;
  const EIP712Domain = DOMAIN_FIELDS.filter(([k]) => typed.domain[k] !== undefined).map(([name, type]) => ({ name, type }));
  const payload = JSON.stringify({ domain: typed.domain, types: { ...typed.types, EIP712Domain }, primaryType, message: typed.message },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  try {
    const signature = (await eth.request({ method: "eth_signTypedData_v4", params: [signer, payload] })) as string;
    return { signer, signature };
  } catch (e) {
    throw new ApiError("SIGNATURE_DECLINED", (e as Error)?.message || "The wallet did not sign.");
  }
}

// ---------- DEMO MODE ONLY: one-click signing with server-side TEST keys ----------
// The demo signer runs in the presenter's process (`npm run demo`), never in the backend. Every action signed this
// way is labelled "Signed with a test key" in the UI. The browser wallet above is the real path.

export type SignRole = "operator" | "arbiter" | "provider";
export type Via = "wallet" | "demo";
export const DEMO_LABEL = "Signed with a test key";

export const DEMO_SIGNER: string =
  (import.meta.env?.["VITE_TETHRAN_DEMO_SIGNER_URL"] as string | undefined) ?? "http://127.0.0.1:18789";

/** The demo signer's roles and addresses, or null when it is not running (then only the wallet path is offered). */
export async function demoSignerInfo(): Promise<{ roles: Record<SignRole, string>; label: string } | null> {
  try {
    const r = await fetch(`${DEMO_SIGNER}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function demoPost<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${DEMO_SIGNER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError("DEMO_SIGNER_DOWN", "The demo signer isn't running. Start the demo with `npm run demo`, or sign with your wallet.");
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError("DEMO_SIGNER", j.error ?? `The demo signer answered ${r.status}.`, r.status);
  return j as T;
}

/** Signs as `role`: with the user's wallet (real) or, in demo mode, with that role's test key. */
export async function signAs(role: SignRole, typed: Typed, via: Via): Promise<{ signer: string; signature: string; demo: boolean }> {
  if (via === "wallet") return { ...(await signTyped(typed)), demo: false };
  const r = await demoPost<{ signer: string; signature: string }>("/sign", { role, typed });
  return { signer: r.signer, signature: r.signature, demo: true };
}

/** DEMO MODE: the platform releases the milestone and runs the settlement (see api.demoSettle). */
export const demoSettle = (milestoneId: string) =>
  demoPost<{ release: unknown; settle: { decision: string; reasons: string[] } }>("/platform/settle", { milestone_id: milestoneId });

/** DEMO MODE: the operator changes the spending limits (base units); relayed to the vault by the Policy Service. */
export const demoSetLimits = (limits: { per_tx_cap: string; per_tx_soft_limit?: string; daily_cap?: string }) =>
  demoPost<{ policy_version: number; vault_policy_version: number; per_tx_cap: string; vault_transactions: { type: string; version: number; tx: string }[] }>("/operator/limits", limits);
