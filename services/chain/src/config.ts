import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainConfig } from "./types";

const DEFAULT_PATH = resolve(__dirname, "../../../config/chains.json");
const DENY_PATH = resolve(__dirname, "../../../config/mainnet-chain-ids.json");

/** Chain IDs that are refused whatever chains.json says (config/mainnet-chain-ids.json). */
export const DENIED_CHAIN_IDS: ReadonlySet<number> = new Set(
  JSON.parse(readFileSync(DENY_PATH, "utf8")).denied as number[],
);

/** Throws unless the chain is marked as a test network and its ID is not a known mainnet ID. */
export function assertTestNetwork(chainId: number, testnet: unknown, label: string): void {
  if (DENIED_CHAIN_IDS.has(chainId)) throw new Error(`${label}: chain id ${chainId} is a mainnet; refusing`);
  if (testnet !== true) throw new Error(`${label} is not marked as a test network; refusing`);
}

/**
 * Loads one chain from config/chains.json. `key` defaults to env CHAIN, then to the file's defaultChain.
 * TEST NETWORKS ONLY: see assertTestNetwork.
 * The RPC URL can be overridden with env RPC_URL_<chainId> (for a provider URL that carries an API key, such as
 * Alchemy). That override is then the primary RPC and the file's public rpcUrl becomes the read-only fallback.
 * The client checks the chain id the RPC actually reports against this config before it does anything.
 */
export function loadChain(key?: string, path: string = DEFAULT_PATH): ChainConfig {
  const file = JSON.parse(readFileSync(path, "utf8"));
  const chosen = key ?? process.env.CHAIN ?? file.defaultChain;
  const entry = file.chains?.[chosen];
  if (!entry) throw new Error(`chains.json has no chain "${chosen}"`);
  assertTestNetwork(entry.chainId, entry.testnet, `chain "${chosen}"`);
  return {
    key: chosen,
    name: entry.name,
    chainId: entry.chainId,
    rpcUrl: process.env[`RPC_URL_${entry.chainId}`] || entry.rpcUrl,
    ...(process.env[`RPC_URL_${entry.chainId}`] && entry.rpcUrl ? { fallbackRpcUrl: entry.rpcUrl } : {}),
    testnet: true,
    confirmations: entry.confirmations ?? 1,
    usdt: entry.usdt,
    escrow: entry.escrow,
    receiptNft: entry.receiptNft,
  };
}
