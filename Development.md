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

---

## 2026-11-12 — Session 009 start

- Added the missing `session_008` object to `Build-Context-Memory.json` (it was not written when session 008 hit
  the usage limit).
- Checked for existing work: no remote branches, every commit is ours. Sarah's app and backend are not in this
  repo, so the backend endpoints the slice needs are built here and listed in `docs/API.md`.
- Lead decisions: off-chain policy fields (soft limit, tax share, confidence threshold, hold length) are signed
  by the operator with the Policy Service's existing policy typed data; on-chain limits use vault-format operator
  signatures relayed by the Policy Service. `gemini-3.5-flash` approved; Groq stays as fallback once its key and
  model are set. Opik cloud.

### Block 1: the full slice through the real services

**Opik.** `OPIK_WORKSPACE` was set to "Tethran", which Opik rejected ("No such workspace"). The key can access the
workspaces `benedict258` and `tenax`; `.env` now uses workspace `benedict258` and project `Tethran`. One test trace was
written and read back (`npm run opik:check`). The tracer was rebuilt: one trace per run, a span per LLM attempt
(provider, model, latency, attempt, tokens) and per tool call, through AsyncLocalStorage; no prompts or keys sent.
The first trace after start-up was lost until each run flushes when it ends. `eval:agent`: nine traces in Opik.
On the second eval run four scenarios hit Gemini's free-tier HTTP 429 (no retry loop, as instructed); the runner
now waits 8 s between scenarios.

**LLM.** Groq key present: model chosen from the Groq model list, `openai/gpt-oss-120b` (schema-valid JSON in one
call, 1.5 s). The lead set **Groq first, Gemini fallback** (`LLM_PROVIDER_ORDER=groq,gemini`).

**ReceiptNFT** (`contracts/contracts/ReceiptNFT.sol`, needs review): soulbound ERC-721; MINTER role (treasury);
one per milestone (reverts on a second); chain id must be this chain; no empty fields; stores milestone id,
invoice hash, settlement hash, amount, chain id, release tx and mint time; self-contained JSON `tokenURI`; no
transfer, approval or burn. 8 tests (122 contract tests). Deployed on Sepolia at
`0x596B49052701d5B83F2098b055C10c08f314d209`. `ChainClient.mintReceipt` and `receiptOf` wired.

**Backend** (`services/backend`, new; money-moving code, needs review):
- `treasury.ts`: creates milestones (backend picks the platform arbiter and the provider's vault, vault checked
  on-chain); funds after a verified Stripe event or a confirmed stablecoin deposit; idempotent on the payment
  reference and the escrow id, with the absolute timeout fixed at the first attempt so a retry sends the same
  call; post-funding check of the on-chain milestone; release after the simulated identity check; refund after
  the timeout or the funder rescue; chargeback during the card hold refunds the escrow, after it flags a human.
  Card payments are converted to test USDT at 1:1 (simulated). The off-chain refund leg is simulated.
