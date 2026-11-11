# Development log

Every change and why. Newest entries at the bottom. Times are WAT (UTC+1).

---

## 2026-11-12 — Session 002: decisions, Phase 0 spikes, scaffold, escrow skeleton

### 1. Project files moved (decision 15)
- the project rules file, the working guide and `Build-Context-Memory.json` moved from `docs/` to the repo root, where
  the documents already said they were. No references needed changing.
- `README.md` rewritten: the placeholder was UTF-16 and did not render.

### 2. INTERFACES.md v0.1 -> v0.2 (co-architect decisions 1 to 14)
Each change to the workstream contract:

| # | Change | Why |
|---|---|---|
| 1 | `fund` replaced by `createAndFund(milestoneId, client, provider, arbiter, vault, amount, timeout, cardFunded, holdSeconds)` | The old call stored no parties or destination, so `decide` and `release` could not work |
| 2 | Added `dispute(milestoneId)`; `Disputed` event now carries who disputed | There was a Disputed state with no way into it |
| 3 | Added `approve(milestoneId)` for the client alone; `decide` is for Disputed milestones only; undecided dispute refunds at the timeout | Clean path should not need two signatures |
| 4 | `release` restricted to a RELEASER role; identity hold documented as backend-enforced and simulated | A permissionless release would bypass the identity check |
| 5 | `holdSeconds` is per milestone; `release` needs `approvedAt + holdSeconds` when card-funded | The chargeback hold had no on-chain home |
| 6 | Guard gets `minReserve`; policy document field named `vault_min_reserve`; `min_tax_reserve_bps` documented as a different thing | Two different limits shared one name |
| 7 | Guard allowlist is `mapping(address => bool)` (`setPayee`), no Merkle root; `check` loses the proof argument; `payees` table added | Fewer lines to review |
| 8 | One vault per provider; `vault` and `guard` removed from chain config, `vaults` table added | No pooled vault |
| 9 | Receipt minted by a MINTER role after the confirmed vault payout; holder is the provider | It must store the release transaction hash |
| 10 | `ChainClient` extended: createAndFund, approve, dispute, decide, release, refund, vaultExecute, setPolicy, mintReceipt, txStatus, balance; every write takes an `idempotencyKey`; `TxRef` defined | The old interface could not run the slice |
| 11 | New section 1a: agent key lives in a signer module; `submit_cosigned_tx` is not an LLM tool; the orchestrator submits | Keep keys out of LLM context |
| 12 | Reason codes for rejected and escalated; `per_tx_soft_limit` and `confidence_threshold` (0.7) added to the policy document; daily cap is the UTC calendar day; rule order rewritten | Decisions were underspecified |
| 14 | New section 0: on-chain to off-chain state mapping, with `draft`, `in_review`, `paid_out` | Three documents listed different states |
| - | Storage is SQLite; chain config is `{ name, chainId, rpcUrl, testnet, usdt, escrow, receiptNft }` | Decision 16; test-network flag is enforced in code |

Details I had to fill in while writing v0.2 (flagged for confirmation, see known issues in the memory file):
- `decide(false)` refunds in the same transaction; `decide(true)` moves to Approved. This keeps the six states.
- The on-chain refund goes to the funder (`msg.sender` of `createAndFund`), not to `client`. For a card-funded
  milestone the funder is the treasury, which then refunds the client off-chain.
- A milestone can be decided once, so the attestation `nonce` is fixed at `0`.
- On-chain `milestoneId` is `keccak256` of the UTF-8 milestone UUID.
- The reason code for a proposal made during the chargeback hold is left open.

The architecture document (sections 3.2, 3.3, 5.2) still describes the old design. INTERFACES.md v0.2 says it
wins; the architecture document itself was not edited.

### 3. Phase 0 verification checks

