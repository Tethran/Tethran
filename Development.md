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

---

## 2026-11-12 — Session 003: interfaces v0.3, decide, Sepolia deployment

### 1. Lead decisions on the five open questions
1. Refund goes to the funder: confirmed, no change.
2. `decide(false)` refunds in the same transaction; a milestone is decided once: confirmed.
3. Attestation nonce removed. The EIP-712 domain plus the once-only rule is enough.
4. Disputes only while Funded (replaces the earlier rule that allowed them while Approved). Client approval is
   final for the client. A dispute extends the timeout to at least now + `DISPUTE_WINDOW` (constant, 7 days).
5. New reason code `HOLD_ACTIVE` (rejected) for a proposal made during the card hold. The orchestrator must not
   call the agent until release is eligible.

### 2. INTERFACES.md v0.2 -> v0.3
| Change | Why |
|---|---|
| `Attestation(bytes32 milestoneId, uint8 kind, bool releaseToProvider)`: nonce removed | Decision 3 |
| `dispute` only while Funded; extends the timeout; `Disputed` event carries the resulting timeout | Decision 4; the event lets the reconciliation store follow the new timeout |
| `decide` only before the timeout; exactly two signatures from two different parties | Avoids a race between a late decision and the default refund; "two of three" made exact |
| `HOLD_ACTIVE` added to the rejected codes and to the rule order (after duplicate, before payee) | Decision 5 |
| Chain config gains `confirmations` (default 1) | See the Sepolia error below |

Two details are mine, not decided by the lead: `decide` is closed after the timeout, and `decide` takes exactly
two signatures (not two or three). Both are in the memory file for confirmation.

### 3. MilestoneEscrow
- `dispute`: Funded only; `timeout = max(timeout, now + 7 days)`. Tests: approval is final, near timeout is
  pushed out, far timeout is not shortened.
- `decide`: OpenZeppelin `EIP712` and `ECDSA`. The attestation kind is derived from which party the signer is, so
  a signer cannot claim another role. Anyone may submit; the signatures are the authority. 17 tests, including
  forged signer, opposite outcome, wrong kind, swapped signatures, replay from another milestone, another chain,
  another contract, non-party signers, and the closed window.
- Signatures are checked with ECDSA only, so the three parties must be ordinary key wallets, not smart accounts.
- Contract tests: 38 passing (18 escrow, 17 decide, 3 token).

### 4. ChainClient
- `decide` implemented; `attestationTypedData` helper returns the exact EIP-712 payload a wallet signs.
- `waitConfirmed` now waits `confirmations` blocks. 9 unit tests passing.

### 5. Sepolia (primary chain)
- The lead funded the treasury with 0.05 test ETH, so **Sepolia is the primary chain**; Base Sepolia is the second.
- Deployed: TestUSDT (test token) `0xf71881cb70FAeDa9106576f6DaE6B74676164f2b`, MilestoneEscrow
  `0x55CCC2eC0eC0E031c155865230A41b4bA40EA513` (addresses in `config/chains.json`).
- New `contracts/scripts/fund-gas.ts`: tops the client and provider wallets up to 0.004 test ETH from the treasury.
- Proof script passed on Sepolia: createAndFund `0x62525ab7…`, approve `0x8f7ed3a9…`, release `0x7e1e370e…`;
  escrow Released, vault stand-in received 5,000,000 base units.
- First Sepolia run failed: `release` reverted at gas estimation with `WrongState(Funded)` although `approve` was
  already mined. The public RPC is load-balanced and one node was a block behind. Fix: `confirmations: 2` for the
  public test networks. The first run left one test milestone Approved and unreleased on Sepolia; harmless.

### 6. Git
- Repo-local git identity set from the name and email the lead gave. First commits made after 00:00 as asked.

---

## 2026-11-12 — Session 004: Policy Service rule engine merged

Built by a helper agent in its own worktree while the lead reviews the escrow, as the lead allowed. It
owned only `services/policy/` and did not touch INTERFACES.md. Merged into main by fast-forward (commit
`43e304b`) after checking that the branch changed nothing outside its directory, rerunning typecheck and tests
on main, and reading `engine.ts`.

