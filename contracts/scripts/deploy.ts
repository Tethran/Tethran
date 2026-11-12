// Deploys TestUSDT (test token) and MilestoneEscrow with the treasury key, then writes the addresses
// into config/chains.json for the network in use.
//   npx hardhat run scripts/deploy.ts --network localhost | sepolia | baseSepolia
// TEST NETWORKS ONLY.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertTestNetwork, fail } from "./lib/safety";

const CHAINS_PATH = path.resolve(__dirname, "../../config/chains.json");
const ROLES = ["TREASURY", "CLIENT", "PROVIDER", "ARBITER", "AGENT_SIGNER", "POLICY_SIGNER", "OPERATOR"];

async function main() {
  const chains = JSON.parse(fs.readFileSync(CHAINS_PATH, "utf8"));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const key = Object.keys(chains.chains).find((k) => chains.chains[k].chainId === chainId);
  if (network.name === "hardhat") throw new Error("pick a network: --network localhost | sepolia | baseSepolia");
  if (!key) throw new Error(`chain ${chainId} is not in config/chains.json`);
  assertTestNetwork(chainId, chains.chains[key].testnet, `chains.json "${key}"`);

  const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
  if (!treasuryKey) throw new Error("TREASURY_PRIVATE_KEY is not set (run: npm run wallets)");
  const treasury = new ethers.Wallet(treasuryKey, ethers.provider);

  // Local node only: give every role address gas money.
  if (chainId === 31337) {
    for (const role of ROLES) {
      const pk = process.env[`${role}_PRIVATE_KEY`];
      if (pk) await ethers.provider.send("hardhat_setBalance", [new ethers.Wallet(pk).address, "0x21E19E0C9BAB2400000"]);
    }
  }

  console.log(`Deploying to ${network.name} (${chainId}) from treasury ${treasury.address}`);
  // Nonces are set by hand and each deployment is awaited `confirmations` deep: a load-balanced public
  // RPC can report a stale account nonce right after a transaction, which makes the next one collide.
  const confirmations: number = chains.chains[key].confirmations ?? 1;
  const nonce = await ethers.provider.getTransactionCount(treasury.address, "latest");
  const usdt = await (await ethers.getContractFactory("TestUSDT", treasury)).deploy({ nonce });
  await usdt.deploymentTransaction()!.wait(confirmations);
  // Demo deployment: the treasury is admin, RELEASER and FUNDER.
  // Constructor: (usdt, admin, releaser, funder, minTimeout). minTimeout is 1 day unless chains.json sets
  // "minTimeoutSeconds" for this chain (the Sepolia demo uses 10 minutes so a timeout refund can be shown live).
  const minTimeout: number = chains.chains[key].minTimeoutSeconds ?? 24 * 3600;
  const escrow = await (await ethers.getContractFactory("MilestoneEscrow", treasury)).deploy(
    await usdt.getAddress(), treasury.address, treasury.address, treasury.address, minTimeout, { nonce: nonce + 1 });
  await escrow.deploymentTransaction()!.wait(confirmations);

  chains.chains[key].usdt = await usdt.getAddress();
  chains.chains[key].escrow = await escrow.getAddress();
  fs.writeFileSync(CHAINS_PATH, JSON.stringify(chains, null, 2) + "\n");
  console.log(`TestUSDT (test token): ${chains.chains[key].usdt}`);
  console.log(`MilestoneEscrow:       ${chains.chains[key].escrow}  (minTimeout ${minTimeout}s)`);
  console.log(`Written to config/chains.json under "${key}"`);
}

main().catch(fail);
