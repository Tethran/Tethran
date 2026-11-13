# Tethran demo

Everything runs on a test network (Sepolia) with test keys and our own test token, TestUSDT. Anything simulated
says so on screen and in the API response (`simulated`, `Simulated`, `SIMULATED`).

## 0. Start (one command)

Once, from the repo root: `cd contracts && npm install && npm run wallets` (throwaway TEST keys into `.env`,
git-ignored), then `npm install` in `services/chain`, `services/policy`, `services/llm`, `services/backend` and `app`.

```bash
cd services/backend && CHAIN=sepolia npm run demo
```

This wipes `.demo-data/` (that directory only), starts the Policy Service and the backend as separate processes
with separate keys, seeds the nine scenarios through the real API (about 40 minutes on Sepolia: each funded
scenario waits for several transactions), then keeps everything running:

| What | Where |
|---|---|
| Web app | http://localhost:3000 |
| Backend API | http://127.0.0.1:18788 |
| Policy Service | http://127.0.0.1:18787 |
| Demo signer (DEMO_MODE only, test keys) | http://127.0.0.1:18789 |

Ports: `DEMO_BACKEND_PORT`, `DEMO_POLICY_PORT`, `DEMO_SIGNER_PORT`, `DEMO_APP_PORT`. `DEMO_APP=0` does not start the
app. Logs: `.demo-data/logs/`. Every milestone id: `.demo-data/seed-summary.json`.

Restart on the seeded state without reseeding: `DEMO_MODE=1 CHAIN=sepolia npm run demo:serve`. Rerun only the
scenarios that failed (a public RPC can time out): `DEMO_MODE=1 CHAIN=sepolia npm run seed -- --retry-failed`.
On the local chain (`CHAIN=localhost npm run demo`) the seed starts `hardhat node` and deploys itself; blocks are
instant.

Checks before going on stage: the summary says `0 problems`; the app opens; the Operator page shows the limits.

## 1. Signing in the demo

Each operator, arbiter and provider action has two buttons:

- **Sign with demo key** (flask icon, DEMO_MODE only): one click. The demo signer, inside the presenter's
  `npm run demo` process, signs with that role's TEST key and the result is labelled "Demo: signed with a test
  key". The backend and the Policy Service never hold those keys. It signs only the message types each role needs.
- **Sign with your wallet**: the real path. The person's own wallet extension signs the same EIP-712 message.

The client signs with its WDK wallet through the backend (demo custody of one test seed). The platform's own step
after the client approves (release the escrow to the vault, then settle) is the **Release and settle** button on
the milestone page in demo mode; it runs in the same presenter process with the platform token.

## 2. The story (web app)

1. **Freelancer: a contract.** Home → **Create contract**: one milestone, Continue three times, tick the box, **Sign and
   send** (demo key). The invoice opens.
2. **Client: adds funds and pays.** Wallet → Kofi Mensah Ltd → **Add $500 by card**: a simulated card top-up; the
   treasury mints the same amount of test USDT to the client's Tethran demo wallet (1 USD = 1 test USDT). Then open
   the invoice's pay link and choose **Tethran wallet**: the page shows the wallet's balance (or says it is not enough
   and links to Add funds); it pays test USDT from the wallet after a review (network, recipient, amount, fee) and
   the treasury funds the escrow on-chain. **Card** (and Apple Pay,
   Google Pay, PayPal, Cash App) is a simulated checkout: signed Stripe-format events through the real webhook
   handler. Card payments wait out a chargeback hold (10 minutes in the demo) before release.
3. **Freelancer: submits delivery** on the milestone page: a note, a link and files (up to 5, 10 MB each). The AI's
   **delivery check** appears: each acceptance criterion met, unmet or unclear, with a reason, labelled **Live model** or
   **Replay**. It is advisory; the client sees it before approving.
   **Client: approves** on the milestone page (**Approve work**), signed by the client's WDK wallet on-chain.
   (One person can be both: on a new contract, **Client pays from → My own Tethran wallet** makes the freelancer's
   wallet, where payouts arrive, the client that pays and approves.)
4. **Platform: Release and settle.** The escrow releases to the provider's vault; the Settlement Agent proposes
   a split; the Policy Service decides with reason codes and co-signs; the agent signer adds the second signature;
   the vault pays inside its on-chain limits; a soulbound receipt NFT is minted. The milestone page shows the
   agent's plan, the Policy decision and the vault payouts.
   The plan has a fixed fee line: Tethran's **5% platform fee** to the Tethran earnings account (demo), computed by
   code and enforced by the Policy Service (`FEE_MISMATCH` otherwise). The freelancer receives gross - fee - tax reserve.
   **Earnings** (operator) shows the total collected, each fee line and the demo earnings account balance.
5. **Receipt.** **View the receipt** (it shows the platform fee), then **Verify**: the page checks the receipt against the chain.
6. **Operator: a limit the chain obeys.** Operator → Limits: set the per-payment limit to 5 and **Change limit**.
   The operator's signatures go to the Policy Service, which relays the vault update on-chain. **Ask the vault**
   with 6: the vault contract's own `check` (the rule `execute` applies) refuses it, `OVER_PER_TX_CAP`. Set it back
   to 1000.
7. **Handled failures.** Send (`/app/send`): the wallet is on the wrong network, so sending is blocked before signing. Switch,
   send once, then **Send again**: refused, the same payment is never sent twice.
