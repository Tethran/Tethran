# Vault and SpendingGuard: design notes (draft, no code yet)

Status: notes for the lead and co-architect to decide on. Nothing here is built. Vault code starts only after
the escrow is approved. Where a point needs a decision it is marked **Decide**.

## What they are for

- **Vault:** one per provider. Receives the escrow release. Moves USDT out only when both the agent signer
  module and the Policy Service have signed the exact transfer (2-of-2).
- **SpendingGuard:** enforces the operator's limits on-chain, so that even if both co-signers were compromised
  an over-limit transfer still fails: per-transaction cap, daily cap (UTC day), payee allowlist, and the vault
  balance floor (`minReserve`).

Phase 0 check V2 found that WDK's ERC-4337 Safe account is single-owner, so the fallback applies: a minimal
custom contract.

## Proposed shape: one contract, not two

**Decide 1.** Build the guard inside the vault contract (`ProviderVault`), rather than as a separate
`SpendingGuard` contract the vault calls.

- One vault per provider already means one policy per vault. A separate guard adds a second address per
  provider, an external call, and a "which guard is attached" question, for no gain in the demo.
- Fewer lines to review: one storage layout, one place where a transfer is checked and made.
- Cost: `ISpendingGuard` in INTERFACES.md becomes functions of the vault; `ChainClient.setPolicy` takes the
  vault address. The `vaults` table loses its `guard` column.
- The alternative (two contracts) is closer to the current INTERFACES draft and to a Safe-style "guard" a
  judge may recognise by name.

## Transfer

```
execute(address to, uint256 amount, bytes32 proposalHash, uint256 nonce, bytes agentSig, bytes policySig)
```

- EIP-712 `Transfer(address vault, address to, uint256 amount, bytes32 proposalHash, uint256 nonce)`, domain
  name `TethranVault`, chain id and vault address. Both signers sign the same struct.
- Checks, in order: nonce is the vault's next nonce -> both signatures recover to the stored `agentSigner` and
  `policySigner` (two different addresses, checked at construction) -> guard checks -> state updates -> transfer.
- Anyone may submit (the orchestrator does); the signatures are the authority. Same pattern as `decide`.
- `proposalHash` ties each transfer to the audited Policy Service decision and is emitted in the event, so the
  reconciliation store can join chain and audit log.
- **Decide 2.** Sequential nonce (simple, transfers of one proposal must land in order) or a used-id mapping
  keyed by `keccak(proposalHash, actionIndex)` (order-free, and naturally idempotent per action). I lean to
  the mapping: a proposal has several payouts and one stuck transaction should not block the rest.
- Only USDT moves. The token address is immutable. No arbitrary calls, no `delegatecall`, no native-coin handling.

## Guard checks (inside `execute`)

| Check | Rule | Revert |
|---|---|---|
| Payee | `allowed[to]` is true | `PayeeNotAllowed` |
| Per-transaction cap | `amount <= perTxCap` | `OverPerTxCap` |
| Daily cap | `spent[block.timestamp / 86400] + amount <= dailyCap` | `OverDailyCap` |
| Reserve | `balance - amount >= minReserve` | `BelowMinReserve` |

- A transfer the guard blocks reverts, so it emits nothing. The `TransferBlocked` event in the first interface
  draft cannot work and is dropped; the Policy Service audit log and the failed transaction are the record.
- A view `check(to, amount)` returns `(ok, reason)` for the UI and for pre-flight in the Policy Service.
- The same four limits are checked off-chain by the Policy Service (`PAYEE_NOT_ALLOWED`, `OVER_PER_TX_CAP`,
  `OVER_DAILY_CAP`, `BELOW_VAULT_RESERVE`). The soft limit, tax reserve and confidence rules are off-chain only.
- **Daily-cap drift:** the Policy Service counts what it approved today; the chain counts what landed today.
  A transfer approved at 23:59 UTC that lands at 00:01 counts on different days. The chain is the authority;
  the Policy Service should read `spent` for the current day from the vault rather than keep its own total.

