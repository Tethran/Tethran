// Shared guards for the scripts: test networks only, and no secrets in output.
import deny from "../../../config/mainnet-chain-ids.json";

const DENIED: ReadonlySet<number> = new Set(deny.denied);

/** Throws unless the chain is marked as a test network and its ID is not a known mainnet ID. */
export function assertTestNetwork(chainId: number, testnet: unknown, label: string): void {
  if (DENIED.has(chainId)) throw new Error(`${label}: chain id ${chainId} is a mainnet; refusing`);
  if (testnet !== true) throw new Error(`${label} is not marked as a test network; refusing`);
}

/**
 * A short, printable message for any thrown value, with URLs removed.
 * RPC URLs can carry an API key and ethers puts the request URL into its errors,
 * so scripts print this and never the raw error object.
 */
export function safeErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown; code?: unknown };
  const text = typeof err?.shortMessage === "string" ? err.shortMessage
    : typeof err?.message === "string" ? err.message
    : String(e);
  const code = typeof err?.code === "string" ? ` [${err.code}]` : "";
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"',)]+/gi, "[url removed]") + code;
}

/** Use as main().catch(fail). */
export function fail(e: unknown): never {
  console.error(`FAILED: ${safeErrorMessage(e)}`);
  process.exit(1);
}
