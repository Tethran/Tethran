// Deploys TestUSDT (test token) and MilestoneEscrow with the treasury key, then writes the addresses
// into config/chains.json for the network in use.
//   npx hardhat run scripts/deploy.ts --network localhost | sepolia | baseSepolia
// TEST NETWORKS ONLY.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CHAINS_PATH = path.resolve(__dirname, "../../config/chains.json");
const ROLES = ["TREASURY", "CLIENT", "PROVIDER", "ARBITER", "AGENT_SIGNER", "POLICY_SIGNER", "OPERATOR"];

async function main() {
  const chains = JSON.parse(fs.readFileSync(CHAINS_PATH, "utf8"));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const key = Object.keys(chains.chains).find((k) => chains.chains[k].chainId === chainId);
  if (!key || chains.chains[key].testnet !== true) throw new Error(`chain ${chainId} is not a configured test network`);

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
  const usdt = await (await ethers.getContractFactory("TestUSDT", treasury)).deploy();
  await usdt.waitForDeployment();
  // admin and RELEASER are both the treasury in this demo deployment
  const escrow = await (await ethers.getContractFactory("MilestoneEscrow", treasury)).deploy(
    await usdt.getAddress(), treasury.address, treasury.address);
  await escrow.waitForDeployment();

  chains.chains[key].usdt = await usdt.getAddress();
  chains.chains[key].escrow = await escrow.getAddress();
  fs.writeFileSync(CHAINS_PATH, JSON.stringify(chains, null, 2) + "\n");
  console.log(`TestUSDT (test token): ${chains.chains[key].usdt}`);
  console.log(`MilestoneEscrow:       ${chains.chains[key].escrow}`);
  console.log(`Written to config/chains.json under "${key}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
