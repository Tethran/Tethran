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

## Run the demo (one command)

Requires Node.js 22.13 or newer.

```bash
cd contracts && npm install && npm run wallets   # throwaway TEST keys into ../.env (git-ignored)
cd ../services/chain && npm install
cd ../policy && npm install
cd ../llm && npm install
cd ../backend && npm install

# One command: starts the services, seeds all nine scenarios, keeps serving (backend :18788, Policy :18787)
cd services/backend && CHAIN=localhost npm run demo   # local chain: starts `hardhat node` and deploys if needed
cd services/backend && CHAIN=sepolia npm run demo     # Sepolia: uses the contracts in config/chains.json
```

`CHAIN` comes from the environment, then from `.env`, then defaults to `localhost`. The seed wipes `.demo-data/`
(that directory only; service logs go to `.demo-data/logs/`), starts the Policy Service and the backend as separate
processes with separate keys, signs a contract, and drives one milestone per scenario through the real API. It
prints a short summary. Rerun it at any time; every run starts from an empty `.demo-data/`. `npm run demo:serve`
restarts the services on the last seeded state; `DEMO_MODE=1 npm run seed` seeds without serving. The agent mode
defaults to `replay`: saved proposals, eight of them real model outputs from the evaluation run (each names its
Opik trace) and one curated (labelled). Set `AGENT_MODE=live+replay` to call the model and fall back to replay if
it fails. The web app's origin `http://localhost:3000` is allowed by CORS (`CORS_ORIGINS` to change it). The
step-by-step demo is in [docs/DEMO.md](docs/DEMO.md).

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
- `services/backend/`: treasury, settlement orchestrator, agent signer, contracts and invoices, checkout,
  payouts, reconciliation, operator and arbiter queues, x402 endpoints. See [docs/API.md](docs/API.md).
- Config: `config/chains.json` holds chain id, RPC and contract addresses per chain. Nothing is hard-coded.

## What is simulated

| Part | What is real | What is simulated |
|---|---|---|
| Escrow, vault, limits, receipts | On-chain on a test network | Nothing |
| Token | Our own `TestUSDT` (open test faucet) | It is not Tether USDT |
| Card, Apple Pay, Google Pay, PayPal, Cash App | Signed Stripe-format events through the real webhook handler | The checkout itself (real Stripe path built, off until keys are set) |
| Fiat conversion and FX quotes | | Rates are placeholders |
| Identity check (payer vs customer name) | The backend enforces it before release | The verification provider |
| Mobile money (M-Pesa, MTN MoMo, Airtel) and bank payouts | The vault pays the rail's wallet on-chain | The off-chain leg to the phone or bank |
| x402 data purchases | EIP-3009 payment settled on-chain in TestUSDT | The data served (corridor rules from country profiles, demo FX rates) |
| Tax rates in country profiles | | Unverified placeholders, labelled |
| Wallet custody | WDK wallets sign every user transaction | One demo test seed holds all user wallets |

## Trust assumptions

- **The agent is untrusted.** It returns a schema-valid proposal and nothing else. It holds no key and cannot
  change policy. Contract text, evidence and purchased data are untrusted data, never instructions.
- **The Policy Service is authoritative** for off-chain rules; the **vault is final** for limits. A payout needs
  the Policy Service signature and the agent signer signature, and the vault checks payee, caps and reserve again.
- **The platform releases.** The treasury funds each escrow and is the only account that can release an approved
  milestone. If it never releases, it can take the funds back three days after the hold ends.
- **The vault operator is effectively the owner of the vault.** The operator key (provider or agency admin) can
  replace both co-signers, allow any payee and raise the caps. The two-signature rule protects against a
  compromised agent or Policy Service, not against the operator. The operator address cannot be changed.
- **Policy changes take effect at once.** The daily cap resets at 00:00 UTC. To pause payouts, sign zero caps.
- **Stablecoin funding is a demo simplification:** the client pays a treasury deposit address and the treasury
  funds the escrow.
- **Identity checks are simulated** and enforced by the backend, not on-chain.
- **Backend routes have no user authentication** in this build (only `/internal` routes need a token). This is a
  demo server on localhost.

## Tests

```bash
cd contracts && npm test                  # 122 contract tests
cd services/chain && npm test             # ChainClient and the WDK signing policy
cd services/policy && npm test            # Policy Service rules, co-signing, HTTP API
cd services/llm && npm test               # providers, agent, guards (offline)
cd services/backend && npm test           # treasury, settlement, wallets, x402, reconciliation, ...
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

`@tetherto/wdk-wallet` and `@tetherto/wdk-failover-provider` are installed only as dependencies of those two; we
do not import them.

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
