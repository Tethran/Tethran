// External (connected) wallets, v0.12: the transactions such a wallet sends itself, built here so the web app needs no
// contract code, and "Get test USDT" for a connected address.
//
//   GET  /milestones/{id}/calls/deposit   { chain_id, to: token, data: transfer(treasury, amount), recipient, amount }
//   GET  /milestones/{id}/calls/approve   { chain_id, to: escrow, data: approve(milestoneId) }
//   POST /wallets/external/mint           { address } -> 100 test USDT minted by the treasury (DEMO_MODE only)
//
// The deposit still has to come from the milestone's client address (confirmDeposit checks it), so a connected wallet
// pays only a milestone whose contract names it as the client. Test networks only. The mint is a public faucet in
// effect: DEMO_MODE only, a fixed 100 test USDT per request, and a per-IP limit (3 per 10 minutes).
import type { IncomingMessage } from "node:http";
import { Interface, getAddress, isAddress } from "ethers";
import { milestoneIdToBytes32 } from "../../chain/src/index";
import { ApiError } from "./errors";

const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
const ESCROW = new Interface(["function approve(bytes32 milestoneId)"]);
export const EXTERNAL_MINT_BASE_UNITS = 100_000_000n; // 100 test USDT
const MINT_WINDOW_MS = 10 * 60 * 1000;
const MINT_PER_WINDOW = 3;

export function depositCall(d: { chain_id: number; token: string; deposit_address: string; amount: string; from: string }) {
  return {
    chain_id: d.chain_id, to: getAddress(d.token), value: "0x0",
    data: ERC20.encodeFunctionData("transfer", [getAddress(d.deposit_address), BigInt(d.amount)]),
    recipient: { address: getAddress(d.deposit_address), name: "Tethran treasury (escrow deposit)" },
    amount: d.amount, from: getAddress(d.from), token_symbol: "tUSDT (test token)",
  };
}

export function approveCall(chainId: number, escrow: string, milestoneId: string) {
  return { chain_id: chainId, to: getAddress(escrow), value: "0x0", data: ESCROW.encodeFunctionData("approve", [milestoneIdToBytes32(milestoneId)]) };
}

/** A per-IP limit: at most `max` calls per `windowMs` from one address; throws 429. */
export function createIpLimiter(opts: { max: number; windowMs: number; now: () => Date; trustProxy?: boolean; what: string }) {
  const hits = new Map<string, number[]>();
  return (req: IncomingMessage) => {
    const fwd = opts.trustProxy ? String(req.headers?.["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const ip = fwd || req.socket?.remoteAddress || "unknown";
    const now = opts.now().getTime();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < opts.windowMs);
    if (recent.length >= opts.max) throw new ApiError(429, `too many ${opts.what} from this address; try again later`, "RATE_LIMITED");
    hits.set(ip, [...recent, now]);
  };
}

export function createExternalMint(deps: { mint?: (to: string, amount: string, key: string) => Promise<{ txHash: string }>; waitConfirmed?: (h: string) => Promise<void>; now: () => Date; trustProxy?: boolean }) {
  const hits = new Map<string, number[]>();
  return async (req: IncomingMessage, body: { address?: unknown }) => {
    if (!deps.mint) throw new ApiError(403, "Get test USDT is available only in DEMO_MODE", "DEMO_ONLY");
    if (typeof body?.address !== "string" || !isAddress(body.address)) throw new ApiError(400, "address must be an address", "BAD_ADDRESS");
    const fwd = deps.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const ip = fwd || req.socket?.remoteAddress || "unknown";
    const now = deps.now().getTime();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < MINT_WINDOW_MS);
    if (recent.length >= MINT_PER_WINDOW) throw new ApiError(429, "too many test USDT requests from this address; try again in 10 minutes", "RATE_LIMITED");
    hits.set(ip, [...recent, now]);
    const to = getAddress(body.address);
    const tx = await deps.mint(to, EXTERNAL_MINT_BASE_UNITS.toString(), `external-mint:${to}:${now}`);
    if (deps.waitConfirmed) await deps.waitConfirmed(tx.txHash);
    return { to, amount: EXTERNAL_MINT_BASE_UNITS.toString(), display: "100 tUSDT (test token)", tx_hash: tx.txHash, note: "Test USDT on Sepolia. You also need Sepolia ETH for gas to send it." };
  };
}
