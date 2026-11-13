// Production start for ONE host (Render web service with a persistent disk): `npm run start:render`.
//
//   1. A public gateway on $PORT (0.0.0.0), started first so the host's health check passes at once:
//        /healthz           200 (the host's health check); "ready" says if the services are up
//        /api/*             the backend (127.0.0.1:18788), /api stripped
//        /signer/*          the demo signer (127.0.0.1:18789), /signer stripped; DEMO_MODE only, test keys
//        /unlock?key=…      the presenter's one-time link: with key = SITE_PASSWORD it sets a cookie that opens /signer
//        /lock              removes that cookie
//        everything else    the built web app (127.0.0.1:3000)
//      The site is public. Only /signer (the test-key buttons: operator, arbiter, platform settle) needs the unlock
//      cookie; without it /signer answers 404, which the app reads as "no demo signer" and hides those buttons.
//      Without SITE_PASSWORD, /signer is closed to everyone.
//   2. The services behind it, all on 127.0.0.1 (the Policy Service is never reachable from outside): the first boot
//      (no .demo-data/demo.json on the disk, or RESEED=1) seeds the demo on Sepolia (about 40 minutes) and then serves;
//      later boots serve the seeded state.
// Test networks only (Sepolia); every key is a test key from the host's secret environment, never from the repo.
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT || 10000);
const EXTERNAL = (process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const COOKIE = "tethran_signer";
// The cookie's value is derived from the password (never the password itself): changing SITE_PASSWORD locks every browser.
const UNLOCK_VALUE = SITE_PASSWORD ? createHmac("sha256", SITE_PASSWORD).update("tethran-signer-unlock-v1").digest("hex") : "";
const UPSTREAM = {
  api: Number(process.env.DEMO_BACKEND_PORT || 18788),
  signer: Number(process.env.DEMO_SIGNER_PORT || 18789),
  app: Number(process.env.DEMO_APP_PORT || 3000),
};
let ready = false;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function cookie(req: IncomingMessage, name: string): string {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
/** May this browser use the demo signer? Only after the presenter's unlock link. */
const unlocked = (req: IncomingMessage) => !!UNLOCK_VALUE && same(cookie(req, COOKIE), UNLOCK_VALUE);
const secure = (req: IncomingMessage) => String(req.headers["x-forwarded-proto"] ?? "").startsWith("https");
function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number) {
  res.setHeader("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`);
}
function page(res: ServerResponse, status: number, title: string, text: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#0A1F1B"><h1>${title}</h1><p>${text}</p><p><a href="/app">Open the app</a></p></body>`);
}

function starting(res: ServerResponse) {
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "30" });
  res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>Tethran is starting</title>
<body style="font-family:system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#0A1F1B">
<h1>Tethran is starting</h1><p>The services are coming up. On the first start the demo is seeded on the Sepolia test
network, which can take about 40 minutes. This page refreshes every 30 seconds.</p></body>`);
}

function proxy(req: IncomingMessage, res: ServerResponse, port: number, path: string) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "");
  const upstream = request({
    host: "127.0.0.1", port, method: req.method, path,
    headers: {
      ...req.headers, host: `127.0.0.1:${port}`,
      "x-forwarded-for": [fwd, req.socket.remoteAddress].filter(Boolean).join(", "),
      "x-forwarded-proto": String(req.headers["x-forwarded-proto"] ?? "https"),
      "x-forwarded-host": String(req.headers["x-forwarded-host"] ?? req.headers.host ?? ""),
    },
  }, (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
  // No timeout here: a settlement waits on Sepolia for minutes.
  upstream.on("error", () => { if (!res.headersSent) starting(res); else res.destroy(); });
  req.pipe(upstream);
}

const gateway = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, ready })); return; }
  if (url === "/unlock" || url.startsWith("/unlock?")) {
    const key = new URL(url, "http://x").searchParams.get("key") ?? "";
    if (!UNLOCK_VALUE || !same(key, SITE_PASSWORD)) return page(res, 403, "Not unlocked", "That key is not valid.");
    setCookie(req, res, UNLOCK_VALUE, 30 * 24 * 3600);
    return page(res, 200, "Test-key signing unlocked", "This browser can now use the test-key buttons (operator, arbiter, platform settle) for 30 days. Visitors without this link see the site without them.");
  }
  if (url === "/lock") { setCookie(req, res, "", 0); return page(res, 200, "Locked", "Test-key signing is off in this browser."); }
  if (url === "/api" || url.startsWith("/api/")) return proxy(req, res, UPSTREAM.api, url.slice(4) || "/");
  if (url === "/signer" || url.startsWith("/signer/")) {
    // Hidden from visitors: 404 makes the app treat the demo signer as absent.
    if (!unlocked(req)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    return proxy(req, res, UPSTREAM.signer, url.slice(7) || "/");
  }
  return proxy(req, res, UPSTREAM.app, url);
});
gateway.requestTimeout = 0; // long chain waits
gateway.headersTimeout = 60_000;
gateway.listen(PORT, "0.0.0.0", () => console.log(`gateway listening on 0.0.0.0:${PORT} (public site; test-key signing ${SITE_PASSWORD ? "behind the unlock link" : "closed: set SITE_PASSWORD to enable the unlock link"})`));

// ---- the services behind the gateway ----
const DATA = join(ROOT, process.env.DEMO_DATA_DIR || ".demo-data");
const reseed = process.env.RESEED === "1" || !existsSync(join(DATA, "demo.json"));
const defaults: Record<string, string> = {
  DEMO_MODE: "1",
  CHAIN: "sepolia",
  AGENT_MODE: "live+replay",
  CHAIN_CONFIRM_TIMEOUT_MS: String(25 * 60_000),
  APP_SERVE: "built",
  TRUST_PROXY: "1",
  ...(process.env.JOBS_TOKEN ? { JOBS_IN_PROCESS: "0" } : {}), // the host's cron runs the jobs
  ...(EXTERNAL ? { CORS_ORIGINS: EXTERNAL, APP_BASE_URL: EXTERNAL } : {}),
};
const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const [k, v] of Object.entries(defaults)) if (!childEnv[k]) childEnv[k] = v;
delete childEnv.PORT; // PORT belongs to the gateway; the services use their own local ports

const tsx = join(ROOT, "services/backend/node_modules/tsx/dist/cli.mjs");
console.log(reseed ? "first start: seeding the demo on Sepolia, then serving (about 40 minutes)" : "serving the seeded state");
const child = spawn(process.execPath, [tsx, join(__dirname, "seed.ts"), reseed ? "--serve" : "--serve-only"], { env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (code) => { console.error(`services stopped (exit ${code}); the host restarts the service`); process.exit(code ?? 1); });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { child.kill(sig); setTimeout(() => process.exit(0), 5_000).unref(); });

// Ready when the backend answers.
const poll = setInterval(async () => {
  const ok = await fetch(`http://127.0.0.1:${UPSTREAM.api}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false);
  if (ok && !ready) console.log("services ready");
  ready = ok;
}, 5_000);
poll.unref();
