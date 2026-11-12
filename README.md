# Tethran

Enforceable, traceable, deliverable payments for Africa's freelancers and agencies.
Built for the W3Node Node Engine Hackathon 2026, Mobile Money & Peer-to-Peer track (Tether).

> **Test networks only.** Nothing here moves real money. The token is `TestUSDT` (tUSDT), a test token
> we deploy ourselves; it is not Tether USDT. Fiat conversion, identity checks and payout rails are
> **simulated** and labelled as such.

## What it does

1. A client funds a milestone; the funds sit in an on-chain escrow in (test) USDT.
2. The client approves the work. Disputes are decided by two of three signed attestations.
3. The escrow releases to the provider's two-signature vault.
4. An AI Settlement Agent **proposes** how to split and pay out. It holds no keys.
5. A deterministic Policy Service **authorises** and co-signs; an on-chain spending guard **enforces** the limits.
6. Payouts go out (simulated mobile money, bank, USDT) and a non-transferable receipt NFT is minted.

## Status

| Part | Status |
|---|---|
| `TestUSDT` (6 decimals, EIP-3009) | Built, tested |
| `MilestoneEscrow`: createAndFund, approve, dispute, decide (2-of-3 EIP-712), release, refund, refundApproved | Built, tested, deployed on Sepolia |
| `ProviderVault`: two-signature vault with built-in spending guard, signer rotation, provider withdrawal | Built, tested, deployed on Sepolia (demo provider) |
| `ReceiptNFT`: soulbound, hashes only, one per milestone | Built, tested, deployed on Sepolia |
| `ChainClient` (escrow calls, idempotency keys, operator resolve) | Built, tested |
| Policy Service rule engine, reason codes, audit log | Built, tested |
| Policy Service HTTP API, co-signing, approvals queue | Built, tested; reads the chain; relaying on-chain limit changes not wired yet |
| `LlmProvider` (Groq first, Gemini fallback, optional NVIDIA) and agent eval runner | Built; run against Groq and Gemini; traced in Opik |
| Backend: treasury (Stripe webhook, stablecoin deposits, funding, release, refunds, chargebacks), settlement orchestrator, agent signer | Built, tested; full slice passes on Sepolia |
| Contracts, invoicing, Stripe checkout, payout adapters, reconciliation, operator endpoints | Not built yet |
| Web app | Not in this repo (separate workstream) |

## Known trust assumptions

- **The platform releases.** The treasury funds each escrow and is the only account that can release an
  approved milestone to the provider. If it never releases, it can take the funds back three days after the
  hold ends. The provider relies on the platform to release; the escrow does not force it.
- **The vault operator is effectively the owner of the vault.** Each provider's vault has an operator key (the
  provider or agency admin). That key can replace both co-signers, allow any payee and raise the caps, and then
  pay any address. A compromised operator key can drain the vault. The two-signature rule and the on-chain
  limits protect against a compromised agent or Policy Service and against mistakes; they do not protect
  against the operator. Policy changes take effect at once. The fixed provider payout address only limits the
  escape-hatch withdrawal.
- **The operator address cannot be changed.** If that key is lost, the vault's limits, payees and signers are
  frozen and the escape withdrawal is gone; if a co-signer key is then lost too, the funds are stranded.
- **The daily cap resets at 00:00 UTC**, so up to twice the cap can leave within minutes around midnight.
  To pause payouts, the operator signs a policy with zero caps.
- **Stablecoin funding is a demo simplification.** A client paying in stablecoin sends it to a treasury deposit
  address and the treasury funds the escrow.
- **Identity checks are simulated** and enforced by the backend before release, not on-chain.
- **Escrow minimum timeout** is 1 day by default; the Sepolia demo deployment uses 10 minutes so a timeout
  refund can be shown live.

## Layout

```
config/chains.json   per-chain config (chain id, RPC, contract addresses); test networks only
contracts/           Solidity contracts, tests and deploy scripts (Hardhat, ethers v6)
services/chain/      ChainClient: the only code that talks to a chain
services/policy/     Policy Service: rule engine, audit log, HTTP API, co-signing
services/llm/        LlmProvider: the only code that calls a model API; Opik tracing
services/backend/    Backend API: treasury, settlement orchestrator, agent signer module (see docs/API.md)
app/                 web app (not built yet)
docs/                whitepaper, PRD, architecture, plan, INTERFACES.md, TASKS.md
Development.md       log of every change and why
```

## Run it

Requires Node.js 22.13 or newer.

```bash
# 1. contracts
cd contracts
npm install
npm test                 # contract tests
npm run wallets          # writes throwaway TEST keys to ../.env (git-ignored)

# 2. local chain + scripted proof (fund -> approve -> release through ChainClient)
npx hardhat node                                      # terminal 1
npx hardhat run scripts/deploy.ts --network localhost # terminal 2
cd ../services/chain
npm install
npm test
CHAIN=localhost npm run prove

# 3. a public test network (the treasury address needs test ETH first)
cd ../../contracts
npm run balances
npx hardhat run scripts/deploy.ts --network sepolia   # or baseSepolia
cd ../services/chain && CHAIN=sepolia npm run prove
```

Copy `.env.example` to `.env` if you prefer to set the test keys by hand. Never commit `.env`.

## The full slice

```bash
cd services/backend && npm install
CHAIN=sepolia npm run slice     # or CHAIN=localhost with a local node and the three deploy scripts
```

It starts the Policy Service and the backend as separate processes (each gets only its own key), then: create a
milestone, client deposits test USDT, backend funds the escrow and verifies it, client approves on-chain, backend
releases to the vault, the agent proposes a split, the Policy Service decides and co-signs, the agent signer adds
the second signature, the vault pays out, and the receipt is minted. One Opik trace covers the settlement.

## Documents

See `docs/` for the whitepaper, PRD, architecture and development plan. `docs/INTERFACES.md` is the
contract between the workstreams.