- `stripe.ts`: Stripe-Signature verification (HMAC-SHA256, 5-minute tolerance, any matching v1); event ids recorded.
- `agentSigner.ts`: the agent signer module; signs a vault transfer only if the Policy Service already signed the
  same transfer (checked against the vault's policySigner on-chain) and the deadline is valid.
- `orchestrator.ts`: agent -> Policy Service -> agent signer -> vault -> receipt, one trace per run; payouts are
  stored with their co-signatures so a run that stops part-way resumes without a new proposal.
- `http.ts`, `main.ts`: the API in `docs/API.md`; internal routes for the Policy Service behind a shared token.
- 26 tests.

**Policy Service** now reads the chain (`src/chainReader.ts`): vault, gross amount, card funding and release state
from the escrow; spent today and balance from the vault; payees and identity from the backend's internal routes.
Relaying vault-format operator signatures through `POST /v1/policy` is still a labelled stub (operator console block).

**Key separation.** Each service loads only its own variables from `.env` (`loadEnvOnly` in `services/chain`); the
slice runner starts each service with an explicit environment and passes no other secrets.

**Full slice** (`npm run slice`): passed on the local chain and on **Sepolia**: deposit `0x89be8ab3…`, escrow funded
`0xdf5af18a…`, client approved `0x4dc2eee2…`, released `0x11f43af8…`, settlement approved by the Policy Service,
payouts `0x5472d075…` (60 to a USDT payee) and `0x085b9626…` (30 to a simulated M-Pesa rail wallet), receipt token
#1 to the provider. Opik trace `01a1cda7-bea5-74de-8063-77cdf30ab174` with 9 spans, including the Groq call.

**Errors on the way:** a false `HOLD_ACTIVE` on a stablecoin milestone (block time ahead of the wall clock; the
check now applies only to card-funded milestones); a settlement rejected as `SCHEMA_INVALID` that was really a
Gemini 429 (the API now says which layer rejected and why).

**Not done in Block 1:** real Stripe sandbox (no Stripe keys; webhook tested with locally signed events);
treasury actions are not traced in Opik (only the settlement run); identity record missing = treated as a match
(Block 3 makes the identity check strict); `docs/API.md` written.

---

## 2026-11-12 — Session 010: Block 2

### Lead decisions applied
Opik project `tethran` (workspace `benedict258`); test trace written and read back. Stripe mocked: a Simulated
checkout behind the same interface as the real Stripe path. Groq primary, Gemini fallback; replay mode with a
live toggle. Known gaps closed now: Opik tracing of treasury actions, execute endpoint for approved escalations,
on-chain limit relay through `POST /v1/policy`. Strict identity check stays in Block 3.

### On-chain limit relay (demo-critical)
- `services/policy/src/vaultActions.ts` (needs review): parses and checks operator-signed vault actions. Every
  signature must recover to the vault's on-chain operator, which must be the operator the Policy Service trusts;
  versions continue from the vault's on-chain version; after the actions the vault's limits must equal the
  document's `per_tx_cap`, `daily_cap`, `vault_min_reserve` and every allowlisted payee must be allowed on the
  vault, otherwise 409. Off-chain-only fields are covered by the operator's `PolicyDocument` signature.
- The actions are relayed through the backend (`POST /internal/vault-actions`, treasury pays gas, adds no
  authority) and confirmed before the policy becomes active; if the relay fails the policy does not change.
- Policy Service tests: 117 (9 new for the relay).
- Sepolia: the slice runner now sets the vault limits through `POST /v1/policy`; then the operator lowers the
  per-transaction cap from 1000 to 5 and the vault refuses a 6 USDT payout (`OVER_PER_TX_CAP`) that it allowed a
  moment earlier; then the cap is restored. Relayed transactions `0x234c3015…` (setPayees v6) and `0x2bba4645…`
  (setPolicy v7).

### Simulated checkout (`services/backend/src/checkout.ts`)
- `CheckoutProvider` with two implementations. Real Stripe Checkout Sessions over Stripe's REST API (no SDK),
  off until `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set; request shape unit-tested, never called.
- Simulated: completing a session signs a Stripe-format `checkout.session.completed` (or `charge.dispute.created`)
  event and passes it to the same `handleStripeWebhook`, so signature, once-only and amount checks run for real.
  Methods: card, Apple Pay, Google Pay, PayPal, Cash App Pay (Stripe), stablecoin (treasury deposit). Labelled
  "Simulated" in code, responses and docs/API.md. The simulated webhook secret is random per process.

### Agent modes (`services/backend/src/replay.ts`)
- `live`, `replay`, `live+replay` (default). Replay serves a saved proposal for the milestone's scenario, scaled
  by parts per million of the gross amount, labelled "Replay" with its source; it still goes through the Policy
  Service. `replay/proposals.json` is generated from the nine scenarios' expected replies (`scripts/make-replay.ts`),
  so it is curated, not model output.

### Escalations, summaries, tracing
- `POST /milestones/{id}/escalations/{approvalId}/execute`: operator-signed decision -> Policy Service re-runs the
  rejecting rules and co-signs -> payouts and receipt. Resumes, never pays twice.
- `POST /milestones/{id}/evidence/summary`: advisory evidence summary, traced.
- Treasury actions are each one Opik trace with chain calls as spans (`src/traced.ts`); trace ids in responses,
  in `fundings.trace_id`, `milestones.release_trace_id` and the new `treasury_actions` table.

### Contracts, country profiles, invoicing (helper agent; cherry-picked and checked)
`src/contracts.ts`, `src/countryProfiles.ts`, `src/invoices.ts`, `src/contractRoutes.ts`: contracts with a keccak256
terms hash, EIP-712 signatures by both parties (`TethranContract` domain), terms frozen once signed, milestone
state mapping from the escrow table; NG, KE, ZA, GH profiles as data with `rates_verified: false` tax placeholders;
USD invoices with country fields, fee-payer choice (placeholder fee 1% + 30 cents), public pay payload and QR data
without personal data, receipts, recurring issuance and simulated reminders. Funding marks the linked invoice paid.
24 tests. Open points it raised: the escrow amount is the milestone amount even when the client pays the fee;
recurring occurrences get derived escrow ids but are not activated automatically; country rails were assigned by
the helper agent (the PRD does not list them).

### Settlement Agent (helper agent; cherry-picked and checked)
Final system prompt (`PROMPT_VERSION 2026-11-12.1`) in the six-part skeleton; input guards (deterministic injection
detection, redaction, per-call random delimiters, size limits) recorded as guardrail spans; post-checks (unlisted
payee, invalid amount, total above gross, tax below the minimum) that add flags and force `needs_human`, never
removing actions; evidence summaries; read tools and simulated paid-data tools with a spending cap (single-shot:
inputs gathered first, one model call); Opik dataset `tethran-agent-scenarios`, deterministic metrics, an
LLM-as-judge through the router, and `npm run eval:experiment`. 59 tests.

### Real model runs (kept few, free tiers)
- `eval:agent` on Groq (before the new prompt): **8 of 9 passed**, prompt injection included; `identity_mismatch`
  failed because Groq failed once and the Gemini fallback answered 429.
- Experiment `agent-2026-11-12.1-20261112T0341` (new prompt): 4 of 9 produced a proposal, all four passed the
  deterministic checks; the other five hit 429 on both providers. Judge average 0.63 over the four. The judge then
  got the payee network and verified names (prompt `2026-11-12.2`), checked offline only.

### Sepolia slice (after all of the above)
Passed with the live agent (Groq): deposit `0xf1cd6a68…`, funded `0xa6c178d7…`, approved `0x087f3f72…`, released
`0x4cdd0cb6…`, payouts `0x1047235b…` (60) and `0xac867248…` (30, simulated M-Pesa rail), receipt token #2, limit
change enforced, trace `01a1cdeb-6e3c-7158-bcf9-27116d760494`.

### Errors on the way
- Sepolia RPC timeouts ("request timeout") made two slice runs fail at the limit relay (nothing changed, nothing
  paid). `newProvider` now returns `RetryingJsonRpcProvider`: 20-second request timeout, read-only RPC methods
  retried up to three times; `eth_sendRawTransaction` is never resent.
- The first limit-change check asked about 60 USDT when the vault held 10, so the balance floor blocked it before
  the cap did; the check now uses an amount within the balance.

### Test counts
Contracts 122, ChainClient 29, Policy Service 117, LLM 59, backend 65.

---

## 2026-11-12 — Session 011: Block 3 and WDK wallets

### A. WDK wallets (track requirement)
- `services/chain/src/wdk.ts`: user wallets on Tether WDK. **Modules used:** `@tetherto/wdk` 1.0.0-beta.22 (core:
  seed-based wallet registry and its transaction-policy engine) and `@tetherto/wdk-wallet-evm` 1.0.0-beta.26
  (BIP-44 derivation, native and token balances, fee quotes, token transfers, raw transactions, EIP-712 signing).
- Roles from one BIP-39 test seed (`DEMO_WALLET_SEED`, generated by `npm run wallets`, never printed): client,
  payee_amara, subcontractor, client_b. A WDK policy on the wallet allows only test-USDT transfers up to a cap,
  raw transactions only to the escrow with no ETH, and EIP-712 signing; WDK denies anything else
  (verified in a spike: a non-USDT transfer and a raw send elsewhere both raised `PolicyViolationError`).
- The WDK account plugs into `ChainClient` as a `TxSender`, so the client's escrow approve and dispute are signed
  by WDK without changes elsewhere. Treasury, Policy Service, agent signer and operator keys are unchanged.
- **What WDK could not do here, or was not used for:**
  - the two-of-two vault: WDK's base package defines multisig interfaces (propose, approve, execute) but no EVM
    implementation is installed with these packages; our ProviderVault does that job;
  - gasless transfers: not used (they need a bundler and paymaster); users pay test ETH;
  - the WDK policy engine guards a user's own wallet only; the platform's limits stay in the Policy Service and the
    vault. Phase 0 recorded "no WDK policy hooks": the installed WDK core does have one, and we use it.
  - self-custody: in this API-only build a demo wallet service holds the test seed (labelled "demo custody");
    WDK in the user's app is the product path.
- `services/backend/src/wallets.ts`: review (recipient with saved name, network, amount, fee shown separately,
  every block reason), send (blocks duplicates while the payment reference is pending or done, detects a wrong
  network before signing by the app's chain id and the RPC's real chain id, claims the reference before signing so two
  requests cannot both send, frees it only when WDK refused or the transaction failed on-chain), status (rechecks the
  same hash, never resubmits). Escrow approve and dispute, and dispute attestations, signed by the role's WDK wallet.
  A read-only fee estimate is retried twice (a lagging RPC node had not seen a fresh balance on Sepolia).

### Block 3
- **Identity (strict, simulated):** no identity record is now a hold, not a match. A held release opens an identity
  hold; the vault's operator decides it with an EIP-712 `IdentityDecision` signature; "release" releases at once.
  `POST /milestones/{id}/identity` is the simulated verification provider.
- **Payout adapters and phone registry** (helper agent, cherry-picked and checked): MobileMoneySim (M-Pesa, MTN MoMo,
  Airtel), BankSim, UsdtSim behind the INTERFACES section 6 interface, with simulated fees, FX and a status flow
  (pending -> processing -> delivered | failed, forced failures for the demo). The off-chain leg starts after each
  approved settlement. Phone registry stores only an HMAC of the E.164 number, needs explicit consent and honours
  withdrawal; resolve returns a masked number. All labelled simulated. Placeholder rates and fees.
- **Reconciliation** (helper agent): per-milestone ledger with gaps, list, failure and suspicious queue, tax-ready CSV.
  Country comes from its own meta table; wiring it to the contract's country profile is still open.
- **Operator and arbiter endpoints:** operator queue (identity holds, Policy approvals, reconciliation link);
  arbiter disputes list, attestation typed data, attestation collection; two agreeing parties trigger `escrow.decide`.
- **Docs:** PRD and architecture document updated by a helper agent to INTERFACES v0.6 with "What changed" notes; its
  worktree started from the last pushed commit, so its status lines are being corrected for Blocks 2 and 3.

### Sepolia run
Slice passed: WDK client deposit `0x178ef90b…` after a review blocked for the wrong network and a refused duplicate
send; escrow funded; approve `0x42dadb16…` signed by WDK; identity verified (simulated); release; live agent (Groq);
payouts 60 to the WDK payee and 30 to the simulated M-Pesa rail; two off-chain legs started; receipt token #4; the
operator lowered the cap and the vault blocked a payout it had allowed. Trace `01a1cec2-f0ae-70fc-a769-61cd50460ff4`.
Two earlier runs failed for read lag (WDK fee estimate before the RPC saw the mint; the script reading the vault one
block after the relay): both handled, nothing paid wrongly.

### Test counts
Contracts 122, ChainClient 29, Policy Service 117, LLM 59, backend 107.

---

## 2026-11-13 — History rewrite (approved exception)

The lead approved one exception to "never edit a previous session object": tool names were neutralised in every
commit's version of `Build-Context-Memory.json` and `Development.md`, and the ignore entry for the local tool folder
was moved from `.gitignore` to `.git/info/exclude` (local only, not committed).
- Backup first: tag `pre-rewrite-backup` points at the old history (local; never to be pushed).
- Rewrite: `git filter-branch --tree-filter` over all 57 commits of `main`; the meaning of every entry is unchanged
  (for example "executing engineer" and "helper agent" replace the tool and model names).
- Verified with a full-history grep: no tool or model names in commit messages, in the memory file or in this log,
  apart from references to the file name the project rules file.
- Still in history and left as they are (outside the approved scope): the lead's the project rules file and the working guide
  (the file name and their no-attribution rules) and one early line of the architecture document.
- Nothing pushed. The remote still has the 39 pre-rewrite commits from the first push; pushing the rewritten
  history will need a force push when the lead decides.

---

## Session 012 — 2026-11-13 — Reconciliation country, Block 4 (seed, x402, README, DEMO)

### Reconciliation country (lead's decision)
- The country now comes only from the contract's country profile, through the escrow milestone's invoice. No
  fallback to a payout leg, no `UNSPECIFIED`. A milestone without one has `country: null` and an info gap
  `NO_COUNTRY_PROFILE`; `export.csv` refuses with `409 NO_COUNTRY_PROFILE` naming the milestones. Tests: 2 new.

### x402 (timeboxed; real settlement, demo data)
- `services/backend/src/x402.ts`: four paid resources (corridor rules, FX quote, invoice status, settlement proof),
  402 with an exact-scheme requirement, X-PAYMENT verification (network, payee, amount, window, signature, nonce),
  settlement through ChainClient `submitTransferWithAuthorization` on TestUSDT, X-PAYMENT-RESPONSE, replay-safe.
- The x402 npm SDK and hosted facilitators are not used: they settle USDC on their own networks, not our test
  token. This backend is its own facilitator. The data served is demo data and labelled.
- Agent purchase tool: the orchestrator (never the model) buys corridor rules and an FX quote before the model call,
  paying from the WDK `agent_budget` wallet. Caps: 0.05 tUSDT per run in the client (refuses before signing) and
  1 tUSDT per authorization in the WDK signing policy. Failures never block a settlement. Nothing bought in replay.
- WDK `signTypedData` policy tightened: only escrow attestations, contract signatures and small test-USDT EIP-3009
  authorizations (it allowed anything before). Tests: 4 backend x402 tests, 1 WDK policy test.

### Seed script
- `npm run seed` (DEMO_MODE=1 only): wipes `.demo-data/` only, deploys the contracts on a fresh local node, seeds
  the vault and payees, operator-signed policy, starts both services, signs a KE contract (provider key and WDK
  client wallet), and drives the nine scenarios through the API. Handled failure: duplicate deposit send refused
  (`DUPLICATE_PENDING`), second settle pays nothing. Wrong network: review for the other configured test network is
  blocked (`WRONG_NETWORK`). Prints a summary; `--serve` keeps the services up; `demo:serve` restarts them.
- `npm run demo:act`: presenter helper that signs the operator's identity decision and the 2-of-3 dispute
  attestations with test keys (no web app in this repo).
- Demo ports 18787/18788: 8787 is taken by another program on the lead's machine; the seed refuses busy ports.

### Bugs found by the seed and fixed
- `POST /milestones/{id}/settle` without `agent_mode` always ran `live`: the route passed `undefined` as the fallback,
  so `parseAgentMode`'s default parameter applied. Now the server's `AGENT_MODE` applies.
- The paid-data guard scanned its own wrapper, whose tool name matches the TOOL_REQUEST injection pattern, so any
  paid data flagged the input and dropped the agent's confidence. Now only the purchased data is scanned. Test added.
- `POST /milestones` accepts an optional `scenario` tag (selects the saved proposal in replay mode).

### Results
- Local chain, from nothing: 9 scenarios, 0 seed problems, in replay and in live+replay. Live: clean delivery
  approved, 2 vault payouts, receipt, x402 purchases settled on-chain.
- Every other settlement is `rejected TAX_RESERVE_TOO_LOW`: the Policy engine puts rejections before escalations, so
  a plan with no payouts and no tax reserve is rejected rather than escalated. Nothing is paid either way. Left
  for the lead (Policy rule, human review).

### Second chain
- Base Sepolia is in `config/chains.json`; the same deploy scripts take `--network baseSepolia`. Not deployed: the
  treasury has 0 Base Sepolia ETH (checked on two public RPCs). The wrong-network scenario uses the configured
  second chain's id.

### README and DEMO
- README rewritten: what it is, one-command run, architecture, simulated parts, trust assumptions, tests, WDK
  modules used and what WDK could not do. `docs/DEMO.md`: step-by-step journey, handled failure, reset commands,
  real versus simulated, fallback plan. `docs/API.md`: x402, seed, reconciliation country.

---

## Session 013 — 2026-11-13 — Policy rule order, second history rewrite, evaluation, app readiness

### Policy engine (lead's decision; for line-by-line review)
- The code firing on no-payout plans was `TAX_RESERVE_TOO_LOW`, derived from a zero tax reserve against the gross
  amount on plans that move no money. Fixed by the new rule order:
  - `SCHEMA_INVALID` always rejects.
  - Hard rules (duplicate, hold, payee, per-tx cap, daily cap, vault reserve, tax reserve) run only when the plan
    has money-moving actions (`payout`, `mobile_money_payout`); any violation rejects.
  - Escalation rules run for every plan: soft limit, low confidence, `needs_human`, identity mismatch, and the new
    `INJECTION_FLAGGED` (agent or guard injection codes). A plan that moves no money and triggers none of them is
    escalated `NO_PAYOUTS`: a plan that pays nobody is never approved automatically.
  - `needs_human=true` is never approved (an explicit last check as well).
- 15 branch tests (`services/policy/test/engine.branches.test.ts`); 3 older tests updated to the new behaviour.
  `docs/INTERFACES.md` reason codes and rule order updated (v0.7); the other workstream must be told.
- Open point: a human approving a `NO_PAYOUTS` escalation executes a plan with no payouts (receipt, no transfers).

### Paid-data regression test
- Real injection text inside x402 paid data is flagged by the guard and, through the agent, forces `needs_human`
  and an `INJECTION_SUSPECTED` flag; a tool name inside the purchased data still counts. Only our own label is exempt.

### Second history rewrite (approved)
- Backup tag `pre-rewrite-backup-2`. the project rules file and the working guide removed from every commit of `main` with an
  index filter; local copies kept and added to `.git/info/exclude`. Full-history grep: neither file in any commit;
  no tool names in messages. Remaining mentions are file-name references in the memory file and this log, one deleted
  line of an early architecture draft, and the plan's own no-attribution rule (reported to the lead).
- Secrets scan over `main` and all local refs: none of the 14 secret values in `.env` appear; no key, seed or API-key
  patterns; no `.env`, `.sqlite` or `.demo-data` file ever committed. Not pushed.

### Evaluation (live Groq openai/gpt-oss-120b, current prompt, small batches)
- 8 of 9 pass: clean_delivery, disputed_delivery, prompt_injection, over_limit_request, unknown_payee,
  low_confidence_plan, duplicate_send, wrong_network. identity_mismatch fails: the model did not flag the invoice
  issued under a different name (the prompt has the rule). Backstops: the backend's strict identity hold and the
  Policy Service's `IDENTITY_MISMATCH` escalation. Two scenarios first failed on provider network errors and passed
  on one retry.
- The runner takes `EVAL_ONLY` and `EVAL_SAVE_DIR`; outputs are in `services/llm/eval/out/`. `make-replay.ts` builds
  the replay file from passing real outputs: 8 real (each names its Opik trace), 1 curated (labelled).

### App readiness (no UI work)
- CORS for `http://localhost:3000` (`CORS_ORIGINS`), preflight included, never on `/internal`.
- `GET /milestones` and `GET /contracts` lists; the timeline's settlement plans include the agent's proposal,
  `agent_mode` and `approval_id`; operator approval typed data and a signed-decision relay to the Policy Service.
- `docs/API.md`: screen-to-endpoint map, CORS and error format, list endpoints, wallet roles and signing policy.
- `npm run demo`: one command starts the services (and the local chain if needed), seeds and keeps serving.

### Seed on Sepolia (new rules)
- 7 of 9 as intended; clean_delivery paid out with receipt #6; no-payout plans now escalated. Two scenarios failed on
  Sepolia RPC timeouts (`over_limit_request` deposit confirm; `prompt_injection` Policy Service chain read). Both
  services now log unexpected errors (sanitised); the seed keeps full service logs in `.demo-data/logs/`, and a
  failed scenario no longer stops the rest.

---

## Session 014 — 2026-11-13 — Policy v0.8, RPC reliability, all nine on Sepolia, web app

### Policy engine v0.8 (lead's review; for line-by-line review)
- `OVER_MILESTONE_AMOUNT`: payouts plus tax reserve may not exceed `grossAmount` (hard rule, money-moving plans).
  `grossAmount` is the escrow's on-chain milestone amount, read by the Policy Service's own chain reader; `release`
  pays it to the vault in full. It never comes from the agent or the request.
- `ZERO_AMOUNT_PAYOUT`: any payout of 0 is rejected, for every proposal. "Moves money" is now payout total > 0.
- Conversion actions: confirmed they cannot move funds (the Policy Service co-signs only payout and
  mobile_money_payout; the vault pays nothing without that co-signature). No cap needed.
- Tax comment fixed to `min_tax_reserve_bps / 10000`.
- Tests: 6 new branch tests (including a zero payout that is never approved and a payout over the milestone amount
  but under every cap that is rejected). Test fixtures: a test that does not set a milestone (or sets gross "0") is
  not about amounts and gets a large gross and a 0% tax rule.
- `NO_PAYOUTS` decision (lead): only "request a new plan" or "reject". The Policy Service refuses `approve` (409)
  for any escalated plan with a zero payout total; `new_plan` closes the approval (stored as rejected) with
  `new_plan_requested: true`; the backend records `new_plan_requested`, pays and mints nothing, the milestone stays
  released and settle may run again. INTERFACES v0.8.

### RPC reliability
- The API-key RPC (`RPC_URL_<chainId>`, Alchemy) is the primary everywhere, now including the seed and slice
  scripts; the public RPC in chains.json is a read-only fallback. Requests 45 s; reads 5 attempts then 3 on the
  fallback; sends exactly once, primary only; confirmation wait 300 s. 3 tests with local endpoints.
- Seed: `--retry-failed` reruns only failed scenarios on the seeded state (new signed contract) and merges the
  summary; `DEMO_DATA_DIR` (guarded name) for a fresh run while an old one holds files.
- Sepolia: all nine scenarios pass (prompt_injection and over_limit_request on the reseed; disputed_delivery on
  one retry after a wallet send connection reset; the first dispute never landed, verified on-chain).

### Web app (`app/`)
- From the design project: Vite kept, TanStack Start. Generator scrubbed: its Vite wrapper replaced by an explicit
  config (TanStack Start, React, Tailwind, tsconfig paths, nitro Node build), component tagger and devtools gone with
  it, its error-reporting hook, SSR wrapper, comments, README, AGENTS file, project file, lockfile and default OG,
  Twitter and author meta removed; own favicon. The 3D renders were pointers into the generator's hosted storage;
  replaced with the 20 original PNGs (sizes verified) in `public/objects/`. No database, auth, server functions or
  env files; `.env` ignored. Dev server on port 3000.
- `src/api`: one module mapping every screen to the backend (contracts, milestones, invoices, simulated checkout and
  stablecoin deposit, receipts read from the chain, reconciliation and the backend CSV export, operator queue,
  identity holds, audit, limits, disputes, wallet review and send). Reason codes in plain language from INTERFACES
  v0.8 (`src/api/reasons.ts`). Operator, arbiter and provider signatures come from the user's own browser wallet
  (EIP-712 typed data prepared by the backend); the client's from its WDK wallet through the backend.
- Backend additions for the app: `GET /providers/{id}`, `POST /wallets/client/contracts/{id}/sign`,
  `GET /operator/policy`, `GET /operator/audit`, CORS also for 127.0.0.1:3000.
- Router plugin bug: generated `import()` strings contain the unescaped absolute path, which breaks on the
  apostrophe in the folder name; route code splitting turned off (`defaultBehavior: []`).
- Checked: typecheck, 8 tests, production build, every page renders, every API read against the live Sepolia demo
  with CORS on every response.
- Open: limits are read-only in the app (changing them needs the operator's signatures on the policy and the vault
  update); release and settle stay platform actions (not in the app).

---

## Session 015 — 2026-11-13 — Push, demo-key signing, review findings (v0.9), Playwright

### Push
- The remote is public; the lead said to push anyway. `main` only, `--force-with-lease` on the last known remote
  commit (c9f4ec5, checked with ls-remote), no tags. Remote main is now the rewritten history. Backup tags stay local.

### Demo-key signing (DEMO_MODE only)
- `services/backend/scripts/demo-signer.ts`, started by the seed's serve modes in the presenter's process: the
  operator, arbiter and provider TEST keys sign there, never in the backend or the Policy Service. It signs only the
  typed data each role needs; the operator's limit change signs the policy document and the vault SetPolicy and
  submits them to the Policy Service, which relays the vault update on-chain.
- App: every signing action offers "Sign with demo key" (only when the demo signer answers) next to "Sign with your
  wallet" (the real path); results are labelled "Demo: signed with a test key". Operator limits can be changed; "Ask
  the vault" reads the vault contract's own `check` (the same rule `execute` applies) and shows its refusal. The
  client votes on a dispute from the milestone page (WDK wallet).

### Review findings (lead), all with tests
1. Policy: payouts need the escrow milestone Released on-chain, any funding source (`MILESTONE_NOT_RELEASED`).
2. Policy: the milestone budget is cumulative over the Policy Service's own signed-proposal log (milestone id and
   allocation now recorded per signed proposal, with a migration); after an approved settlement every further plan is
   `ALREADY_SETTLED`. Two different proposals for one milestone are never both approved, also through the approval
   queue.
