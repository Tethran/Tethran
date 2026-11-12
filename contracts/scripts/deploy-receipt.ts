// Deploys ReceiptNFT with the treasury as admin and MINTER, and writes its address into config/chains.json.
//   npx hardhat run scripts/deploy-receipt.ts --network localhost | sepolia | baseSepolia
// TEST NETWORKS ONLY.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertTestNetwork, fail } from "./lib/safety";

const CHAINS_PATH = path.resolve(__dirname, "../../config/chains.json");

async function main() {
  const chains = JSON.parse(fs.readFileSync(CHAINS_PATH, "utf8"));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const key = Object.keys(chains.chains).find((k) => chains.chains[k].chainId === chainId);
  if (network.name === "hardhat") throw new Error("pick a network: --network localhost | sepolia | baseSepolia");
  if (!key) throw new Error(`chain ${chainId} is not in config/chains.json`);
  assertTestNetwork(chainId, chains.chains[key].testnet, `chains.json "${key}"`);

  const treasury = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY ?? "", ethers.provider);
  const confirmations: number = chains.chains[key].confirmations ?? 1;
  const nonce = await ethers.provider.getTransactionCount(treasury.address, "latest");
  // Demo deployment: the treasury is admin and MINTER (it mints after the vault payout is confirmed).
  const nft = await (await ethers.getContractFactory("ReceiptNFT", treasury)).deploy(treasury.address, treasury.address, { nonce });
  await nft.deploymentTransaction()!.wait(confirmations);

  chains.chains[key].receiptNft = await nft.getAddress();
  fs.writeFileSync(CHAINS_PATH, JSON.stringify(chains, null, 2) + "\n");
  console.log(`ReceiptNFT: ${chains.chains[key].receiptNft}  (admin and MINTER: treasury ${treasury.address})`);
}

main().catch(fail);
