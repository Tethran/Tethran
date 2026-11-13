# Deployment plan (not deployed)

Planning only. Nothing here has been deployed. Test networks only (Sepolia); every key is a test key.

## What must run

| Process | Command | Port | Public? |
|---|---|---|---|
| Web app (TanStack Start, Node server) | `cd app && npm run build && node .output/server/index.mjs` | 3000 | yes, at `/` |
| Backend API | `services/backend` `src/main.ts` (tsx) | 18788 | yes, at `/api` |
| Policy Service | `services/policy` `src/main.ts` (tsx) | 18787 | **no** (backend only; own key) |
| Demo signer (DEMO_MODE only) | started by `npm run demo:serve` | 18789 | only if protected (see risks) |

`npm run demo:serve` (in `services/backend`) already starts the Policy Service, the backend, the demo signer and the
app as separate processes with separate keys; on a server it runs under a process manager (systemd) behind a reverse
proxy.

## Persistent storage

One data directory (`BACKEND_DATA_DIR` = `POLICY_DATA_DIR`, today `.demo-data/`) on a persistent disk:
`backend.sqlite` (milestones, invoices, payouts, notifications, emails, wallet top-ups, fx cache and locks),
the Policy Service's `policy.sqlite`, `audit.sqlite`, `decisions.sqlite`, `approvals.sqlite`, the chain idempotency
store, `uploads/` (delivery files, content-addressed), `demo.json` (internal and platform tokens) and `logs/`. Back it
up daily; losing it loses the off-chain records (the chain keeps escrow, payouts and receipts).

## Environment and secrets (names only)

Secrets (in the host's secret store, never in the repo): `TREASURY_PRIVATE_KEY`, `AGENT_SIGNER_PRIVATE_KEY`,
`POLICY_SIGNER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `ARBITER_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY` (the last three only
for the demo signer), `DEMO_WALLET_SEED`, `INTERNAL_TOKEN`, `PLATFORM_TOKEN`, `RPC_URL_11155111` (it carries the RPC
key), `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPIK_API_KEY`, `EMAIL_API_KEY`, `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` (only with real Stripe test keys).

Settings: `CHAIN=sepolia`, `DEMO_MODE=1`, `APP_BASE_URL=https://<domain>`, `CORS_ORIGINS=https://<domain>`,
`EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_DAILY_CAP`, `EMAIL_RECIPIENT_ALLOWLIST`, `INVOICE_RATE_LIMIT_PER_MIN`,
`TRUST_PROXY=1`, `AGENT_MODE`, `OPERATOR_ADDRESS`, `ARBITER_ADDRESS`, `BACKEND_URL`, `POLICY_URL`, data directories and
ports. App build-time: `VITE_TETHRAN_API_URL=https://<domain>/api`, `VITE_TETHRAN_DEMO_SIGNER_URL=https://<domain>/signer`
(or empty to hide demo signing), `VITE_REOWN_PROJECT_ID` (public). `EARNINGS_ADDRESS` is derived by the seed.

## Cheapest fit

One small Linux VM with a persistent disk (2 vCPU, 4 GB RAM, about 4 to 6 USD a month at the smallest tiers of the usual
VM hosts) running all four processes plus Caddy for TLS. SQLite needs a real disk, the processes are long-running and
the chain waits need no sleep: free tiers that sleep or have ephemeral disks do not fit.

## Steps

1. Create the VM; open 80 and 443 only. Install Node 22.13+ and Caddy.
2. Clone the repo; `npm ci` in `contracts`, `services/chain`, `services/policy`, `services/llm`, `services/backend`, `app`.
3. Put the secrets in an env file readable only by the service user (or the host's secret store); never commit it.
4. Build the app with the `VITE_*` values above.
5. Seed once: `DEMO_MODE=1 CHAIN=sepolia npm run seed` (about 40 minutes on Sepolia).
6. systemd unit for `npm run demo:serve` (restart on failure), logs to the data directory.
7. Caddy: `https://<domain>` → `/` to 127.0.0.1:3000; `/api/*` to 127.0.0.1:18788 (strip `/api`); `/signer/*` to
   127.0.0.1:18789 behind basic auth or not at all; the Policy Service is not routed.
8. In the Reown dashboard, allow the domain for the project id. In Resend, verify the sending domain.
9. Check behind the single address: pay links and notification links (APP_BASE_URL), CORS (same origin), the Stripe
   webhook path (`/api/webhooks/stripe`, only with real test keys), x402 resource URLs, file downloads
   (`/api/evidence/files/{id}`), the bell polling, and the wallet connect modal.

## Limits for any non-local deployment

Per-IP limits on invoice creation (`INVOICE_RATE_LIMIT_PER_MIN`), wallet funding (top-ups) and Get test USDT (3 per 10
minutes); the daily email cap (`EMAIL_DAILY_CAP`); email goes to any address entered unless `EMAIL_RECIPIENT_ALLOWLIST`
is set.

## What could go wrong with a public demo signer and a public mint

- **Demo signer:** it signs as the operator, the arbiter and the provider with test keys. Public, anyone could lower or
  raise the vault limits, approve escalations, release identity holds, decide disputes and run the platform's release
  and settle. Only test funds, but it can wreck a live demo and spend the treasury's Sepolia ETH. Keep it off the
  public address (presenter laptop only), or behind basic auth plus an IP allowlist.
- **Mint (wallet top-up and Get test USDT):** each mint is a treasury transaction paid in Sepolia ETH. A script could
  drain the treasury's gas and fill the chain with test tokens. The per-IP limits slow one address, not many; add a
  global daily mint cap and watch the treasury's ETH balance.
- **Email:** invoice creation sends real email to any address entered; without an allowlist it can be used to send
  spam under our domain. The daily cap bounds it; an allowlist removes it.
- **Costs:** live agent mode spends model credits (settlement is platform-only, which bounds it); the RPC key's quota.