3. Webhook: a permanent funding refusal (already funded, payment in progress, wrong amount) records the event, opens a
   `refund_needed` treasury issue (listed in the reconciliation queue) and answers 200; a transient failure (5xx) is not
   recorded, so Stripe retries.
4. Funding: a second payment while another is pending is `FUNDING_IN_PROGRESS`.
5. Deposits: only our token's Transfer logs, a successful tx on this chain (already so) and now after the milestone
   was created (block time, two minutes of slack); tests with a fake-token Transfer.
6. Startup: outside DEMO_MODE the backend refuses a missing, placeholder, short or simulated webhook secret; the
   simulated checkout exists only in DEMO_MODE. The seed and slice pass DEMO_MODE=1.
7. Amounts: safe whole cents, at most MAX_MILESTONE_USD_CENTS (default $100,000), `AMOUNT_TOO_LARGE`.
8. Identity hold: idempotent per milestone (a retried release keeps one hold, first opened time).
9. Traces: treasury traces record the milestone id only; a test checks no raw body or signature reaches a trace.
10. Release, refund and settle were public routes; they now need `x-platform-token` (PLATFORM_TOKEN, separate from the
    Policy-backend internal token). Card funding has no public route but the verified webhook (plus the DEMO_MODE
    simulated checkout); stablecoin funding needs a deposit proven on-chain. Tests for each.
