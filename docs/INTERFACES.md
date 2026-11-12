# Interfaces (v0.4)

The contract between the two workstreams. Change only by agreement, and log the change in Development.md.
Amounts are strings in base units (USDT: 6 decimals). IDs are UUIDs unless stated.

v0.2 (12 Nov 2026) applies the co-architect decisions 1 to 14. v0.3 (12 Nov 2026) removes the attestation
nonce, allows disputes only while Funded, adds the dispute window and adds the `HOLD_ACTIVE` reason code.
v0.4 (12 Nov 2026) applies the contract review: FUNDER role, `refundApproved`, timeout and hold bounds, the
`BELOW_VAULT_RESERVE` reason code, the tax-reserve base, and the stricter idempotency rules in `ChainClient`. Where the architecture document
(`docs/03-system-design-architecture.md`, sections 3.2, 3.3 and 5.2) differs, this file wins.

## 0. State model

On-chain states (escrow contract): `None, Funded, Approved, Disputed, Released, Refunded`.
Off-chain milestone states (database) add `draft`, `in_review` and `paid_out`.

| Off-chain state | On-chain state | Meaning |
|---|---|---|
| `draft` | `None` | Contract or milestone exists, not funded yet |
| `funded` | `Funded` | `createAndFund` confirmed |
| `in_review` | `Funded` | Funded, and the provider has submitted evidence |
| `approved` | `Approved` | Client called `approve`, or a dispute was decided for the provider |
| `disputed` | `Disputed` | Client or provider called `dispute` |
| `released` | `Released` | Escrow paid the provider's vault |
| `paid_out` | `Released` | The vault payout is confirmed (receipt is minted after this) |
| `refunded` | `Refunded` | Escrow returned the funds to the funder |