### What it is
- `src/schema.ts`: the SettlementProposal JSON schema from INTERFACES.md section 1, validated with `ajv`.
- `src/engine.ts`: `evaluateProposal(proposal, ctx)`, a pure function with no I/O and no clock. Returns
  `{ decision, reasons, proposal_hash }`. Rule order and reason codes as in INTERFACES.md v0.3. All money maths
  in BigInt. Throws on an invalid policy document instead of evaluating with it.
- `src/audit.ts`: append-only audit log on `node:sqlite`; only `append` and `list`; SQLite triggers abort any
  UPDATE or DELETE.
- 55 unit tests passing: every reason code, the approved path, rejected beats escalated, boundaries, amounts
  above 2^53, hash stability, bad policy documents, the audit triggers, and the rule-level seeded scenarios
  (over-limit, unknown payee, low confidence, duplicate send, identity mismatch, three injection-style proposals).
- New dependency: `ajv` (JSON-schema validation), in `services/policy` only.

### Not built yet (deliberately out of this task)
HTTP API, co-signing and the Policy Service key, operator signature verification, the approvals queue.
**Needs the lead's line-by-line review** (Policy Service rules).

### Assumptions the engine makes, for the lead to confirm
1. Tax reserve base: `tax_reserve total / (payouts + tax_reserve total) >= min_tax_reserve_bps / 10000`.
2. `conversion` actions count towards no cap and are not in the tax base.
3. `OVER_SOFT_LIMIT` is never reported next to a hard-cap failure, because rejected wins.
4. The caller computes `spentTodayBaseUnits` for the current UTC day; the engine only adds this proposal to it.
5. The duplicate check hashes the proposal only, not the trace id.
6. A schema-invalid proposal returns only `SCHEMA_INVALID`.

### Gaps in INTERFACES.md found while building it (not changed; for the lead)
- `vault_min_reserve` has no Policy Service rule and no reason code. The engine only validates the field; the
  on-chain guard is meant to enforce the floor.
- The base of `min_tax_reserve_bps` is not defined (assumption 1).
- Items of `flags` allow extra keys (no `additionalProperties: false`).

### Housekeeping
- Local worktree directories are ignored.

---

## 2026-11-12 — Session 005: contract review findings; wallet script fix

A read-only reviewer helper agent (own worktree, no edits) checked the escrow, token, scripts and
ChainClient against the trust boundaries in the project rules file and INTERFACES v0.3. It ran the 38 contract tests (pass)
and found no mismatch between MilestoneEscrow and INTERFACES v0.3. Its findings are below. Only R6 was fixed in
this session; the rest wait for the lead, because the escrow is under line-by-line review.

### Findings
| # | Severity | Finding | Status |
|---|---|---|---|
| R1 | medium-high | **Approved has no exit except `release`.** If the RELEASER key is lost or revoked, the identity hold never clears, or a card chargeback happens during the hold, the funds stay in the escrow for good. `holdSeconds` has no upper bound. A vault that cannot receive the token strands funds the same way. | Open: needs a design decision (rescue path) |
| R2 | medium | `dispute` and `approve` do not check the timeout. After the timeout but before anyone calls `refund`, the provider can dispute and push the refund out 7 days. | Open |
| R3 | medium | `createAndFund` is open to anyone and the id is global. An attacker who sees the treasury transaction can create the same id first with 1 base unit and their own vault: the real funding reverts, and a backend that trusts the state alone could treat the attacker milestone as the real one. | Open |
| R4 | medium | Timeout, arbiter and vault are chosen by the funder and not checked on-chain (timeout only has to be in the future). In our flow the funder is the treasury, so the backend carries this. | Open |
| R5 | medium | ChainClient idempotency: (a) a key reused with a different call silently returns the first transaction; (b) a key stays bound to a transaction that failed on-chain or was dropped; (c) a crash between send and record leaves the key claimed with no hash and no way to resolve it; (d) the allowance sub-key and exact-amount approval break on retry or on two fundings in parallel; (e) keys are not scoped by sender. No double-send path was found. | Open |
| R6 | low-medium | `gen-wallets.ts`: the "do not overwrite" regex was built in a template literal, so `\s` became `s`. A key line with trailing whitespace was not recognised, deleted and replaced with a new random key. That could have destroyed the funded treasury key. | **Fixed** |
| R7 | low | Scripts print raw error objects; an ethers error can include the RPC URL, which may carry an API key. | Open |
| R8 | low | "Test network" is only the `testnet: true` flag; the RPC chain id is never checked against the config; no deny-list of mainnet chain ids. | Open |
| R9 | low | `createAndFund` accepts the escrow or token address as vault or party. | Open |
| R10 | note | Confirmed in the ethers source: `NonceManager` increments its nonce before sending and does not roll back on a failed send, so a retry after a reverted gas estimate leaves a nonce gap. Used only in the proof script today. | Open |
| R11 | note | TestUSDT has only the v/r/s form of `transferWithAuthorization`; some x402 facilitators expect the `bytes signature` form, `receiveWithAuthorization` or `version()`. Check against the facilitator Person B picks. | Open |
| R12 | note | Attestations have no deadline and no ERC-1271 support (by design in v0.3). | Open |

