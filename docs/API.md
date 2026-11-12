# Tethran API

Every endpoint the services expose, with request and response examples. JSON in and out. Amounts are strings in
USDT base units (6 decimals: `"100000000"` is 100 USDT). Test networks only.

Two services, two processes, two sets of keys:

| Service | Default address | Holds | Code |
|---|---|---|---|
| Backend | `http://127.0.0.1:8788` | treasury key (funds, releases, mints receipts); agent signer key (first vault co-signer, never given to the LLM) | `services/backend` |
| Policy Service | `http://127.0.0.1:8787` | Policy Service key (second vault co-signer) | `services/policy` |

The web app talks to the **backend**. The Policy Service is called by the backend and by the operator console.

**Errors** (both services): a non-2xx status with `{ "error": "short safe message", "code": "OPTIONAL_CODE" }`.
No stack traces, URLs or keys. `400` bad input, `401` internal route, `404` not found, `405` wrong method (with an
`Allow` header), `409` not allowed in the current state, `413` body over 256 KB, `502` chain, model or Policy
Service failure.

**Simulated parts** are labelled in responses (`simulated: true` or a `note`): fiat-to-USDT conversion, identity
checks, mobile-money and bank rails, Stripe refunds, the stablecoin deposit flow (a demo simplification).

Status of each group: **built** means implemented and tested; **planned** means listed in `docs/INTERFACES.md`
section 4 or the build plan, not built yet.

---

## Backend

### Health

`GET /health` → `200 { "ok": true }`

### Milestones (built)

#### `POST /milestones` — create a draft milestone

The backend picks the arbiter (the platform arbiter) and the provider's vault, and checks the vault on-chain.

```json
{
  "id": "c9fe85ad-95fa-4b35-b6e7-7f5c426948b6",
  "provider_id": "prov-demo",
  "title": "Brand identity pack, final delivery",
  "client_address": "0x29ec214d198abCc11583647dA2De3BF20350c623",
  "amount_usd_cents": 10000,
  "timeout_seconds": 604800,
  "invoice_ref": "INV-001"
}
```

`timeout_seconds` (default 7 days) and `invoice_ref` are optional. Response `200`: the milestone record.

```json
{
  "id": "c9fe85ad-95fa-4b35-b6e7-7f5c426948b6",
  "provider_id": "prov-demo",
  "title": "Brand identity pack, final delivery",
  "client_address": "0x29ec214d198abCc11583647dA2De3BF20350c623",
  "provider_address": "0x24e1b06a88Ee7C924eac9A2708b590b4c1a98815",
  "arbiter_address": "0xc5D9D6CFb284ef830AfCd96C8834eFFd6E50cBA4",
  "vault": "0xeE59D8994620A9125641b36848A636E04e24feA8",
  "amount": "100000000",
  "amount_usd_cents": 10000,
  "timeout": 604800,
  "funding_source": null,
  "card_funded": 0,
  "hold_seconds": 0,
  "chain_id": 11155111,
  "state": "draft",
  "escrow_tx": null,
  "release_tx": null,
  "invoice_ref": "INV-001",
  "created_at": "2026-11-12T10:00:00.000Z"
}
```

Errors: `400` (not a UUID, bad address, client equal to the provider or arbiter, amount not a positive integer),
`404` provider has no vault on this chain, `409` milestone exists, `409 VAULT_MISMATCH` the vault on-chain does not
match the provider record.

`state` is the off-chain state (INTERFACES.md section 0): `draft`, `funded`, `in_review`, `approved`, `disputed`,
`released`, `paid_out`, `refunded`.

#### `GET /milestones/{id}` — milestone, synced with the escrow

Response: the milestone record (as above), with `state` brought in line with the on-chain escrow.

#### `GET /milestones/{id}/timeline` — everything that happened to a milestone