- vaultActions: at most 10 actions per request and 50 payees per action; policy signatures have no expiry
  (documented). INTERFACES v0.9; the app explains MILESTONE_NOT_RELEASED and ALREADY_SETTLED, and a test keeps the
  app's code lists equal to the Policy Service's types.

### Tests
- contracts 122, chain 36, policy 153, llm 61, backend 130, app 9.

### Playwright (app/e2e, against the live Sepolia demo)
- Tour (every screen at 360, 768 and 1440 px: screenshots, video, a sideways-scroll check) and the journey (1440 px,
  video): freelancer contract (demo key) -> client pays (simulated card) and the escrow is funded on-chain -> client
  approves on-chain -> operator lowers the limit to $5, the vault contract refuses $6 (OVER_PER_TX_CAP), limit
  restored -> new plan for a no-payout escalation -> identity hold released -> arbiter and client decide the dispute
  on-chain -> wrong network blocked and duplicate send refused. Journey passes in about 4 to 6 minutes.
- Fixes it found: the simulated checkout "complete" was posted without `outcome: "paid"` (the app could not pay);
  grid columns widened phone screens (dashboard, ledger) and the tablet header overflowed; hidden table labels
  escaped the ledger's scroll box; the explanation under every sign button made the operator page very long (one
  note per page now); "To Nobody" wording; a balance that stayed "…" when the wallet RPC timed out.
