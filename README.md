# Tethran

Enforceable, traceable, deliverable payments for Africa's freelancers and agencies.
Built for the W3Node Node Engine Hackathon 2026, Mobile Money & Peer-to-Peer track (Tether).

> **Test networks only.** Nothing here moves real money. The token is `TestUSDT` (tUSDT), a test token
> we deploy ourselves; it is not Tether USDT. Fiat conversion, identity checks, card checkout and mobile-money
> and bank payouts are **simulated** and labelled as such in the API responses and in the code.

## What it is

A client and a provider sign a contract. Each milestone is funded into an on-chain escrow in test USDT. When the
client approves (or two of three parties decide a dispute), the escrow releases to the provider's own vault. An AI
Settlement Agent **proposes** how to split the money (payees, tax reserve). A separate, deterministic Policy
Service **decides** and co-signs. The vault pays only with both signatures and only inside on-chain limits. Payouts
go out, a non-transferable receipt NFT is minted, and every step is joined in a reconciliation ledger with a CSV
tax export.

**Business model.** Tethran takes a **5% platform fee** on each milestone, paid by the freelancer out of the settlement
into the Tethran earnings account (in the demo a demo wallet, "Tethran earnings account"; in production a company
treasury). The client pays exactly the milestone amount. The fee is computed by code, not by the AI, and the Policy
Service rejects any plan whose fee line is missing, wrong or sent elsewhere (`FEE_MISMATCH`). The freelancer receives
the gross minus the fee minus the tax reserve (10% of the gross in the demo policy). Refunds and disputes decided for
the client pay no fee. The operator sees it all on the **Earnings** screen; the fee also appears in the payout step,
on the receipt and in reconciliation.

## Run the demo (one command)

Requires Node.js 22.13 or newer. Once:

```bash
cd contracts && npm install && npm run wallets   # throwaway TEST keys into ../.env (git-ignored)
for d in services/chain services/policy services/llm services/backend app; do (cd $d && npm install); done
```

Then one command seeds the nine scenarios and serves everything:

```bash
cd services/backend && CHAIN=sepolia npm run demo     # Sepolia: the contracts in config/chains.json
cd services/backend && CHAIN=localhost npm run demo   # local chain: starts `hardhat node` and deploys if needed
```

| Service | Address |
|---|---|
| Web app | http://localhost:3000 |
| Backend API | http://127.0.0.1:18788 |
| Policy Service | http://127.0.0.1:18787 |
| Demo signer (DEMO_MODE only, test keys) | http://127.0.0.1:18789 |

The seed wipes `.demo-data/` (that directory only; logs in `.demo-data/logs/`), starts the Policy Service and the
backend as separate processes with separate keys, signs a contract and drives one milestone per scenario through the
real API, then keeps serving. On Sepolia it takes about 40 minutes. `npm run demo:serve` restarts on the last seeded
state; `npm run seed -- --retry-failed` (with `DEMO_MODE=1`) reruns only failed scenarios. Ports:
`DEMO_BACKEND_PORT`, `DEMO_POLICY_PORT`, `DEMO_SIGNER_PORT`, `DEMO_APP_PORT`; `DEMO_APP=0` skips the app. The agent
mode defaults to `replay` (saved proposals, labelled "Replay"); `AGENT_MODE=live+replay` calls the model and falls
back to replay. The demo, step by step, is in [docs/DEMO.md](docs/DEMO.md).

**Tethran wallet (demo wallet).** Each user, the client (Kofi Mensah Ltd) and the freelancer (Amara Studio), has one
Tethran wallet showing a test USDT balance (the Wallet screen). **Add funds** is a simulated card top-up: the treasury
mints the same amount of test USDT (1 USD = 1 test USDT; DEMO_MODE only). At checkout the payer chooses **Tethran
wallet** (pay from the balance) or card. Payouts arrive in the freelancer's wallet, and a contract can name the
freelancer's own wallet as its client, so one person can be both. Labelled "Wallet" (balances in test USDT): one demo
seed holds the keys; not real custody, not real money.