The reviewer also listed missing tests (boundary timestamps in decide, role grant and revoke, the
`AuthorizationNotYetValid` path, the ChainClient allowance path and SQLite persistence, among others).

### What the reviewer confirmed as correct
State is written before every transfer; no reentrancy path. No single key can send escrowed funds anywhere
except the stored vault or the funder. RELEASER can only release Approved milestones to the stored vault and
cannot skip the card hold. Admin can only manage roles. Attestation replay across milestones, chains and
contracts is blocked; role confusion and duplicate signers are blocked. Refund and decide do not overlap at the
exact timeout.

### R6 fix: contracts/scripts/gen-wallets.ts (key handling, needs the lead to read the diff)
- Parses `.env` line by line instead of with a built regex. A role whose variable is already there is kept
  untouched; if its value is not a valid key the script stops with an error and writes nothing for that role.
- Append only: it never rewrites or deletes a line, and starts a new line first if the file does not end with one.
- `TETHRAN_ENV_FILE` lets a test point it at a scratch file.
- Checked on a scratch file: a key with trailing whitespace and a last line without a newline were both kept;
  a bad value stopped the script and left the file unchanged. The real `.env` hash was the same before and after.

---

## 2026-11-12 — Session 006: review fixes (R1 to R10), interfaces v0.4, Sepolia redeploy

The lead accepted R1 to R5 and R7 to R10, skipped R12, and left R11 to Person B. Also decided: the tax-reserve
base is the gross milestone payout amount, and `vault_min_reserve` is enforced by the Policy Service as well as
the guard.

### 1. MilestoneEscrow
| Finding | Change |
|---|---|
| R1 stranded funds | New `refundApproved`: (1) the RELEASER may refund to the funder only while the card hold runs (chargeback); (2) the funder may refund once `approvedAt + hold + RELEASE_GRACE` (3 days) has passed without a release. `holdSeconds` is capped at `MAX_HOLD` (30 days). |
| R2 late approve or dispute | `approve` and `dispute` revert with `TimeoutReached` once `now >= timeout`. |
| R3 front-running | `createAndFund` needs the new `FUNDER_ROLE` (the treasury). Constructor is now `(usdt, admin, releaser, funder)`. |
| R4 funder-chosen timeout | `timeout` must be at least `now + MIN_TIMEOUT` (1 day). |
| R9 unusable addresses | Vault and parties may not be the escrow or the token (`InvalidAddress`). |

- In case (2) and in `release`, the hold counts as 0 unless the milestone is card-funded.
- `refund`, `decide(false)` and `refundApproved` share one private `_refund`.
- Mine, for the lead to confirm: `MIN_TIMEOUT` is 1 day. A live timeout refund can therefore only be shown on
  the local chain (where the clock can be moved), not on Sepolia.
- Tests: 68 passing (was 38). New: every reviewer-listed gap for the contracts (exact boundaries of timeout,
  hold, grace and decide window; each zero address; each party overlap; role grant and revoke; the revoke-all
  rescue; decide on missing, Released and Refunded milestones; high-s and compact signatures; a balance
  invariant across three milestones; TestUSDT `AuthorizationNotYetValid`, window boundaries, per-authorizer
  nonces, wrong domain).
- Found by a test: OpenZeppelin `ECDSA.recover` accepts only 65-byte signatures. Compact 64-byte signatures are
  rejected. Documented in INTERFACES.

