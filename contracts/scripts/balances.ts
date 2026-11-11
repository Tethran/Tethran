// Prints the native (gas) balance of every role address on each configured test network.
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";
import chainsFile from "../../config/chains.json";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
const ROLES = ["TREASURY", "CLIENT", "PROVIDER", "ARBITER", "AGENT_SIGNER", "POLICY_SIGNER", "OPERATOR"];

async function main() {
  for (const [key, c] of Object.entries(chainsFile.chains)) {
    if (key === "localhost") continue;
    const provider = new JsonRpcProvider(process.env[`RPC_URL_${c.chainId}`] || c.rpcUrl, c.chainId);
    console.log(`\n${c.name} (${c.chainId})`);
    for (const role of ROLES) {
      const pk = process.env[`${role}_PRIVATE_KEY`];
      if (!pk) { console.log(`  ${role.padEnd(14)} (no key)`); continue; }
      const addr = new Wallet(pk).address;
      console.log(`  ${role.padEnd(14)} ${addr}  ${formatEther(await provider.getBalance(addr))} ETH`);
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
