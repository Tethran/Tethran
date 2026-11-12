import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";
import chainsFile from "../config/chains.json";
import { assertTestNetwork } from "./scripts/lib/safety";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Networks come from config/chains.json; nothing chain-specific is hard-coded here.
// TEST NETWORKS ONLY: an entry without "testnet": true, or with a known mainnet chain id, is refused.
// Hardhat itself refuses to run if the RPC reports a different chain id than the one configured here.
const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
const networks: NonNullable<HardhatUserConfig["networks"]> = {};
for (const [key, c] of Object.entries(chainsFile.chains)) {
  assertTestNetwork(c.chainId, c.testnet, `chains.json "${key}"`);
  if (key === "localhost") continue; // built-in
  networks[key] = {
    url: process.env[`RPC_URL_${c.chainId}`] || c.rpcUrl,
    chainId: c.chainId,
    accounts: treasuryKey ? [treasuryKey] : [],
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks,
};

export default config;
