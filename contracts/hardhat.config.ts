import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";
import chainsFile from "../config/chains.json";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Networks come from config/chains.json; nothing chain-specific is hard-coded here.
// TEST NETWORKS ONLY: an entry without "testnet": true is refused.
const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
const networks: NonNullable<HardhatUserConfig["networks"]> = {};
for (const [key, c] of Object.entries(chainsFile.chains)) {
  if (!c.testnet) throw new Error(`chains.json: ${key} is not marked as a test network`);
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