### 2. ChainClient (R5, R8, R10)
- **R5a** each key stores a hash of the call; the same key with a different call throws `IdempotencyKeyReuseError`.
- **R5b/c** `resolve(key, { txHash? })`: frees a key only when the chain shows the transaction reverted, or that
  it never landed (not mined, not in the mempool, key older than 2 minutes, nothing pending from the sender).
  A key with no recorded hash is freed only if the sender has mined nothing since it was claimed; otherwise
  the operator must supply the hash, which is accepted only if it is that sender's exact call.
- **R5d** the escrow allowance is approved once without a limit.
- **R5e** keys are scoped to the sending address.
- Sends from one client run one at a time.
- Mine, for the lead to confirm: a key is also released when the node answers `NONCE_EXPIRED` or
  `REPLACEMENT_UNDERPRICED`. In both cases the node refused the transaction, so nothing was broadcast; keeping
  the key claimed would leave it stuck with no hash to resolve.
- **R8** the client checks `eth_chainId` against the config before any read or write, and a deny-list of
  mainnet chain ids (`config/mainnet-chain-ids.json`) overrides `"testnet": true`. Same guard in the Hardhat
  config and the scripts.
- **R10** no `NonceManager` anywhere now, including the proof script. The provider is created with the ethers
  response cache off (see errors below).
- New: `milestone()` read and `assertMilestoneMatches` (the backend check after each funding), `refundApproved`.
- Tests: 27 passing (was 9).

### 3. Scripts (R7)
- `contracts/scripts/lib/safety.ts`: errors are printed as a short message with URLs removed; the same helper
  is exported from `services/chain`.
- `deploy.ts`: refuses the in-process Hardhat network, sets nonces explicitly and waits `confirmations` blocks.

### 4. Policy Service
- Tax reserve: `tax_reserve total * 10000 >= min_tax_reserve_bps * grossAmount`, where `grossAmount` is the gross
  milestone payout amount supplied in the context.
- New rejected code `BELOW_VAULT_RESERVE`: `vaultBalance - payouts >= vault_min_reserve`. Tax reserve and
  conversion amounts stay in the vault. Rule order: ... daily cap -> vault reserve -> tax reserve.
- The engine throws on a non-numeric context amount.
- Tests: 59 passing (was 55).

### 5. INTERFACES.md v0.3 -> v0.4
FUNDER role and constants; `refundApproved`; `milestone()`; approve and dispute before the timeout; the stablecoin
deposit-address demo simplification; backend duties (choose arbiter and vault, verify after funding); 65-byte
signatures; `BELOW_VAULT_RESERVE` and the new rule order; the tax-reserve base; `ChainClient.refundApproved`,
`milestone`, the idempotency rules, `resolve`, and the chain-id check.

### 6. Sepolia redeploy
- TestUSDT (test token) `0x6DF2B5Ff896df820EDC0C563b0DA2ABD93228aeB`, MilestoneEscrow
  `0xb6225C0478d26EF07C7F2F95E82603dd385a61Ed`. The earlier escrow `0x55CC…A513` is abandoned.
- Proof passed on the new escrow: createAndFund `0xf00a0e8a…`, approve `0xb43f8f21…`, release `0x4ab91a9c…`.
  One progress line showed the old state right after approve (a lagging RPC node on a display read); the final
  check read Released and the correct balance.

### 7. Not done in this pass
- "Arbiter and vault chosen in the backend with tests": the backend (treasury service) does not exist yet. The
  check it must run after funding exists and is tested (`assertMilestoneMatches`); choosing the arbiter and vault
  is logged as a requirement for the treasury service.
- R11 (TestUSDT surface for x402) is Person B's; R12 skipped.

### 8. Vault and guard
Design notes only, no code: `docs/notes/vault-guard-design.md`, with seven points marked for decision.

---

## 2026-11-12 — Session 007: escrow minTimeout, ProviderVault, interfaces v0.5, Policy API, LlmProvider

### 1. Lead decisions
- Escrow design changes approved. `MIN_TIMEOUT` becomes a constructor parameter. Releasing a key when the node
  refused the transaction: keep. `BELOW_VAULT_RESERVE` ordering: fine. Treasury reclaim of Approved milestones:
  keep, documented in the README as a trust assumption.
- Vault: guard merged into the vault; operator-signed signer rotation; operator-signed withdrawal to the
  provider's fixed address; per-action id consumed once. For the other four design points I went with my
  recommendation: payees set in batches (`setPayees`), policy changes take effect at once, the operator is the
  provider or agency admin, plain deployment per provider (no factory).
