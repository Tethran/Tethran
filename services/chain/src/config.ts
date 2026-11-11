import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainConfig } from "./types";

const DEFAULT_PATH = resolve(__dirname, "../../../config/chains.json");

/**
 * Loads one chain from config/chains.json. `key` defaults to env CHAIN, then to the file's defaultChain.
 * TEST NETWORKS ONLY: an entry that is not marked `"testnet": true` is refused.
 * The RPC URL can be overridden with env RPC_URL_<chainId> (for a provider URL that carries an API key).
 */
export function loadChain(key?: string, path: string = DEFAULT_PATH): ChainConfig {
  const file = JSON.parse(readFileSync(path, "utf8"));
  const chosen = key ?? process.env.CHAIN ?? file.defaultChain;
  const entry = file.chains?.[chosen];
  if (!entry) throw new Error(`chains.json has no chain "${chosen}"`);
  if (entry.testnet !== true) throw new Error(`chain "${chosen}" is not marked as a test network; refusing`);
  return {
    key: chosen,
    name: entry.name,
    chainId: entry.chainId,
    rpcUrl: process.env[`RPC_URL_${entry.chainId}`] || entry.rpcUrl,
    testnet: true,
    usdt: entry.usdt,
    escrow: entry.escrow,
    receiptNft: entry.receiptNft,
  };
}
