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

---

## Contracts, country profiles and invoicing (built)

Backend routes from `services/backend/src/contractRoutes.ts` (`contractRoutes(deps)`, registered by the main session).
Offline: no chain, no Stripe, no email. Money is USD cents (integers). Dates are `YYYY-MM-DD`. A contract
milestone's id is the escrow milestone id. Simulated: reminder delivery (recorded and returned, `simulated: true`),
all tax rates (placeholders with `rates_verified: false`), and every payout rail except `usdt`.

### `POST /contracts` — provider creates a contract

```json
{
  "provider_id": "prov-demo", "provider_name": "Amara Design Studio",
  "provider_address": "0x24e1b06a88Ee7C924eac9A2708b590b4c1a98815",
  "client_name": "Kofi Traders Ltd", "client_email": "kofi@example.com",
  "client_address": "0x29ec214d198abCc11583647dA2De3BF20350c623",
  "currency": "USD", "country": "NG",
  "recurrence": { "frequency": "monthly", "count": 3 },
  "milestones": [
    { "title": "Brand identity pack", "amount_usd_cents": 10000, "acceptance_criteria": "Logo, palette and guide as PDF",
      "due_date": "2026-03-15", "recurrence": { "frequency": "weekly", "end_date": "2026-04-30" } }
  ]
}
```

`client_email`, `provider_name` (defaults to `provider_id`), `recurrence` (contract level, inherited by milestones
without their own) and milestone `id` are optional. `recurrence` needs `frequency` (`monthly` or `weekly`) and a `count`
(total invoices including the first, 2 to 120) or an `end_date`. Response `200`:

```json
{
  "id": "5b1c…", "status": "draft", "provider_id": "prov-demo", "provider_name": "Amara Design Studio",
  "provider_address": "0x24e1…", "client_name": "Kofi Traders Ltd", "client_email": "kofi@example.com",
  "client_address": "0x29ec…", "currency": "USD", "country": "NG",
  "contract_hash": "0x9f…", "hash_algorithm": "keccak256",
  "signatures": [], "created_at": "2026-03-01T09:00:00.000Z", "signed_at": null,
  "milestones": [
    { "id": "c9fe85ad-…", "contract_id": "5b1c…", "index": 0, "title": "Brand identity pack", "amount_usd_cents": 10000,
      "acceptance_criteria": "Logo, palette and guide as PDF", "due_date": "2026-03-15",
      "recurrence": { "frequency": "weekly", "end_date": "2026-04-30" }, "state": "draft",
      "invoice_id": null, "invoice_number": null }
  ]
}
```

The hash is keccak256 of the UTF-8 canonical JSON (sorted keys at every level, no timestamps or signatures) of the
terms: parties, country, currency, recurrence and the milestone list including milestone ids. Any change to the terms
changes it. Errors: `400` bad amounts (not a positive integer), unknown country, currency other than USD, missing or
invalid parties, bad dates.

### `GET /contracts/{id}`, `PATCH /contracts/{id}`