## 1. Settlement proposal (agent output)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SettlementProposal",
  "type": "object",
  "additionalProperties": false,
  "required": ["milestone_id", "confidence", "evidence_used", "actions", "flags", "needs_human"],
  "properties": {
    "milestone_id": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "evidence_used": { "type": "array", "items": { "type": "string" } },
    "actions": {
      "type": "array",
      "items": {
        "oneOf": [
          { "type": "object", "additionalProperties": false,
            "required": ["type", "payee_id", "amount", "asset"],
            "properties": { "type": { "const": "payout" }, "payee_id": { "type": "string" },
              "amount": { "type": "string", "pattern": "^[0-9]+$" }, "asset": { "const": "USDT" } } },
          { "type": "object", "additionalProperties": false,
            "required": ["type", "payee_id", "amount", "provider"],
            "properties": { "type": { "const": "mobile_money_payout" }, "payee_id": { "type": "string" },
              "amount": { "type": "string", "pattern": "^[0-9]+$" },
              "provider": { "enum": ["mpesa", "mtn_momo", "airtel", "bank"] } } },
          { "type": "object", "additionalProperties": false,
            "required": ["type", "amount", "reason"],
            "properties": { "type": { "const": "tax_reserve" }, "amount": { "type": "string", "pattern": "^[0-9]+$" },
              "reason": { "type": "string" } } },
          { "type": "object", "additionalProperties": false,
            "required": ["type", "amount", "target", "condition"],
            "properties": { "type": { "const": "conversion" }, "amount": { "type": "string", "pattern": "^[0-9]+$" },
              "target": { "type": "string" }, "condition": { "type": "string" } } }
        ]
      }
    },
    "flags": {
      "type": "array",
      "items": { "type": "object", "required": ["code", "detail"],
        "properties": { "code": { "type": "string" }, "detail": { "type": "string" } } }
    },
    "needs_human": { "type": "boolean" }
  }
}
```

### 1a. Agent boundary

- The LLM has read tools, the x402 purchase tools and `propose_settlement`. Nothing else.
- `submit_cosigned_tx` is **not** an LLM tool. After the Policy Service approves and co-signs, the
  **orchestrator** (backend code) submits the vault transaction through `ChainClient.vaultExecute`.
- The "agent key" (first vault signer) lives in a separate **signer module**. It is never in the LLM
  context, prompt, tool results, logs or traces. The signer module signs only the exact transfers of a
  proposal the Policy Service has approved.

## 2. Policy Service API (REST, JSON)

| Endpoint | Purpose |
|---|---|
| `POST /v1/proposals` | Body: `{ proposal, trace_id }`. Returns `{ decision: "approved" \| "escalated" \| "rejected", reasons: string[], cosignature? , proposal_hash }`. Only `approved` carries a co-signature. `reasons` holds the reason codes below. |
| `GET /v1/policy` | Active policy and version. |
| `POST /v1/policy` | Body: `{ policy, version, operator_signature }`. Rejected unless the operator's signature verifies and version increments. Writes the on-chain limits to the provider's guard. |
| `GET /v1/approvals?status=pending` | Human approval queue. |
| `POST /v1/approvals/{id}/decision` | Body: `{ decision: "approve" \| "reject", operator_signature }`. |
| `POST /v1/attestations/verify` | Body: `{ milestone_id, type, signer, signature }`. Returns `{ valid: boolean }`. |
| `GET /v1/audit?milestone_id=` | Append-only decision log. |

Policy document:
```json
{
  "version": 1,
  "per_tx_cap": "0",
  "per_tx_soft_limit": "0",
  "daily_cap": "0",
  "vault_min_reserve": "0",
  "payee_allowlist": ["payee_id"],
  "min_tax_reserve_bps": 0,
  "confidence_threshold": 0.7,
  "chargeback_hold_seconds": 0
}
```

Field notes:
- `per_tx_cap`: hard cap per transfer. Rejects. Also enforced on-chain by the guard.
- `per_tx_soft_limit`: below `per_tx_cap`. A transfer above it escalates to the human queue. Off-chain only.
- `daily_cap`: total per **UTC calendar day**, in the Policy Service and on-chain (`block.timestamp / 86400`).
- `vault_min_reserve`: balance floor of the vault in base units; the guard's `minReserve`. A transfer may not take the vault below it. Enforced twice: by the Policy Service (`BELOW_VAULT_RESERVE`, using the vault's current USDT balance minus the proposal's payouts) and on-chain by the guard.
- `min_tax_reserve_bps`: the `tax_reserve` actions of a proposal must add up to at least this share of the **gross milestone payout amount** (the amount the escrow released to the vault for that milestone). Off-chain only. This is a different thing from `vault_min_reserve`; never use one name for the other.
- `confidence_threshold`: default 0.7. A proposal below it escalates.
- `payee_allowlist`: payee IDs. The Policy Service resolves `payee_id` to an address through the `payees` table; the guard holds the matching address allowlist.
- `chargeback_hold_seconds`: passed as `holdSeconds` to `createAndFund` for card-funded milestones.

Reason codes:

| Decision | Codes |
|---|---|
| `rejected` | `SCHEMA_INVALID`, `DUPLICATE_PROPOSAL`, `HOLD_ACTIVE`, `PAYEE_NOT_ALLOWED`, `OVER_PER_TX_CAP`, `OVER_DAILY_CAP`, `BELOW_VAULT_RESERVE`, `TAX_RESERVE_TOO_LOW` |
| `escalated` | `LOW_CONFIDENCE`, `NEEDS_HUMAN`, `IDENTITY_MISMATCH`, `OVER_SOFT_LIMIT` |

Rule order: schema valid → duplicate proposal → hold active → payee allowed → per-tx cap → daily cap → vault reserve → minimum tax reserve
(any failure so far is `rejected`) → soft limit → confidence threshold → `needs_human` → identity match
(any failure here is `escalated`). All failing codes of the deciding class are returned; nothing is silently dropped.

`HOLD_ACTIVE`: the proposal is for a card-funded milestone that is not yet eligible for release (still inside
its chargeback hold, or not released). The orchestrator must not call the agent until release is eligible;
this code is the backstop if it does.

## 3. Contracts (Solidity signatures)

```solidity
interface IMilestoneEscrow {
  enum State { None, Funded, Approved, Disputed, Released, Refunded }