- LLM provider: Groq then Gemini (optional NVIDIA) behind one `LlmProvider` interface.

### 2. MilestoneEscrow
- `minTimeout` is an immutable set in the constructor (`(usdt, admin, releaser, funder, minTimeout)`), must be
  non-zero. 1 day in tests; `config/chains.json` `minTimeoutSeconds: 600` for Sepolia.
- Redeployed to Sepolia: TestUSDT (test token) `0xE2D587DD9ad01C91DFf0baABc120192C516b9879`, MilestoneEscrow
  `0x172AE76568ba8F83dc7584D2a161713200d9b278` (minTimeout 600 s). Proof passed on it: createAndFund
  `0xdfc43c1b…`, approve `0x0c2b4a94…`, release `0xfecc682d…`.
- The first proof run on the new escrow failed: `approve` reverted at gas estimation because a public RPC node
  had not yet seen the funding block. `ChainClient` now asks again up to twice (5 s apart) when gas estimation
  reverts on a chain with `confirmations > 1`. Nothing is broadcast in that case, so this is safe.

### 3. ProviderVault (new, needs line-by-line review)
`contracts/contracts/ProviderVault.sol`, about 230 lines with comments. No `msg.sender` checks: every action is
authorised by EIP-712 signatures and anyone may submit.
- `execute(to, amount, proposalHash, actionId, agentSig, policySig)`: both co-signers over the same `Transfer`
  typed data; the action id is consumed once; then the guard; then the transfer.
- Guard, one function used by both `execute` and the `check` view: payee allowlist, per-transaction cap, daily
  cap per UTC day, balance floor. Reverts with `GuardBlocked(reason)`; reason names match the Policy Service codes.
- Operator actions share one version counter (`version == policyVersion + 1`): `setPolicy`, `setPayees`,
  `rotateSigners`, `withdrawToProvider`.
- `withdrawToProvider` pays only the provider address fixed at deployment, ignores the limits and does not
  count towards the daily cap.
- Operator, agent signer and Policy signer are always three different addresses (checked at construction and
  on rotation). A new vault has version 0 and limits 0, so it pays nothing until a policy is signed.
- Tests: 36 (105 contract tests in total). They cover: one key in both slots, swapped slots, stand-in signers,
  signatures for a different recipient, amount, proposal, action, vault or chain; every limit at its exact
  boundary; the UTC-midnight reset; reserve after a top-up; a payee removed after signing; version replay,
  skip and reuse across action types; a payee list that differs from the signed one; rotation; the escape
  withdrawal with no policy set; and an escrow -> vault -> payees balance check.
- **Not done:** not deployed; `ChainClient` vault calls still throw `NotBuiltYetError` (they follow once the
  vault is approved, because they depend on its ABI).

### 4. INTERFACES.md v0.4 -> v0.5
`ISpendingGuard` replaced by `IProviderVault` with its typed data and rules; `ChainClient` vault calls
(`vaultExecute` with `proposalHash` and `actionId`, `setPolicy`, `setPayees`, `rotateVaultSigners`,
`vaultWithdraw`, `vaultState`, `vaultCheck`); section 2a co-signatures (one per payout action, `action_id`
definition); `vaults` table columns; escrow `minTimeout`; the treasury trust assumption; section 7 `LlmProvider`.

### 5. Policy Service HTTP API and co-signing (helper agent, own worktree; brought onto main and checked)
- `src/cosign.ts` (the only file that touches the signer object), `src/service.ts`, `src/stores.ts`,
  `src/typed.ts`, `src/http.ts` (`node:http`, the seven routes, 127.0.0.1), `src/main.ts`.
- A decision is written to the audit log and the decisions store before anything is signed.
- Checked in the main session: the branch touched only `services/policy`; the engine, audit log and their tests
  are unchanged; typecheck clean; 104 tests pass; `cosign.ts` read and its typed data matches the vault.
- **Stubbed and labelled:** the chain reader in `main.ts` (fails every read) and the chain writer (records calls).
  The service cannot serve real proposals until those are wired to `ChainClient`.
- New dependency in services/policy: `ethers`.

Interface gaps it found (not changed; for the lead):
1. What the operator signs for `POST /v1/policy` and for an approval decision is not defined. It uses a
   `TethranPolicy` domain with `PolicyDocument(version, policyHash)` and `ApprovalDecision(...)`. That domain has
   no chain id, so a signature could be replayed on another deployment.
