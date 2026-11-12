// Signing with the user's own browser wallet (an injected EIP-1193 provider such as a browser extension).
// Operator and arbiter decisions must be signed by those parties' keys. The backend never holds them, and neither
// does this app: it only asks the wallet to sign typed data the backend prepared. Test networks and test keys only.
import { ApiError } from "./http";

interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
type Typed = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType?: string; message: Record<string, unknown> };

function provider(): Eip1193 {
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