## Policy updates

```
setPolicy(uint256 version, uint256 perTxCap, uint256 dailyCap, uint256 minReserve, bytes operatorSig)
setPayee(address payee, bool allowed, uint256 version, bytes operatorSig)
```

- EIP-712 structs signed by the stored `operator` address. Anyone may submit (the Policy Service does).
- Replay protection: `version` must be exactly `currentVersion + 1`, for both calls, sharing one counter.
  That gives one ordered history of policy changes and makes an old signature useless.
- **Decide 3.** One call per payee (simple, one transaction each) or `setPayees(address[] payees, bool allowed, ...)`
  (fewer transactions for the seed script). I lean to the array form.
- **Decide 4.** Does a limit change take effect at once, or after a delay? At once is simpler and fine for a
  demo. A delay is the safer production answer (a stolen operator key cannot raise caps and drain in one block).
- The agent signer and the Policy Service signer cannot change policy. The operator cannot move funds.

## Roles and keys

| Key | Can | Cannot |
|---|---|---|
| Agent signer module | co-sign a transfer | move funds alone; change policy |
| Policy Service signer | co-sign a transfer | move funds alone; change policy |
| Operator | set limits and payees | move funds |
| Anyone | submit a fully signed transfer or policy update | anything without the signatures |

- **Decide 5.** Signer rotation. If the agent or Policy Service key is lost, the vault is frozen for good
  unless someone can replace a signer. Options: (a) no rotation, redeploy the vault and accept that funds in
  the old one are stuck (not acceptable outside a demo); (b) the operator can replace a signer with a signed
  update, after a delay; (c) an operator-signed "withdraw everything to the provider's own address" escape
  hatch. I lean to (c) for the demo: it is one function, it sends funds only to an address fixed at
  construction (`providerPayout`), and it keeps the provider from ever being locked out of their own money.
  It does mean the operator key alone can empty the vault to that one address, which is the provider's anyway.
- **Decide 6.** Who is the operator: the provider (their own wallet signs policy) or the platform? The PRD says
  the provider or agency admin. Then in the demo the OPERATOR test key stands for the provider's wallet.

## Deployment

- One `ProviderVault` per provider, deployed by the seed script with: USDT address, agent signer, Policy
  Service signer, operator, and (if Decide 5c) the provider's payout address.
- **Decide 7.** Plain deployment per provider (simple, about one contract's gas each) or a small factory with
  minimal clones (cheaper per provider, one more contract to review). Plain deployment is enough for the demo.
- The escrow already stores the vault address per milestone; the backend passes the provider's vault at funding.

## ChainClient and INTERFACES changes this would need

- `vaultExecute({ vault, to, amount, proposalHash, nonce | actionId, agentSig, policySig }, idempotencyKey)`.
- `setPolicy({ vault, version, perTxCap, dailyCap, minReserve, operatorSig }, idempotencyKey)` and
  `setPayees({ vault, payees, allowed, version, operatorSig }, idempotencyKey)`.
- Reads: `vaultPolicy(vault)`, `vaultSpentToday(vault)`, `vaultCheck(vault, to, amount)`.
- Typed-data helpers for the three structs, like `attestationTypedData`.

## Tests planned

Two valid signatures move funds; one signature, a swapped pair, a wrong signer, a replay, another vault's or
chain's signature all fail. Each guard rule at its exact boundary. Daily cap across a UTC midnight. Reserve
with a balance top-up between transfers. Policy update with a wrong version, an old signature, a non-operator
signature. Payee removed between approval and execution. The escape hatch, if adopted. A balance invariant
across several milestones released into one vault.

## Open questions carried over

- Receipt NFT is minted after the vault payout is confirmed (already decided); with several payouts per
  milestone, "confirmed" should mean all transfers of the approved proposal have landed.
- Simulated rails: each rail's deposit address is a payee on the allowlist like any other.
