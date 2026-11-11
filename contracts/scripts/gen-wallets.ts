// Generates throwaway TEST keys for every role and writes them to ../.env (git-ignored).
// Never prints a private key. Refuses to overwrite a key that is already set.
// TEST NETWORKS ONLY.
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ROLES = [
  "TREASURY", "CLIENT", "PROVIDER", "ARBITER", "AGENT_SIGNER", "POLICY_SIGNER", "OPERATOR",
];
const envPath = path.resolve(__dirname, "../../.env");

function main() {
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "CHAIN=sepolia\n";
  for (const role of ROLES) {
    const name = `${role}_PRIVATE_KEY`;
    const match = env.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})\s*$`, "m"));
    let wallet: Wallet;
    if (match) {
      wallet = new Wallet(match[1]);
    } else {
      wallet = new Wallet(Wallet.createRandom().privateKey);
      env = env.replace(new RegExp(`^${name}=.*\r?\n`, "m"), "");
      env += `${name}=${wallet.privateKey}\n`;
    }
    console.log(`${role.padEnd(14)} ${wallet.address}${match ? "" : "  (new)"}`);
  }
  fs.writeFileSync(envPath, env, { mode: 0o600 });
}

main();
