import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Port 3000 matches the backend's CORS allowlist (CORS_ORIGINS, default http://localhost:3000).
export default defineConfig(({ command }) => ({
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
    ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
    viteReact(),
    tailwindcss(),
  ],
}));