| # | Check | Answer | Fallback chosen |
|---|---|---|---|
| V1 | Test USDT on the test network | Not relied on. Decision 17: deploy our own. | **Own token**: `TestUSDT`, 6 decimals, open mint, EIP-3009. Built and tested. |
| V2 | WDK smart account or multisig, gasless | Partly. `@tetherto/wdk-wallet-evm-erc-4337` (beta.24) gives a Safe smart account with ERC-4337 and paymaster or sponsored fees, but it is single-owner: no owners or threshold option was found in its documentation. Gasless needs a bundler and paymaster URL (third-party account and key). | **Minimal custom 2-of-2 vault contract**. Gasless not used; fees paid in test ETH. |
| V3 | WDK fiat on-ramp in test mode | `@tetherto/wdk-protocol-fiat-moonpay` (beta.6) exists; it produces MoonPay widget URLs and quotes and needs a MoonPay account and key. Not tested. | **Treasury script, labelled simulated**. |
| V4 | x402 on an EVM test network | Packages exist (`@x402/core`, `@x402/evm` 2.30.0). Not run. The EVM "exact" scheme settles with EIP-3009, which `TestUSDT` implements, so our own facilitator can settle on either chain. | Mock x402 server and client, labelled simulated, if the real flow does not run. Person B to spike. |
| V5 | Stripe sandbox methods | Not verifiable from this session: needs a Stripe account, test keys and real devices. | Card first; add the wallets that work; label the rest. Person B to spike. |
| V6 | WDK policy hooks | None found in the wallet module documentation or type definitions. | **Policy Service plus the on-chain guard only**. |
| V7 | LLM and Opik | Decided: a hosted LLM via its API, Opik cloud (`opik` 2.2.143 on npm). Keys not provided yet; not run. | Local Opik. Person B to spike. |
| V8 | WDK per extra EVM chain | `@tetherto/wdk-wallet-evm` (beta.26) takes any RPC URL, so it is chain-agnostic. | Our own `TestUSDT` deployed on each chain. |

WDK spike (run in a scratch directory, not in the repo): a WDK account derived from a seed phrase gives the
same address as the standard BIP-44 path, and exposes `sendTransaction({to, data})`, `signTypedData`, `transfer`
and balance reads. Its `sendTransaction` fits the `TxSender` shape in `ChainClient` without changes to the client.

**Faucets (decision 18): not done.** Seven test wallets were generated (keys in the git-ignored `.env`). All
hold 0 test ETH on Sepolia and Base Sepolia. Faucets need a login or captcha, so a person has to do this.
Primary chain is therefore still undecided. Treasury address to fund: `0x70764aE2e9280c45fAefcB75927bF9916AdDB09e`.

### 4. Scaffold
- Stack as decided: Hardhat 2 (2.29, the `hh2` line) with ethers v6 and OpenZeppelin 5.6.1; TypeScript throughout.
  Hardhat 2 rather than Hardhat 3 because its toolbox, test helpers and config format are the well-known ones;
  less risk under a deadline.
- TypeScript pinned to 5.8.3: the toolbox pulled TypeScript 7, which breaks `ts-node` (see errors in the memory file).
- `config/chains.json`: localhost, Sepolia, Base Sepolia. Every entry must be `"testnet": true`; the Hardhat
  config, the deploy script and `ChainClient` all refuse anything else.
- `.env.example`, `.gitignore`, `contracts/scripts/gen-wallets.ts` (never prints a key, never overwrites one),
  `contracts/scripts/balances.ts`, `contracts/scripts/deploy.ts` (writes addresses back to `chains.json`).
- `app/` is left empty: Person B's workstream.

### 5. Contracts
- `TestUSDT.sol`: test token, clearly labelled. Open `mint` is the faucet. EIP-3009 `transferWithAuthorization`
  for x402. 3 tests.
- `MilestoneEscrow.sol` skeleton: `createAndFund`, `approve`, `dispute`, `release`, `refund`, `state`,
  `milestone`. OpenZeppelin `AccessControl` for the RELEASER role and `SafeERC20` for transfers. State is
  written before any token transfer. 16 tests. **`decide` is not in this commit**; a disputed milestone can
  only refund at its timeout until it is added.
- In the deploy script the treasury is both admin and RELEASER.

### 6. ChainClient (`services/chain`)
- `EvmChainClient` implements the v0.2 interface for the escrow calls, `txStatus` and `balance`.
  `decide`, `vaultExecute`, `setPolicy` and `mintReceipt` throw `NotBuiltYetError` until their contracts exist.
- Idempotency: a key is claimed before sending and the hash recorded after. A repeated key returns the first
  `TxRef`. If a send fails with a revert or insufficient funds (nothing was broadcast) the key is freed; on any
  other failure it stays claimed and the client refuses to resend. Stores: in-memory and SQLite (`node:sqlite`,
  built into Node, so no native build on Windows).
- `createAndFund` sets the token allowance to the exact amount first when it is too low.
- Two helpers outside the interface: `escrowState` and `mintTestUsdt` (test faucet).
- 8 unit tests.

### 7. Proof
`CHAIN=localhost npm run prove` in `services/chain`: mint test USDT -> `createAndFund` -> repeat the same
idempotency key (no second send) -> `approve` by the client -> `release` by the treasury. Passed on the local
Hardhat chain: escrow state Released and the vault stand-in received 5,000,000 base units. The vault stand-in is
the provider's own address, because the vault contract is not built yet. **Not yet run on a public test
network** (no test ETH).
