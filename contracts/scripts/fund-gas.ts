// Tops up test-network gas for the demo party wallets from the treasury.
//   npx hardhat run scripts/fund-gas.ts --network sepolia
// Sends only what is missing up to TARGET, and only to roles that send transactions themselves.
// TEST NETWORKS ONLY.
import { ethers, network } from "hardhat";

const TARGET = ethers.parseEther("0.004");
const ROLES = ["CLIENT", "PROVIDER"];

async function main() {
  const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
  if (!treasuryKey) throw new Error("TREASURY_PRIVATE_KEY is not set");
  const treasury = new ethers.Wallet(treasuryKey, ethers.provider);
  console.log(`${network.name}: treasury ${treasury.address} has ${ethers.formatEther(await ethers.provider.getBalance(treasury.address))} ETH`);

  for (const role of ROLES) {
    const pk = process.env[`${role}_PRIVATE_KEY`];
    if (!pk) throw new Error(`${role}_PRIVATE_KEY is not set`);
    const to = new ethers.Wallet(pk).address;
    const have = await ethers.provider.getBalance(to);
    if (have >= TARGET) { console.log(`${role.padEnd(9)} ${to} already has ${ethers.formatEther(have)} ETH`); continue; }
    const tx = await treasury.sendTransaction({ to, value: TARGET - have });
    await tx.wait();
    console.log(`${role.padEnd(9)} ${to} topped up to ${ethers.formatEther(TARGET)} ETH (${tx.hash})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