```json
{
  "milestone": { "id": "c9fe85ad-…", "state": "paid_out", "…": "…" },
  "fundings": [
    { "source": "stablecoin", "reference": "0x89be8ab3…", "amount": "100000000", "chain_id": 11155111,
      "escrow_tx": "0xdf5af18a…", "status": "funded", "at": "2026-11-12T10:01:00.000Z" }
  ],
  "evidence": [{ "id": 1, "at": "2026-11-12T10:02:00.000Z" }],
  "settlement_plans": [
    { "id": 1, "proposal_hash": "ab12…", "trace_id": "01a1cda7-bea5-74de-8063-77cdf30ab174", "decision": "paid_out", "reasons": [],
      "at": "2026-11-12T10:03:00.000Z" }
  ],
  "payouts": [
    { "action_index": 0, "action_id": "0x…", "payee_id": "payee_amara", "rail": "usdt", "to_address": "0x…",
      "amount": "60000000", "tx": "0x5472d075…", "status": "confirmed", "simulated": 0, "at": "…" },
    { "action_index": 1, "action_id": "0x…", "payee_id": "payee_kofi", "rail": "mpesa", "to_address": "0x…",
      "amount": "30000000", "tx": "0x085b9626…", "status": "confirmed", "simulated": 1, "at": "…" }
  ],
  "receipt": { "milestone_id": "c9fe85ad-…", "chain_id": 11155111, "token_id": 1, "mint_tx": "0x…", "holder": "0x24e1…",
    "invoice_hash": "0x…", "settlement_hash": "0xab12…", "at": "…" }
}
```

`trace_id` is the Opik trace of the settlement run. `simulated: 1` on a payout means the on-chain transfer went to
the rail's deposit wallet and the mobile-money or bank leg is simulated.

#### `POST /milestones/{id}/evidence` — provider submits delivery evidence

```json
{ "text": "All brand files delivered on 12 Nov 2026. The client confirmed receipt." }
```

Response: `{ "evidence_id": 1, "milestone_state": "in_review" }`. Evidence is stored as untrusted data and reaches
the agent only inside labelled delimiters. Max 20,000 characters.

### Funding (built)

#### Card: `POST /webhooks/stripe` — Stripe webhook

Raw Stripe event body with the `Stripe-Signature` header. The signature is verified (HMAC-SHA256, 5-minute
tolerance) before anything is read, and each event id is handled once.

| Event | Effect |
|---|---|
| `checkout.session.completed` with `payment_status: "paid"` | fund the escrow, card-funded, with the chargeback hold |
| `payment_intent.succeeded` | same (a second event for the same payment funds nothing) |
| `charge.dispute.created`, `charge.refunded` | chargeback: refund the escrow if Approved and still inside the hold; otherwise flag for a human |

The milestone is `data.object.metadata.milestone_id`; the amount must equal the milestone's `amount_usd_cents`
in `usd`. Response:

```json
{ "event_id": "evt_1", "duplicate": false, "outcome": "funded" }
```

Other outcomes: `"ignored: not paid"`, `"rejected: paid 9999 usd, expected 10000 usd"`, `"refunded: chargeback during the hold"`,
`"flagged for a human: …"`. `400 BAD_SIGNATURE` for a missing, wrong or stale signature. The card payment in USD is
converted to test USDT at 1:1 (**simulated**).

#### Stablecoin: `GET /milestones/{id}/deposit` — where to pay (demo simplification)

```json
{
  "milestone_id": "c9fe85ad-…", "chain_id": 11155111, "network": "Sepolia",
  "token": "0xE2D587DD9ad01C91DFf0baABc120192C516b9879", "token_symbol": "tUSDT (test token)",
  "amount": "100000000", "from": "0x29ec…c623", "deposit_address": "0x7076…B09e",
  "note": "Demo simplification: send the exact amount from the client address to the treasury deposit address, then confirm with the transaction hash."
}
```

#### `POST /milestones/{id}/deposit/confirm` — confirm the deposit and fund the escrow

```json
{ "tx_hash": "0x89be8ab3d6b8b318ac6557df59ffe189124378c1c0af3903b211d8639d43f854" }
```

The backend reads the transaction on-chain: it must contain a confirmed test USDT transfer from the client to the
treasury of at least the milestone amount. Response:

```json
{ "milestone": { "state": "funded", "funding_source": "stablecoin", "…": "…" }, "escrow_tx": "0xdf5af18a…", "simulated": [] }
```

Errors: `409 DEPOSIT_NOT_FOUND`, `409 DEPOSIT_TOO_SMALL`, `409 FUNDING_MISMATCH` (the on-chain milestone did not
match what was asked for; it is not used), `502` funding failed. Calling again with the same hash returns the
same `escrow_tx` and sends nothing.

After **every** funding the backend reads the escrow milestone back and checks funder, client, provider,
arbiter, vault, amount, timeout and hold.

### Approval, release, refund (built)

The **client approves on-chain from its own wallet** (`MilestoneEscrow.approve`); there is no backend endpoint for
it, because the backend cannot approve on the client's behalf.

#### `POST /milestones/{id}/release` — pay the escrow into the provider's vault

Runs the identity check (**simulated**) first. Response:

```json
{ "milestone": { "state": "released", "…": "…" }, "release_tx": "0x11f43af8…", "already": false, "identity": { "simulated": true, "match": true } }
```

Errors: `409` not approved yet, `409 IDENTITY_MISMATCH` (release held), `409 HOLD_ACTIVE` (card hold running).

#### `POST /milestones/{id}/refund` — return the funds to the treasury

After the timeout (Funded or Disputed), or the rescue of an Approved milestone after hold + 3 days. Response:

```json
{ "milestone": { "state": "refunded", "…": "…" }, "refund_tx": "0x…", "already": false,
  "offchain_refund": { "simulated": true, "note": "Return of the stablecoin deposit to the client is simulated in this build" } }
```

Errors: `409 TIMEOUT_NOT_REACHED`, `409` nothing to refund.

### Settlement (built)

#### `POST /milestones/{id}/settle` — run the agent, the Policy Service and the payouts

For a `released` milestone. One Opik trace per run. If an earlier run was approved but stopped part-way, this
resumes its payouts without asking the agent again.

```json
{
  "decision": "approved",
  "reasons": [],
  "plan_id": 1,
  "proposal_hash": "ab12…",
  "payouts": [
    { "action_index": 0, "payee_id": "payee_amara", "rail": "usdt", "amount": "60000000", "tx": "0x5472…", "status": "confirmed", "simulated": 0 },
    { "action_index": 1, "payee_id": "payee_kofi", "rail": "mpesa", "amount": "30000000", "tx": "0x085b…", "status": "confirmed", "simulated": 1 }
  ],
  "receipt": { "token_id": 1, "mint_tx": "0x…", "holder": "0x24e1…" },
  "resumed": false,
  "trace_id": "01a1cda7-bea5-74de-8063-77cdf30ab174"
}
```

When nothing is paid:

```json
{ "decision": "rejected", "reasons": ["SCHEMA_INVALID"], "rejected_by": "agent output check",
  "agent_attempts": [{ "provider": "gemini", "model": "gemini-3.5-flash", "attempt": 1, "reason": "HTTP 429" }],
  "plan_id": 2, "resumed": false, "trace_id": "01a1cda1-…" }
```

```json
{ "decision": "escalated", "reasons": ["OVER_SOFT_LIMIT"], "rejected_by": "policy service", "approval_id": "…", "plan_id": 3, "resumed": false, "trace_id": "…" }
```

Errors: `409` milestone not released, `502 POLICY_UNREACHABLE` / `POLICY_ERROR`, `502 PAYOUT_FAILED` (call again
to resume), `409 EXPIRED` (co-signatures older than 15 minutes; the proposal must be made again).

### Receipts (built)

#### `GET /receipts/{milestoneId}` — public verification, read from the chain

```json
{
  "tokenId": 1, "holder": "0x24e1b06a88Ee7C924eac9A2708b590b4c1a98815",
  "milestoneId": "0x…", "invoiceHash": "0x…", "settlementHash": "0xab12…", "amount": "100000000",
  "chainId": 11155111, "releaseTx": "0x11f43af8…", "mintedAt": 1794476400, "verified_on_chain": true, "chain_id": 11155111
}
```

