# Tethran web app

The interface for Tethran: Vite, React, TypeScript, Tailwind and shadcn/ui on TanStack Start. It has no backend
of its own (no database, auth or server functions) and holds no keys. Every screen reads and writes through
`src/api/index.ts`, which calls the Tethran backend described in `../docs/API.md`.

## Run

```bash
# 1. the services and the seeded demo (from services/backend)
CHAIN=localhost npm run demo        # or CHAIN=sepolia

# 2. the app, on http://localhost:3000 (the backend's CORS allows this origin)
cd app && npm install && npm run dev
```

The API base URL defaults to `http://127.0.0.1:18788`, the backend that `npm run demo` starts. To use another one,
set `VITE_TETHRAN_API_URL` in the shell before `npm run dev`. No env file is needed; never commit one.

Production build: `npm run build`, then `npm start` (a Node server in `.output/`).

## Signing

- The **client's** actions (approve, dispute, deposit, contract signature) are signed by the client's WDK wallet
  through the backend's wallet layer (demo custody of a test seed).
- The **provider's** contract signature, the **operator's** decisions and the **arbiter's** vote are signed in the
  browser by the person's own wallet extension (EIP-712 typed data prepared by the backend). Use test keys only.
  Without a wallet extension the app says so; `npm run demo:act` (in `services/backend`) signs those steps from the
  command line instead.

## Reason codes

`docs/INTERFACES.md` (v0.8) is the source of truth for the Policy Service's codes. `src/api/reasons.ts` explains each
in plain language, including `NO_PAYOUTS`, `INJECTION_FLAGGED`, `OVER_MILESTONE_AMOUNT` and `ZERO_AMOUNT_PAYOUT`. A
plan that moves no money offers only "Request a new plan" or "Reject".

## What is simulated

Card and wallet checkouts, identity checks, fiat conversion, tax rates and the mobile-money and bank legs are
simulated by the backend and labelled in the screens. Escrow, vault payouts, limits, disputes and receipts are real
on the test network.

## Project rules

- Screens read data only through `src/api/index.ts`.
- 3D objects come from `src/lib/objects.ts` (the renders are in `public/objects/`); screens never reference image
  files directly.
- Landing scroll scenes use sticky stages driven by `useScrollProgress` (GSAP ScrollTrigger), not GSAP pinning, to
  avoid layout conflicts with Lenis.
- Route code splitting is off (see `vite.config.ts`) because the router plugin breaks on folder names with an
  apostrophe.

## Checks

`npm run typecheck`, `npm test`, `npm run build`.