`GET` returns the contract above. `PATCH` takes any of the creation fields (milestones replace the whole list; keep a
milestone's `id` to keep it) and returns the contract with a new hash; earlier signatures are dropped. `409`
`TERMS_FROZEN` once both parties have signed.

### `GET /contracts/{id}/typed-data?party=provider|client`

What the wallet signs: EIP-712 `ContractSignature(bytes32 contractHash, string party)`, domain
`{ "name": "TethranContract", "version": "1" }` (no chain id; it is an off-chain document).

```json
{ "domain": { "name": "TethranContract", "version": "1" },
  "types": { "ContractSignature": [{ "name": "contractHash", "type": "bytes32" }, { "name": "party", "type": "string" }] },
  "primaryType": "ContractSignature", "message": { "contractHash": "0x9f…", "party": "client" } }
```

### `POST /contracts/{id}/sign`

```json
{ "party": "client", "signer": "0x29ec214d198abCc11583647dA2De3BF20350c623", "signature": "0x…" }
```

The signature must recover to that party's wallet in the contract, over the contract's current hash. Response: the
contract. When both parties have signed, `status` is `signed` and `signed_at` is set. Re-signing is idempotent.
`400` `WRONG_SIGNER` (signer is not that party's wallet) or `BAD_SIGNATURE` (wrong party, other hash, wrong domain).

### `GET /contracts/{id}/milestones`

`{ "milestones": [ …contract milestones with state… ] }`. `state` is the `state` of the row in the `milestones` table
with the same id (`draft`, `funded`, `in_review`, `approved`, `disputed`, `released`, `paid_out`, `refunded`, per
`docs/INTERFACES.md` section 0), and `draft` when there is no such row.

### `POST /contracts/{id}/milestones/{mid}/activate`

Allowed only when the contract is signed (`409` `NOT_SIGNED` otherwise). Creates the milestone's invoice if it does not
exist and returns the body for the existing `POST /milestones`. It does not call the treasury; the main session posts
this body to it.

```json
{ "id": "c9fe85ad-…", "provider_id": "prov-demo", "title": "Brand identity pack",
  "client_address": "0x29ec…", "amount_usd_cents": 10000, "invoice_ref": "INV-2026-0001" }
```

### `POST /invoices/{id}/activate`

The same body for any invoice, including a recurring occurrence (whose escrow id is derived from the milestone id).

### `GET /country-profiles` and `GET /country-profiles/{code}`

Profiles are data in `src/countryProfiles.ts`; adding a country is configuration only. Rates are placeholders.

```json
{ "code": "KE", "name": "Kenya", "currency": "KES",
  "tax_identifiers": [{ "field": "KRA_PIN", "label": "KRA PIN", "required": true }],
  "required_invoice_fields": ["invoice_number", "issue_date", "due_date", "provider_name", "client_name", "currency",
    "line_items", "subtotal", "total", "provider_tax_ids.KRA_PIN"],
  "payout_rails": ["mpesa", "airtel", "bank", "usdt"],
  "tax_rates": [{ "name": "VAT", "rate_bps": 1600, "rates_verified": false, "note": "Placeholder rate. Verify against the current local tax rules before use." }],
  "rule_sources": ["Kenya Revenue Authority (to verify)"] }
```

The list is `{ "profiles": [ … ] }` (GH, KE, NG, ZA). Unknown code: `404`.

### `POST /milestones/{mid}/invoice` — create the invoice for a contract milestone

`mid` is a contract milestone id; the contract must be signed. Idempotent: a second call returns the same invoice
(`created: false`) and ignores the body.

```json
{ "fee_payer": "client", "provider_tax_ids": { "TIN": "1234567-0001" } }
```

`fee_payer` is `provider` (default) or `client`. Fee model (placeholder, configurable with `FEE_BPS` and
`FEE_FIXED_CENTS`, defaults 100 and 30): `fee = round_half_up(subtotal x bps / 10000) + fixed_cents`. If the client pays,
`total = subtotal + fee` and the payout is the subtotal; if the provider pays, `total = subtotal` and the payout is
`subtotal - fee`. Numbers are `INV-{year}-{seq}`, sequential per provider and year.

```json
{ "id": "0d3e…", "number": "INV-2026-0001", "provider_id": "prov-demo", "contract_id": "5b1c…", "milestone_id": "c9fe85ad-…",
  "occurrence": 0, "escrow_milestone_id": "c9fe85ad-…", "country": "NG", "currency": "USD",
  "provider_name": "Amara Design Studio", "client_name": "Kofi Traders Ltd",
  "provider_tax_ids": { "TIN": "1234567-0001" }, "missing_required_fields": [],
  "line_items": [{ "description": "Brand identity pack", "quantity": 1, "unit_amount_cents": 10000, "amount_cents": 10000 }],
  "subtotal_cents": 10000, "fee_cents": 130, "total_cents": 10130, "provider_payout_cents": 10000,
  "fee_payer": "client", "issue_date": "2026-03-01", "due_date": "2026-03-15", "status": "unpaid",
  "paid_at": null, "paid_reference": null, "pay_url": "http://localhost:3000/pay/0d3e…", "created": true }
```

### `GET /pay/{invoiceId}` — public payment payload (no account)

Never includes the client's email or wallet address. `PUBLIC_BASE_URL` (default `http://localhost:3000`) builds the
URL; the UI renders the QR from `qr_data`. `amount_usd_cents` is what the client pays (the total).

```json
{ "invoice_id": "0d3e…", "invoice_number": "INV-2026-0001", "provider_name": "Amara Design Studio",
  "amount_usd_cents": 10130, "currency": "USD", "due_date": "2026-03-15", "status": "unpaid",
  "escrow_milestone_id": "c9fe85ad-…", "pay_url": "http://localhost:3000/pay/0d3e…",
  "qr_data": "http://localhost:3000/pay/0d3e…", "payment_options_endpoint": "/checkout/options" }
```

### `GET /invoices/{id}` and `GET /invoices?status=unpaid|paid&provider_id=…`

The invoice above; the list is `{ "invoices": [ … ] }` with a `days_overdue` on each (0 when paid or not yet due).
An invoice is paid when its escrow milestone row exists in a state other than `draft`, or after `markInvoicePaid`.

### `GET /invoices/{id}/receipt`

`409` `NOT_PAID` until paid. The on-chain link fields are read from the `receipts` table and are `null` until minted.

```json
{ "receipt_for": "INV-2026-0001", "invoice_id": "0d3e…", "provider_name": "Amara Design Studio", "client_name": "Kofi Traders Ltd",
  "currency": "USD", "line_items": [ … ], "subtotal_cents": 10000, "fee_cents": 130, "fee_payer": "client", "total_paid_cents": 10130,
  "paid_at": null, "payment_reference": null, "escrow_milestone_id": "c9fe85ad-…", "escrow_state": "funded",
  "receipt_token_id": null, "chain_id": null }
```

### `POST /invoices/recurring/run` — issue recurring invoices that are due

```json
{ "now": "2026-04-08T00:00:00Z" }
```

`now` is optional (defaults to the server clock). Occurrence 0 is the milestone's own invoice; occurrence `k` is due
`k` periods after the milestone due date and is issued 7 days before it, with the same fee payer and tax ids. Idempotent.
Response: `{ "now": "…", "issued": [ …invoices with "occurrence": 1 … ] }`.

### `POST /invoices/reminders/run` — SIMULATED reminders

```json
{ "now": "2026-03-12T09:00:00Z" }
```

Unpaid invoices get one reminder of each kind, once: `before_due` (3 days before the due date), `due_today`,
`overdue_7` (7 days after). If several are already past, only the latest is sent. Nothing is emailed.

```json
{ "now": "2026-03-12T09:00:00.000Z", "simulated": true,
  "reminders": [{ "invoice_id": "0d3e…", "invoice_number": "INV-2026-0001", "kind": "before_due", "to_client": "Kofi Traders Ltd",
    "due_date": "2026-03-15", "days_overdue": 0, "amount_usd_cents": 10130, "pay_url": "http://localhost:3000/pay/0d3e…",
    "sent_at": "2026-03-12T09:00:00.000Z", "simulated": true, "message": "Invoice INV-2026-0001 is due on 2026-03-15." }] }
```
