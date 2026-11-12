// Generates throwaway TEST keys for every role and writes them to ../.env (git-ignored).
// Never prints a private key. Never changes or removes an existing line: a role whose variable is
// already present is kept as it is, and if its value is not a usable key the script stops.
// TEST NETWORKS ONLY.
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ROLES = [
  "TREASURY", "CLIENT", "PROVIDER", "ARBITER", "AGENT_SIGNER", "POLICY_SIGNER", "OPERATOR",
];
const KEY = /^0x[0-9a-fA-F]{64}$/;
// TETHRAN_ENV_FILE lets a test point the script at a scratch file instead of the real .env.
const envPath = process.env.TETHRAN_ENV_FILE ?? path.resolve(__dirname, "../../.env");

/** Value of NAME=value in the file text, or undefined when there is no such line. */
function existingValue(env: string, name: string): string | undefined {
  for (const line of env.split(/\r?\n/)) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
  }
  return undefined;
}

function main() {
  const exists = fs.existsSync(envPath);
  const env = exists ? fs.readFileSync(envPath, "utf8") : "";

  const report: string[] = [];
  let added = "";
  for (const role of ROLES) {
    const name = `${role}_PRIVATE_KEY`;
    const value = existingValue(env, name);
    let wallet: Wallet;
    if (value === undefined) {
      wallet = new Wallet(Wallet.createRandom().privateKey);
      added += `${name}=${wallet.privateKey}\n`;
    } else if (KEY.test(value)) {
      wallet = new Wallet(value);
    } else {
      // Do not guess and do not overwrite: this may be a funded key with a typo around it.
      throw new Error(`${name} is present in .env but is not a 0x-prefixed 32-byte hex key. Fix or remove that line by hand.`);
    }
    report.push(`${role.padEnd(14)} ${wallet.address}${value === undefined ? "  (new)" : ""}`);
  }

  if (added) {
    // Append only. Start on a fresh line if the file does not end with one.
    const lead = !exists ? "CHAIN=sepolia\n" : env.length > 0 && !env.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(envPath, lead + added);
  }
  console.log(report.join("\n"));
}

main();