2. That signature cannot be passed to the vault: `setPolicy` and `setPayees` need their own typed-data
   signatures. Today the operator would have to sign two or three times for one policy change.
3. `POST /v1/attestations/verify` has no `release_to_provider` field, which the typed data needs; the service
   requires it.
4. A proposal whose signing failed is already recorded, so a retry is `DUPLICATE_PROPOSAL`; recovery needs a design.
5. Two proposals approved before either lands on-chain can both pass the daily-cap check; the vault still
   blocks the second on-chain.
6. Response shapes for the approvals queue and whether `proposal_hash` carries `0x` are not specified.

### 6. services/llm (helper agent, own worktree; brought onto main and checked)
- `LlmProvider` per section 7; adapters for Groq, Gemini and NVIDIA using `fetch` (no vendor SDKs); a router with
  the retry, 429 and three-attempt rules; a tracer interface with an Opik adapter; `proposeSettlement` that
  always returns either a valid proposal or a rejected `SCHEMA_INVALID` result; `redact()`; the system prompt;
  nine seeded scenarios and `npm run eval:agent`.
- Checked in the main session: only `services/llm` touched; typecheck clean; 33 tests pass; `eval:agent` prints
  nine SKIPPED lines without keys and nine PASS lines with the built-in fake provider.
- **Not verified at all:** the real Groq, Gemini and NVIDIA calls, any real model's answers to the scenarios, and
  the Opik adapter (written without an account to test against). No API keys exist on this machine.
- New dependencies in services/llm: `ajv`, `opik`.
- `.env.example` gained the LLM variable names.

### 7. Housekeeping
- Helper agent commits were cherry-picked so history stays linear with plain messages; the worktrees are removed.

---

## 2026-11-12 — Session 008: vault review fixes, interfaces v0.6, vault wiring and Sepolia deploy, Alchemy, Gemini

- Commit message reworded: "ignore local worktree directories" (history rewritten before any push).
- Vault (lead review): comment, INTERFACES and README now say the operator key is effectively the owner and a
  compromised operator can drain the vault; the fixed provider address only constrains withdrawToProvider.
  Transfer typed data and execute() take a deadline (Policy Service signs now + 15 min). setPayees rejects the
  zero address, the vault and the token. Documented: UTC-day cap boundary, immutable operator, pause by zero caps.
  45 vault tests, 114 contract tests.
- Policy Service: co-signatures carry the deadline; DUPLICATE_PROPOSAL only for a hash that has co-signatures or
  is pending approval; a proposal whose earlier decision produced no signatures may be resubmitted. 108 tests.
- INTERFACES v0.6: deadline; operator-is-owner; POST /v1/policy takes the vault's own operator signatures
  (section 2b, off-chain-only fields still open); release_to_provider on attestation verify; duplicate rule.
  The Policy Service code still uses its own policy typed data: not yet changed to v0.6 section 2b.
- ChainClient: vaultExecute, setPolicy, setPayees, rotateVaultSigners, vaultWithdraw, vaultState, vaultCheck,
  vaultActionId, VAULT_TYPES. 29 tests.
- Sepolia: demo ProviderVault 0xeE59D8994620A9125641b36848A636E04e24feA8. prove:slice passed: 100 tUSDT released
  into the vault, 40 paid with two co-signatures, 61 refused (OVER_PER_TX_CAP). Co-signatures made by the script
  with test keys, not by the running Policy Service.
- Alchemy: only the alchemy-api skill kept (agentic-gateway and the other bundled skills removed); .agents/ and
  skills-lock.json git-ignored; RPC_URL_11155111 in .env points at the Alchemy Sepolia endpoint; chain-id check
  kept; no endpoint or key in any output.
- Gemini: model list fetched with the key. gemini-2.5-flash is retired for new users (404); gemini-3.8-flash
  returned 503 high demand; gemini-3.5-flash returned schema-valid JSON and passed all nine eval scenarios
  (1 attempt each). gemma-4-31b-it failed all nine (SCHEMA_INVALID, 626 s). Chosen: gemini-3.5-flash.
- Not done: ReceiptNFT, treasury service, full slice through the services, Policy Service section 2b, Opik.
