import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Port 3000 matches the backend's CORS allowlist (CORS_ORIGINS, default http://localhost:3000).
export default defineConfig(({ command }) => ({
  // Read VITE_* settings (VITE_REOWN_PROJECT_ID, a public id) from the repo-root .env; Vite exposes only VITE_* names.
  envDir: "..",
  // The wallet library runs only in the browser (loaded on the first Connect click); keep it out of server bundles.
  ssr: { external: ["@reown/appkit", "@reown/appkit-adapter-ethers", "@coinbase/cdp-sdk", "@walletconnect/universal-provider"] },
  // Playwright writes videos into e2e-artifacts/ while the dev server runs: not watched.
  server: { port: 3000, strictPort: true, host: "localhost", watch: { ignored: ["**/e2e-artifacts/**"] } },
  preview: { port: 3000, strictPort: true, host: "localhost" },
  plugins: [
    tsConfigPaths(),
    // Route code splitting is off (no split groups): the router plugin writes absolute file paths into generated
    // import() strings without escaping them, which breaks when a folder name contains an apostrophe. Splitting only
    // affects load time.
    tanstackStart({ router: { codeSplittingOptions: { defaultBehavior: [] } } }),
    // Build only: a plain Node server in .output/ (run with `node .output/server/index.mjs`).
    // The wallet library is browser-only (dynamic import on the first Connect click): never bundled into the server.
    ...(command === "build" ? [nitro({ preset: "node-server", rollupConfig: { external: [/^@reown\//, /^@coinbase\//, /^@walletconnect\//, /^@x402\//] } } as never)] : []),
    viteReact(),
    tailwindcss(),
  ],
}));
