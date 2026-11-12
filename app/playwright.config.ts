// End-to-end run against the LIVE demo (services from `npm run demo`, test networks only).
//   E2E_BASE_URL       the app (default http://localhost:3010, started here if not running)
//   E2E_API_URL        the backend (default http://127.0.0.1:18788)
//   E2E_SIGNER_URL     the demo signer (default http://127.0.0.1:18789)
// Projects: tour-360, tour-768, tour-1440 (every screen: screenshots and video) and journey-1440 (the whole story,
// video). Output: e2e-artifacts/ (git-ignored). This doubles as the backup demo recording.
import { defineConfig } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3010";
const API = process.env.E2E_API_URL ?? "http://127.0.0.1:18788";
const SIGNER = process.env.E2E_SIGNER_URL ?? "http://127.0.0.1:18789";
const port = new URL(BASE).port || "3010";

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e-artifacts/results",
  timeout: 45 * 60_000, // the journey waits for Sepolia transactions
  expect: { timeout: 8 * 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "e2e-artifacts/report", open: "never" }]],
  use: {
    baseURL: BASE,
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
  },
  projects: [
    { name: "tour-360", testMatch: /tour\.spec\.ts/, use: { viewport: { width: 360, height: 780 }, video: { mode: "on", size: { width: 360, height: 780 } } } },
    { name: "tour-768", testMatch: /tour\.spec\.ts/, use: { viewport: { width: 768, height: 1024 }, video: { mode: "on", size: { width: 768, height: 1024 } } } },
    { name: "tour-1440", testMatch: /tour\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, video: { mode: "on", size: { width: 1440, height: 900 } } } },
    { name: "journey-1440", testMatch: /journey\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, video: { mode: "on", size: { width: 1440, height: 900 } } } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js dev --port ${port}`,
    url: BASE,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { VITE_TETHRAN_API_URL: API, VITE_TETHRAN_DEMO_SIGNER_URL: SIGNER },
  },
});
