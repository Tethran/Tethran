# Scope and limitations

What runs for real and what is simulated in this build. Moved unchanged from the README (13 Nov 2026).

> **Test networks only.** Nothing here moves real money. The token is `TestUSDT` (tUSDT), a test token
> we deploy ourselves; it is not Tether USDT. Fiat conversion, identity checks, card checkout and mobile-money
> and bank payouts are **simulated** and labelled as such in the API responses and in the code.

## What is simulated

| Part | What is real | What is simulated |
|---|---|---|
| Escrow, vault, limits, receipts | On-chain on a test network | Nothing |
| Token | Our own `TestUSDT` (open minting: it is its own faucet) | It is not Tether USDT |
| Card, Apple Pay, Google Pay, PayPal, Cash App | Signed Stripe-format events through the real webhook handler | The checkout itself (real Stripe path built, off until keys are set) |
| Exchange rates (local-currency amounts of mobile-money and bank payouts) | Indicative market rates from ExchangeRate-API's open endpoint, cached 6 hours, locked to each milestone at creation, shown with "Indicative rate, last updated <date>" and "Rates By Exchange Rate API" | The conversion and the payout leg themselves; without the API, the last cached rates, then a sample table (labelled) |
| x402 `/x402/fx-quote` | The x402 payment | "Sample rates": fixed placeholders. The provider's terms allow its rates only for our own end use, not through a paid or programmatic endpoint, so this endpoint never serves them |
| Identity check (payer vs customer name) | The backend enforces it before release: a mismatch holds the release for the operator | The verification provider |
| Mobile money (M-Pesa, MTN MoMo, Airtel) and bank payouts | The vault pays the rail's wallet on-chain | The off-chain leg to the phone or bank |
| x402 data purchases | EIP-3009 payment settled on-chain in TestUSDT | The data served (corridor rules from country profiles, demo FX rates) |
| Tax rates in country profiles | | Unverified placeholders, labelled |
| Wallet custody | WDK wallets sign every user transaction | One demo test seed holds all user wallets |
| Tethran wallet top-ups | Test USDT minted on-chain to the wallet; paying from the wallet is the on-chain deposit path | The card (no card is charged); 1 USD = 1 test USDT |
| Demo-key signing | The same signatures and checks as the wallet path | The keys are test keys in the presenter's process (DEMO_MODE only) |
| Agent (seed default) | Live model calls with `AGENT_MODE=live` or `live+replay` | `replay`: saved proposals, labelled |

## Demo wallets and demo-key signing

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

## Other notes moved from the README's trust assumptions

- **Policy changes take effect at once** and operator policy signatures do not expire (a newer version retires an
  older one). The daily cap resets at 00:00 UTC. To pause payouts, sign zero caps.
- **Stablecoin funding is a demo simplification:** the client pays a treasury deposit address and the treasury
  funds the escrow.
- **Identity checks are simulated** and enforced by the backend, not on-chain.
- **The demo signer holds test keys** for the operator, arbiter and provider, and the platform token, in the
  presenter's process (DEMO_MODE only), so the demo needs no wallet switching. In real use each person signs with
  their own wallet.
- **Other backend routes have no user authentication** in this build. This is a demo server on localhost.

## Notes from WDK integration

- **Fee quotes right after a mint.** On Sepolia, `quoteTransfer` sometimes fails until the RPC node sees the new
  balance; the review screen then shows the fee as unavailable rather than guessing.
- **Custody.** Real users would hold their own seed; the demo keeps one test seed on the server.
