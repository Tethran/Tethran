import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

/**
 * Copies ONLY the named variables from a .env file into process.env (variables already set win).
 * Each service lists exactly the credentials it may hold, so the Policy Service never receives the treasury
 * key and the backend never receives the Policy Service key, even though the demo keeps them in one file.
 * A name ending in "*" matches a prefix, e.g. "RPC_URL_*".
 */
export function loadEnvOnly(path: string, names: string[]): void {
  if (!existsSync(path)) return;
  const all = parse(readFileSync(path));
  for (const [k, v] of Object.entries(all)) {
    const allowed = names.some((n) => (n.endsWith("*") ? k.startsWith(n.slice(0, -1)) : k === n));
    if (allowed && process.env[k] === undefined) process.env[k] = v;
  }
}