`404` no receipt. The receipt is soulbound and stores hashes only.

### Internal (built; Policy Service only)

Need header `x-internal-token: <INTERNAL_TOKEN>`; otherwise `401`.

- `GET /internal/payees` → `{ "payee_amara": { "address": "0x…", "rail": "usdt", "simulated": false }, … }`
- `GET /internal/milestones/{id}/identity` → `{ "match": true, "simulated": true, "reason": "names match" }`

### Planned (INTERFACES.md section 4 and the build plan)

`POST /contracts`, `POST /contracts/{id}/sign`, `POST /milestones/{id}/invoice`, `GET /pay/{invoiceId}`, Stripe
checkout session creation (Block 2); `POST /payouts/{id}/status`, reconciliation, wallet review endpoints, operator
and arbiter endpoints (Blocks 3 and 4). They are added to this file as they are built.

---

## Policy Service (built)

### `POST /v1/proposals` — decide on an agent proposal

Called by the backend.

```json
{ "proposal": { "milestone_id": "c9fe85ad-…", "confidence": 0.92, "evidence_used": ["ev-1"],
    "actions": [
      { "type": "payout", "payee_id": "payee_amara", "amount": "60000000", "asset": "USDT" },
      { "type": "mobile_money_payout", "payee_id": "payee_kofi", "amount": "30000000", "provider": "mpesa" },
      { "type": "tax_reserve", "amount": "10000000", "reason": "10 percent reserve" }
    ], "flags": [], "needs_human": false },
  "trace_id": "01a1cda7-bea5-74de-8063-77cdf30ab174" }
```

Response (approved): one co-signature per payout action, valid 15 minutes.

```json
{ "decision": "approved", "reasons": [], "proposal_hash": "ab12…",
  "cosignatures": [
    { "action_index": 0, "action_id": "0x…", "to": "0x…", "amount": "60000000", "deadline": 1794477300, "signature": "0x…" },
    { "action_index": 1, "action_id": "0x…", "to": "0x…", "amount": "30000000", "deadline": 1794477300, "signature": "0x…" }
  ] }
```

Escalated: `{ "decision": "escalated", "reasons": ["LOW_CONFIDENCE"], "proposal_hash": "…", "approval_id": "…" }`.
Rejected: `{ "decision": "rejected", "reasons": ["OVER_PER_TX_CAP"], "proposal_hash": "…" }`. Reason codes are in
INTERFACES.md section 2.

### `GET /v1/policy` → `{ "policy": { …policy document… }, "version": 2 }`

### `POST /v1/policy` — operator-signed policy update

```json
{ "policy": { "version": 2, "per_tx_cap": "1000000000", "per_tx_soft_limit": "800000000", "daily_cap": "1000000000000",
    "vault_min_reserve": "0", "payee_allowlist": ["payee_amara", "payee_kofi"], "min_tax_reserve_bps": 1000,
    "confidence_threshold": 0.7, "chargeback_hold_seconds": 600 },
  "version": 2, "operator_signature": "0x…" }
```

`operator_signature` is the operator's EIP-712 signature of `PolicyDocument(uint256 version, bytes32 policyHash)`
(domain `TethranPolicy`, version `1`). Rejected unless it recovers to the operator and the version is the next one.
The on-chain limits are set on the vault with the vault's own operator-signed `SetPolicy` and `SetPayees`
(relayed through `ChainClient`); relaying them through this endpoint is planned with the operator console.

### `GET /v1/approvals?status=pending` and `POST /v1/approvals/{id}/decision`

```json
{ "decision": "approve", "operator_signature": "0x…" }
```

Approving re-runs the rejecting rules; a human can override an escalation reason, never a rejecting rule.

### `POST /v1/attestations/verify`

```json
{ "milestone_id": "c9fe85ad-…", "type": "client", "signer": "0x29ec…", "signature": "0x…", "release_to_provider": true }
```

→ `{ "valid": true }`

### `GET /v1/audit?milestone_id=…` — append-only decision log