8. **Humans decide.** Operator → Needs your decision: the escalated plans with their reasons in plain language.
   A plan that pays nobody offers only **Request a new plan** or **Reject**. Identity holds: **Release** (demo
   key). Arbiter: vote on the dispute; the client votes from the milestone page; two of three decide on-chain.
9. **Ledger.** Every invoice joined to payment, escrow, payout and receipt; CSV tax export.

The recorded versions: `cd app && npm run e2e:demo-short` (the short video, `app/e2e-artifacts/recordings/
tethran-demo-short.webm`, waits sped up) and `npm run e2e:journey` (the whole journey, about 15 minutes on Sepolia).

## 3. The seeded scenarios

Twelve scenarios: the nine below and three for the delivery check (v0.12): `criteria_met` (every criterion met: paid),
`criteria_unmet` (twelve photos delivered, twenty agreed: escalated `CRITERIA_UNMET`) and `criteria_silent` (the
evidence does not mention the criteria: escalated `CRITERIA_UNCLEAR`). Live mode: `AGENT_MODE=live npm run demo`.

What the seed produced on Sepolia in the last clean run (`0 problems`; agent mode replay):

| Scenario | Result |
|---|---|
| clean_delivery | Funded, approved, released; the Policy Service approved; one payout from the vault; receipt NFT minted |
| disputed_delivery | The client disputed on-chain; waits in the arbiter queue for a 2-of-3 decision |
| prompt_injection | Escalated: `INJECTION_FLAGGED`, `NEEDS_HUMAN`, `LOW_CONFIDENCE`; nothing paid |
| over_limit_request | Escalated: `NEEDS_HUMAN` (the agent asked for a person instead of paying above the cap; a plan paying it is `OVER_PER_TX_CAP`) |
| unknown_payee | Escalated: `INJECTION_FLAGGED`, `NEEDS_HUMAN`, `LOW_CONFIDENCE`; the unlisted payee is never paid |
| low_confidence_plan | Escalated: `LOW_CONFIDENCE`, `NEEDS_HUMAN` |
| duplicate_send | Handled failure: the second identical deposit send is refused (`DUPLICATE_PENDING`); the settlement escalated, and a second settle paid nothing new |
| wrong_network | Blocked before signing: the review for Base Sepolia is refused (`WRONG_NETWORK`); nothing sent |
| identity_mismatch | Release held (`IDENTITY_MISMATCH`): payer "Bola Trading Co" and customer "Kofi Mensah Ltd" differ (simulated identity check); in the operator queue until the operator releases or refunds |

Reconciliation after the seed: nine milestones in the ledger, one complete (clean_delivery; the others are waiting
on a person, by design).

## 4. The same from the command line

From `services/backend`, with `B=http://127.0.0.1:18788`:

- `M=$(npm run -s demo:act -- scenario clean_delivery)`; `curl -s $B/milestones/$M/timeline` (plans, decisions,
  payouts, receipt); `curl -s $B/receipts/$M` (read from the chain); `curl -s $B/reconciliation/milestones/$M`.
- `npm run demo:act -- identity identity_mismatch release` (operator key, then release).
- `npm run demo:act -- arbitrate disputed_delivery release` (client WDK wallet and arbiter sign; the escrow decides).
- `CHAIN=sepolia npm run slice`: one milestone through the real services, ending with the operator's limit change
  and the vault refusing a payout above it.
- x402: `curl -s $B/x402`; `curl -i "$B/x402/fx-quote?to=KES"` answers `402 Payment Required` (exact scheme,
  TestUSDT).

## 5. Real and simulated

Real on the test network: escrow funding, approval, disputes and 2-of-3 decisions, release, vault payouts with
on-chain limits, the operator's limit change, receipt NFTs, x402 payment settlement, every WDK-signed user
transaction. Real off-chain: the Policy Service decisions and co-signatures, the agent's model calls in live mode,
Opik traces, reconciliation.

Simulated, and labelled: the token is our TestUSDT, not Tether USDT; card and wallet checkouts; fiat conversion and
FX rates; identity verification; the off-chain legs of mobile money and bank payouts; tax rates (placeholders);
x402 data content; custody (one demo test seed holds all user wallets); the demo signer (test keys in the
presenter's process, DEMO_MODE only). The agent mode defaults to `replay` in the seed: saved proposals, eight of
them real model outputs from the evaluation run (each names its Opik trace) and one curated, all labelled
"Replay"; `AGENT_MODE=live+replay` calls the model and falls back to replay.

## Fallback plan

| If this fails | Do this |
|---|---|
| The model API is down or rate-limited | The seed's default `AGENT_MODE=replay` needs no model; everything after the agent is unchanged. |
| Sepolia RPC is slow | The API-key RPC (`RPC_URL_11155111`) is primary and the public RPC the fallback, for the services and the WDK wallets. |
| Sepolia is down | `CHAIN=localhost npm run demo`: same flow, instant blocks. |
| Sepolia gas runs out | `cd contracts && npm run balances`; top up the treasury from a faucet; `npx hardhat run scripts/fund-gas.ts --network sepolia`. |
| Opik is down | Unset `OPIK_API_KEY` for the run (tracing becomes a no-op); show the milestone page instead of the trace. |
| A seed step fails | `npm run seed -- --retry-failed` reruns only the failed scenarios. |
| The live demo fails on stage | Play `app/e2e-artifacts/recordings/tethran-demo-short.webm`. |
