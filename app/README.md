# Tethran web app

The interface for Tethran: Vite, React, TypeScript, Tailwind and shadcn/ui on TanStack Start. It has no backend
of its own (no database, auth or server functions) and holds no keys. Every screen reads and writes through
`src/api/index.ts`, which calls the Tethran backend described in `../docs/API.md`.

## Run

```bash
cd app && npm install                              # once
cd services/backend && CHAIN=sepolia npm run demo  # seeds, then serves everything, the app included
```

`npm run demo` starts the app on http://localhost:3000 (the backend's CORS allows this origin) when `app/` is
installed; `DEMO_APP=0` skips it, and `npm run dev` here starts it on its own.

The API base URL defaults to `http://127.0.0.1:18788`, the backend that `npm run demo` starts. To use another one,
set `VITE_TETHRAN_API_URL` in the shell before `npm run dev`. No env file is needed; never commit one.

Production build: `npm run build`, then `npm start` (a Node server in `.output/`).

## Signing

There are two ways to sign each operator, arbiter and provider action:

- **Sign with your wallet** (the real path): the person's own wallet extension signs EIP-712 typed data prepared by
  the backend. Use test keys only.
- **Sign with demo key** (DEMO_MODE only, for the demo video): one click, no wallet switching. The demo signer in
  the presenter's `npm run demo` process signs with that role's TEST key; the backend and the Policy Service never
  hold those keys. Every result is labelled "Demo: signed with a test key", and each page says which button is which.
  The demo signer signs only the message types each role needs and refuses anything else. In demo mode the milestone
  page also offers the platform's own step, **Release and settle**, run by the same process with the platform token
  (the browser never holds it).

In detail:

- The **client's** actions (approve, dispute, deposit, contract signature) are signed by the client's WDK wallet
  through the backend's wallet layer (demo custody of a test seed).
- The **provider's** contract signature, the **operator's** decisions and the **arbiter's** vote are signed in the
  browser by the person's own wallet extension, or in demo mode by the demo signer as above. Without either, the
  app says so; `npm run demo:act` (in `services/backend`) signs those steps from the command line instead.

## Reason codes

`docs/INTERFACES.md` (v0.10) is the source of truth for the Policy Service's codes. `src/api/reasons.ts` explains each
in plain language, including `MILESTONE_ID_MISMATCH`, `ALREADY_SETTLED`, `MILESTONE_NOT_RELEASED`, `NO_PAYOUTS`,
`INJECTION_FLAGGED`, `OVER_MILESTONE_AMOUNT` and `ZERO_AMOUNT_PAYOUT`; a test keeps the list equal to the Policy
Service's own types. A
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

End to end against the live demo (Playwright; videos and screenshots in `e2e-artifacts/`, git-ignored):
`npm run e2e:tour` (every screen at 360, 768 and 1440 px), `npm run e2e:journey` (the whole story) and
`npm run e2e:demo-short` (the short demo video, `e2e-artifacts/recordings/tethran-demo-short.webm`; needs ffmpeg).
They use the app that `npm run demo` serves on port 3000 and the demo services on their default ports.