  event Funded(bytes32 indexed milestoneId, address indexed funder, uint256 amount, uint64 timeout, bool cardFunded);
  event Approved(bytes32 indexed milestoneId);
  event Disputed(bytes32 indexed milestoneId, address indexed by, uint64 timeout);   // timeout after any extension
  event Released(bytes32 indexed milestoneId, address indexed vault, uint256 amount);
  event Refunded(bytes32 indexed milestoneId, address indexed to, uint256 amount);

  // FUNDER role only (the treasury). msg.sender is the funder and pays `amount`. `client` is the party who attests.
  // `timeout` is a unix timestamp, at least now + MIN_TIMEOUT (1 day). `holdSeconds` is the chargeback hold,
  // used only when cardFunded, at most MAX_HOLD (30 days). Vault and parties may not be the escrow or the token.
  function createAndFund(bytes32 milestoneId, address client, address provider, address arbiter, address vault,
                         uint256 amount, uint64 timeout, bool cardFunded, uint32 holdSeconds) external;
  // clean path: client only, before the timeout, Funded -> Approved
  function approve(bytes32 milestoneId) external;
  // client or provider, only while Funded and before the timeout -> Disputed;
  // extends timeout to at least now + DISPUTE_WINDOW (7 days)
  function dispute(bytes32 milestoneId) external;
  // Disputed only, before the timeout: two of three EIP-712 attestations (client, provider, arbiter).
  // releaseToProvider = true -> Approved; false -> refund to the funder.
  function decide(bytes32 milestoneId, bool releaseToProvider, bytes[] calldata sigs, address[] calldata signers) external;
  // RELEASER role only. Requires Approved and, if cardFunded, block.timestamp >= approvedAt + holdSeconds.
  function release(bytes32 milestoneId) external;
  // Anyone, once block.timestamp >= timeout, while Funded or Disputed. Pays the funder.
  function refund(bytes32 milestoneId) external;
  // Approved -> Refunded, to the funder. Only: (1) RELEASER while the card hold is running (chargeback);
  // (2) the funder once approvedAt + hold + RELEASE_GRACE (3 days) has passed without a release (rescue).
  // The hold counts as 0 unless cardFunded.
  function refundApproved(bytes32 milestoneId) external;
  function state(bytes32 milestoneId) external view returns (State);
  // every stored field: funder, client, provider, arbiter, vault, amount, timeout, approvedAt, holdSeconds, cardFunded, state
  function milestone(bytes32 milestoneId) external view returns (Milestone memory);
}
```

Rules:
- All parties, the vault, the amount, the timeout and the hold are stored per milestone at `createAndFund`.
- **Who funds:** only the FUNDER role (the treasury) can create a milestone, so nobody else can occupy a
  milestone id. Constants: `MIN_TIMEOUT` 1 day, `MAX_HOLD` 30 days, `DISPUTE_WINDOW` 7 days, `RELEASE_GRACE` 3 days.
  A client paying in stablecoin sends it to a treasury deposit address and the treasury funds the escrow;
  this is a **demo simplification** and is labelled as such in the UI.
- **Backend duties (not on-chain):** the backend chooses the arbiter and the provider's vault, and after every
  funding it reads `milestone()` and checks funder, parties, vault, amount, timeout and hold against its own
  request before relying on the milestone. State alone is never trusted.
- **No stranded funds:** an Approved milestone leaves the escrow by `release`, or by `refundApproved` in the
  two cases above. Between the end of the hold and the end of the grace period only `release` is possible.
- **Clean path:** the client alone approves, before the timeout. The provider cannot object to being paid. Approval is final for
  the client: an Approved milestone cannot be disputed.
- **Dispute:** only while `Funded` and before the timeout (a refund that is already due cannot be delayed). A dispute moves the timeout to at least `now + DISPUTE_WINDOW` (a constant,
  7 days) and never shortens it. `decide` is used only for `Disputed` milestones and only before the timeout.
  A dispute that reaches the timeout without a decision defaults to a refund. A milestone is decided at most
  once: `decide(true)` gives Approved (which cannot be disputed), `decide(false)` refunds in the same transaction.
- **Refund destination:** the on-chain refund goes to the funder (`msg.sender` of `createAndFund`). For a
  card-funded milestone that is the treasury, which then starts the off-chain refund to the client.
- **Identity hold:** `release` is restricted to the RELEASER role (treasury/backend). The backend runs the
  identity-match check first and only then calls `release`. The identity hold is enforced by the backend,
  **not on-chain**; identity verification is simulated and labelled as such.
- One vault per provider (deployed per provider by the seed script). No pooled vault.

Attestation typed data (EIP-712): `Attestation(bytes32 milestoneId, uint8 kind, bool releaseToProvider)`
with `kind` 0 = client, 1 = provider, 2 = arbiter. Domain: name `TethranEscrow`, version `1`, the chain ID and
the escrow address. There is no nonce: the domain binds the chain and contract, and a milestone is decided at
most once. `decide` takes exactly two signatures from two different parties; `signers[i]` signed `sigs[i]`.
Signatures are the 65-byte `r, s, v` form from an ordinary key wallet (no compact form, no contract wallets).

```solidity
// Draft: finalised at the vault and guard review.
interface ISpendingGuard {
  event PolicyUpdated(uint256 version);
  event PayeeSet(address indexed payee, bool allowed);
  // limits in base units; dailyCap counts per UTC calendar day; minReserve is the vault balance floor
  function setPolicy(uint256 version, uint256 perTxCap, uint256 dailyCap, uint256 minReserve, bytes calldata operatorSig) external;
  // allowlist is mapping(address => bool), set by the operator
  function setPayee(address payee, bool allowed, bytes calldata operatorSig) external;
  function check(address to, uint256 amount) external view returns (bool ok, bytes32 reason);
}
```

A simulated mobile-money or bank payee has one on-chain deposit address: a simulated rail wallet owned by
the payout adapter. It is allowlisted like any other payee.

## 3b. Receipt NFT

```solidity
interface IReceiptNFT {
  event ReceiptMinted(uint256 indexed tokenId, bytes32 indexed milestoneId, address indexed holder);
  // MINTER role only. Non-transferable (soulbound); one per milestone; reverts if already minted.
  function mint(bytes32 milestoneId, address holder, bytes32 invoiceHash, bytes32 settlementHash,
                uint256 amount, uint256 chainId, bytes32 releaseTx) external returns (uint256 tokenId);
  function receiptOf(bytes32 milestoneId) external view returns (uint256 tokenId);
}
```
Hashes only; no personal data on-chain. Minted by the MINTER role (treasury/backend) **after the vault payout
is confirmed**, so it can store the release transaction hash. Holder = the provider. The client reaches the
receipt through the public verification link.

## 3a. Chain abstraction

```ts
type TxRef = { txHash: string; chainId: number; idempotencyKey: string };
type TxStatus = "pending" | "confirmed" | "failed" | "unknown";