**Demo-key buttons.** In the app, each operator, arbiter and provider action offers **Sign with demo key** (DEMO_MODE
only: one click, signed with that role's test key by the demo signer in the presenter's process, labelled "Demo:
signed with a test key") next to **Sign with your wallet** (the real path, the person's own wallet extension). The
milestone page adds the platform's own step, **Release and settle**, in demo mode. The backend and the Policy Service
never hold the operator, arbiter or provider keys.

## Architecture in a few lines

```
client wallet (WDK) ──deposit──> treasury ──createAndFund──> MilestoneEscrow ──release──> ProviderVault ──> payees
                                                                                          ▲    ▲
     Settlement Agent (LLM, no keys) ──proposal──> Policy Service ──co-signature──────────┘    │
                                                  (rules, audit)    agent signer module ───────┘ (second signature)
```

- `contracts/`: `TestUSDT` (EIP-3009), `MilestoneEscrow` (2-of-3 EIP-712 disputes), `ProviderVault` (two
  signatures, payee allowlist, per-transaction and daily caps, reserve), `ReceiptNFT` (soulbound, hashes only).
- `services/chain/`: `ChainClient`, the only code that talks to a chain (idempotency keys, chain-id check,
  mainnet deny-list), and the WDK wallet layer.
- `services/policy/`: the Policy Service. Its own process and its own key; reason codes; audit log.
- `services/llm/`: `LlmProvider` (Groq first, Gemini fallback), agent prompt, input guards, Opik tracing, evals.
- `app/`: the web app (Vite, React, TanStack Start, Tailwind, shadcn/ui). An interface only: it reads and writes
  through `app/src/api` and holds no keys; operator, arbiter and provider signatures come from the user's own wallet
  or, in demo mode, the labelled demo signer.
- `services/backend/`: treasury, settlement orchestrator, agent signer, contracts and invoices, checkout,
  payouts, reconciliation, operator and arbiter queues, x402 endpoints. See [docs/API.md](docs/API.md).
- Config: `config/chains.json` holds chain id, RPC and contract addresses per chain. Nothing is hard-coded.

## What is simulated

| Part | What is real | What is simulated |
|---|---|---|
| Escrow, vault, limits, receipts | On-chain on a test network | Nothing |
| Token | Our own `TestUSDT` (open minting: it is its own faucet) | It is not Tether USDT |
| Card, Apple Pay, Google Pay, PayPal, Cash App | Signed Stripe-format events through the real webhook handler | The checkout itself (real Stripe path built, off until keys are set) |
| Fiat conversion and FX quotes | | Rates are placeholders |
| Identity check (payer vs customer name) | The backend enforces it before release: a mismatch holds the release for the operator | The verification provider |
| Mobile money (M-Pesa, MTN MoMo, Airtel) and bank payouts | The vault pays the rail's wallet on-chain | The off-chain leg to the phone or bank |
| x402 data purchases | EIP-3009 payment settled on-chain in TestUSDT | The data served (corridor rules from country profiles, demo FX rates) |
| Tax rates in country profiles | | Unverified placeholders, labelled |
| Wallet custody | WDK wallets sign every user transaction | One demo test seed holds all user wallets |
| Tethran wallet top-ups | Test USDT minted on-chain to the wallet; paying from the wallet is the on-chain deposit path | The card (no card is charged); 1 USD = 1 test USDT |
| Demo-key signing | The same signatures and checks as the wallet path | The keys are test keys in the presenter's process (DEMO_MODE only) |
| Agent (seed default) | Live model calls with `AGENT_MODE=live` or `live+replay` | `replay`: saved proposals, labelled |

## Trust assumptions

- **The agent is untrusted.** It returns a schema-valid proposal and nothing else. It holds no key and cannot
  change policy. Contract text, evidence and purchased data are untrusted data, never instructions.
- **The Policy Service is authoritative** for off-chain rules; the **vault is final** for limits. A payout needs
  the Policy Service signature and the agent signer signature, and the vault checks payee, caps and reserve again.
  The Policy Service decides only for the milestone the backend names in its authenticated request
  (`x-internal-token`); a proposal for any other milestone is rejected (`MILESTONE_ID_MISMATCH`). Each milestone is
  settled at most once (`ALREADY_SETTLED`), within what its escrow released, and only after it was released on-chain.
- **The platform releases.** The treasury funds each escrow and is the only account that can release an approved
  milestone. Release, refund and settle need the platform token (`x-platform-token`). If the platform never
  releases, it can take the funds back three days after the hold ends.
- **The vault operator is effectively the owner of the vault.** The operator key (provider or agency admin) can
  replace both co-signers, allow any payee and raise the caps. The two-signature rule protects against a
  compromised agent or Policy Service, not against the operator. The operator address cannot be changed.
- **Policy changes take effect at once** and operator policy signatures do not expire (a newer version retires an
  older one). The daily cap resets at 00:00 UTC. To pause payouts, sign zero caps.
- **Stablecoin funding is a demo simplification:** the client pays a treasury deposit address and the treasury
  funds the escrow.
- **Identity checks are simulated** and enforced by the backend, not on-chain.
- **The demo signer holds test keys** for the operator, arbiter and provider, and the platform token, in the
  presenter's process (DEMO_MODE only), so the demo needs no wallet switching. In real use each person signs with
  their own wallet.
- **Other backend routes have no user authentication** in this build. This is a demo server on localhost.

## Tests

```bash
cd contracts && npm test                  # 122 contract tests
cd services/chain && npm test             # 40: ChainClient, WDK signing policy, RPC and WDK failover
cd services/policy && npm test            # 159: Policy Service rules, co-signing, HTTP API
cd services/llm && npm test               # 61: providers, agent, guards (offline)
cd services/backend && npm test           # 139: treasury, settlement, wallets (incl. demo wallet), x402, reconciliation, ...
cd app && npm test                        # 13: app API mapping, demo wallet, reason-code parity
cd app && npm run e2e:demo-short          # Playwright against the live demo (also e2e:tour, e2e:journey)
cd services/backend && CHAIN=sepolia npm run slice   # one milestone through the real services on Sepolia
cd services/llm && npm run eval:agent     # the nine scenarios against the live model, traced in Opik
```

## WDK: what we use, and what it could not do

Packages imported by our code (in `services/chain/src/wdk.ts`, used by `services/backend/src/wallets.ts` and the
seed and slice scripts):

- **`@tetherto/wdk` 1.0.0-beta.22**: the `WDK` core with one BIP-39 test seed; `registerWallet`;
  `registerPolicy` (WDK transaction policies); `getAccount(walletId, index)`; `PolicyViolationError`; `dispose`.
- **`@tetherto/wdk-wallet-evm` 1.0.0-beta.26**: `WalletManagerEvm` (BIP-44 EVM accounts). Account calls we use:
  `getAddress`, `getBalance`, `getTokenBalance`, `quoteTransfer`, `transfer`, `sendTransaction`, `signTypedData`.
- **`@tetherto/wdk-failover-provider` 1.0.0-beta.2**: the wallets' RPC. The API-key RPC (`RPC_URL_<chainId>`) is
  first and the chain file's public RPC second, each with a 20-second request timeout; a timeout, network or server
  error moves the call to the next one. Contract errors are not retried.

`@tetherto/wdk-wallet` is installed only as a dependency; we do not import it.

What WDK does for us: every user-side signature (client deposits, the client's on-chain approve and dispute,
contract signing, the agent's x402 payment authorizations) is made by a WDK account. WDK policies limit each
wallet: test-USDT transfers only, under a cap; contract calls only to the escrow; typed-data signing only for
escrow attestations, contract signatures and small test-USDT EIP-3009 authorizations.

What WDK could not do here, so we built it ourselves:
- **Two-signature payouts.** We found no EVM multisig implementation in these packages, so the provider vault
  is our own contract and its two signers are server keys, not WDK accounts.
- **Gasless or sponsored transactions.** Not used. Payers sign EIP-3009 authorizations through WDK and the
  backend submits them and pays gas.
- **Fee quotes right after a mint.** On Sepolia, `quoteTransfer` sometimes fails until the RPC node sees the new
  balance; the review screen then shows the fee as unavailable rather than guessing.
- **Custody.** Real users would hold their own seed; the demo keeps one test seed on the server.

## Documents

- [docs/DEMO.md](docs/DEMO.md): demo journey, reset commands, fallback plan
- [docs/API.md](docs/API.md): every endpoint
- [docs/INTERFACES.md](docs/INTERFACES.md): the contract between the workstreams
- `docs/`: whitepaper, PRD, architecture, development plan
- `Development.md`: log of every change and why