- Recordings and screenshots: app/e2e-artifacts/ (git-ignored). Playwright 1.65.0 (its Chromium build was installed).
- Open: WDK wallet reads (balance) use the WDK provider without our retry/fallback and time out on Sepolia now and
  then.


---

## Session 016 — 2026-11-12 — Milestone id from the request, WDK failover, clean-delivery journey, docs, clean seed

### Policy Service (v0.10)
- POST /v1/proposals is backend-only: `x-internal-token` (INTERNAL_TOKEN, constant-time compare; 401 otherwise) and a
  `milestone_id` in the body. Every chain read, the budget, the settled log and the audit row use the request's
  milestone; a proposal naming another milestone is rejected `MILESTONE_ID_MISMATCH` (first rule after the schema),
  whatever it contains. The backend sends the milestone it is settling. INTERFACES v0.10, API.md, the app's reasons.

### WDK
- The WDK wallets use @tetherto/wdk-failover-provider (now a direct dependency): the API-key RPC first, the public RPC
  second, each JsonRpcProvider pinned to the chain id with a 20 s request timeout; only timeout, network and server
  errors fail over (contract errors are not retried). Tests: a hanging primary falls over to the fallback, also
  through a WDK account's balance read.

### Demo
- The demo signer adds POST /platform/settle (release, then settle, with the platform token held by the presenter's
  process); the milestone page shows "Release and settle" in demo mode, the vault payouts and the Policy approval.
- `npm run demo` / `demo:serve` also start the web app on :3000 when app/ is installed (DEMO_APP=0 skips it).
- Playwright: the journey now includes the clean-delivery path (stablecoin payment, approve, release and settle,
  receipt verified) and a card-paid contract with its hold; a short demo spec records its waits and
  e2e/cut-video.mjs (ffmpeg) speeds each up to about a second -> recordings/tethran-demo-short.webm.
- README and docs/DEMO.md rewritten to match what is built (one command, ports, demo-key buttons, real vs simulated,
  trust assumptions, WDK modules, the nine seed results including identity_mismatch).

### Seed
- Clean Sepolia seed: nine scenarios, 0 problems (results in docs/DEMO.md). State kept in .demo-data/.

### Tests
- contracts 122, chain 40, policy 159, llm 61, backend 131, app 9.

### Not done
- The short demo recording and the full journey did not complete: the machine ran low on memory and the session
  stopped the demo services and the Playwright run (after the first screenshot). Not restarted, pending the lead.