interface ChainClient {
  chainId: number;
  // escrow
  createAndFund(p: {
    milestoneId: string; client: string; provider: string; arbiter: string; vault: string;
    amount: string; timeout: number; cardFunded: boolean; holdSeconds: number;
  }, idempotencyKey: string): Promise<TxRef>;
  approve(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  dispute(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  decide(milestoneId: string, releaseToProvider: boolean, sigs: string[], signers: string[],
         idempotencyKey: string): Promise<TxRef>;
  release(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refund(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  refundApproved(milestoneId: string, idempotencyKey: string): Promise<TxRef>;
  // vault (two signatures: agent signer module, Policy Service) and guard
  vaultExecute(p: { vault: string; to: string; amount: string; agentSig: string; policySig: string },
               idempotencyKey: string): Promise<TxRef>;
  setPolicy(p: { guard: string; version: number; perTxCap: string; dailyCap: string; minReserve: string;
                 operatorSig: string }, idempotencyKey: string): Promise<TxRef>;
  // receipt
  mintReceipt(p: { milestoneId: string; holder: string; invoiceHash: string; settlementHash: string;
                   amount: string; releaseTx: string }, idempotencyKey: string): Promise<TxRef>;
  // reads
  milestone(milestoneId: string): Promise<MilestoneView>;   // every stored field of the escrow milestone
  txStatus(txHash: string): Promise<TxStatus>;
  balance(address: string): Promise<string>;   // USDT base units
}
```

- `milestoneId` on-chain is `bytes32`: `keccak256` of the UTF-8 milestone UUID. `ChainClient` does the conversion.
- A `ChainClient` instance is bound to one signer (treasury, a user wallet, the orchestrator). The role
  checks happen on-chain.
- Every state-changing call takes an `idempotencyKey`. Rules:
  - Keys are scoped to the sending address. The same key with the **same call** returns the first `TxRef` and
    never sends a second transaction. The same key with a **different call** throws.
  - If the node refuses a send before accepting it (revert at gas estimation, no gas money, nonce already used,
    underpriced replacement), the key is released. After any other failure the key stays claimed and a retry
    throws; it is never resent automatically.
  - `resolve(idempotencyKey, { txHash? })` is the operator tool for a stuck key. It frees the key only after
    the chain shows the transaction failed or never landed; a confirmed or pending transaction keeps its key.
  - Sends from one client instance run one at a time. `createAndFund` approves the escrow once, without a limit.
- At start the client checks that the RPC reports the configured chain id, and refuses any chain id on the
  mainnet deny-list (`config/mainnet-chain-ids.json`), whatever `chains.json` says.

Per-chain config (`config/chains.json`): `{ name, chainId, rpcUrl, testnet, confirmations, usdt, escrow, receiptNft }`.
`confirmations` (default 1) is how many blocks deep a transaction must be before the next step relies on it.
Vault and guard addresses are per provider, so they live in the `vaults` table, not in chain config.
Everything outside `ChainClient` stays chain-agnostic.

## 4. Backend API surface (web app ↔ backend)

`POST /contracts`, `POST /contracts/{id}/sign`, `POST /milestones/{id}/invoice`, `GET /pay/{invoiceId}` (no-account pay link), `POST /webhooks/stripe` (verified, idempotent), `POST /milestones/{id}/evidence`, `POST /milestones/{id}/settle` (triggers the agent), `GET /milestones/{id}/timeline`, `POST /payouts/{id}/status`.

## 5. Database tables (core)

Storage is SQLite.

`contracts`, `milestones` (state, chain_id, funding_source, escrow_tx), `invoices`, `fundings` (stripe_ref, source, chain_id, idempotency_key), `settlement_plans` (json, hash, trace_id), `policy_versions`, `policy_decisions` (decision, reasons, proposal_hash), `attestations`, `payees` (payee_id, address, rail, simulated), `vaults` (provider_id, chain_id, vault, guard), `payouts` (adapter, chain_id, status, simulated=true), `disputes`, `identity_records` (verified_name, simulated_id_ref), `phone_registry` (phone_hash, wallet, consent_at), `receipts` (milestone_id, chain_id, token_id, mint_tx), `audit_log` (append-only), `trace_refs`.

## 6. Payout adapter

```ts
interface PayoutAdapter {
  quote(req: PayoutRequest): Promise<Quote>;
  initiate(req: PayoutRequest, idempotencyKey: string): Promise<PayoutRef>;
  status(ref: PayoutRef): Promise<PayoutStatus>;
}
```
Implementations: `MobileMoneySim` (mpesa, mtn_momo, airtel), `BankSim`, `UsdtSim`.
