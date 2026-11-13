// One command for a manual screen recording: `npm run record` (in services/backend).
// Starts the Policy Service, the backend (with the Settlement Agent), the demo signer and the web app on the EXISTING
// seeded state (no reseed), waits until each answers its health check, prints the URLs and keeps running (Ctrl+C
// stops everything). Same as `npm run demo:serve` with the recording defaults below; any of them can be overridden by
// setting the variable first. Test network only (Sepolia); every key is a test key from the git-ignored .env.
const defaults: Record<string, string> = {
  DEMO_MODE: "1",
  CHAIN: "sepolia",
  AGENT_MODE: "live+replay", // the live model, with the labelled replay answer if it fails
  CHAIN_CONFIRM_TIMEOUT_MS: String(25 * 60_000), // a slow Sepolia: poll one transaction for up to 25 minutes
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
if (!process.argv.includes("--serve-only")) process.argv.push("--serve-only");
console.log(`Recording mode: ${Object.keys(defaults).map((k) => `${k}=${process.env[k]}`).join(", ")}`);
void import("./seed.js");
