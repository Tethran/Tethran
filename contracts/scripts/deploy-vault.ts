// Deploys one ProviderVault for the DEMO provider and writes its address into config/chains.json as "demoVault".
//   npx hardhat run scripts/deploy-vault.ts --network localhost | sepolia | baseSepolia
// In the product each provider gets a vault from the seed script and the address lives in the `vaults` table;
// this script covers the single demo provider.
//   operator        = OPERATOR key        (stands in for the provider's or agency admin's own wallet)
//   agentSigner     = AGENT_SIGNER key    (the agent signer module)
//   policySigner    = POLICY_SIGNER key   (the Policy Service)
//   providerPayout  = PROVIDER address    (the only address the escape withdrawal can pay)
// Only addresses are used here; the treasury key pays for the deployment. TEST NETWORKS ONLY.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertTestNetwork, fail } from "./lib/safety";

const CHAINS_PATH = path.resolve(__dirname, "../../config/chains.json");

function addressOf(role: string): string {
  const pk = process.env[`${role}_PRIVATE_KEY`];
  if (!pk) throw new Error(`${role}_PRIVATE_KEY is not set (run: npm run wallets)`);
  return new ethers.Wallet(pk).address;
}

async function main() {
  const chains = JSON.parse(fs.readFileSync(CHAINS_PATH, "utf8"));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const key = Object.keys(chains.chains).find((k) => chains.chains[k].chainId === chainId);
  if (network.name === "hardhat") throw new Error("pick a network: --network localhost | sepolia | baseSepolia");
  if (!key) throw new Error(`chain ${chainId} is not in config/chains.json`);
  assertTestNetwork(chainId, chains.chains[key].testnet, `chains.json "${key}"`);
  const usdt: string = chains.chains[key].usdt;
  if (!usdt) throw new Error(`no usdt address for "${key}" yet: run scripts/deploy.ts first`);

  const treasury = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY ?? "", ethers.provider);
  const confirmations: number = chains.chains[key].confirmations ?? 1;
  const args = [usdt, addressOf("OPERATOR"), addressOf("AGENT_SIGNER"), addressOf("POLICY_SIGNER"), addressOf("PROVIDER")] as const;

  console.log(`Deploying the demo ProviderVault to ${network.name} (${chainId})`);
  const nonce = await ethers.provider.getTransactionCount(treasury.address, "latest");
  const vault = await (await ethers.getContractFactory("ProviderVault", treasury)).deploy(...args, { nonce });
  await vault.deploymentTransaction()!.wait(confirmations);

  chains.chains[key].demoVault = await vault.getAddress();
  fs.writeFileSync(CHAINS_PATH, JSON.stringify(chains, null, 2) + "\n");
  console.log(`ProviderVault (demo provider): ${chains.chains[key].demoVault}`);
  console.log(`  operator ${args[1]}\n  agentSigner ${args[2]}\n  policySigner ${args[3]}\n  providerPayout ${args[4]}`);
}

main().catch(fail);
