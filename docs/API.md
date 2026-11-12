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

Optional body: `{ "agent_mode": "live" | "replay" | "live+replay" }` (default from `AGENT_MODE`, normally
`live+replay`).

| Mode | What the agent does | `agent_mode` in the response |
|---|---|---|
| `live` | calls the model (Groq, then Gemini) | `"live"` |
| `replay` | serves the saved proposal for the milestone's scenario; no model call | `"Replay"` |
| `live+replay` | live first; if every live attempt fails (for example a free-tier rate limit) it serves the saved proposal | `"live"`, or `"Replay (live failed: HTTP 429)"` |

A replayed proposal gets no special treatment: the Policy Service decides and co-signs it exactly like a live
one, and the vault enforces its limits. `replay_source` says where the saved proposal came from.

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
  "agent_mode": "live",
  "offchain": { "initiated": [1, 2], "count": 2, "simulated": true },
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

Errors: `400` bad agent_mode, `409` milestone not released, `502 POLICY_UNREACHABLE` / `POLICY_ERROR`, `502 PAYOUT_FAILED`
(call again to resume), `409 EXPIRED` (co-signatures older than 15 minutes; the proposal must be made again).

#### `POST /milestones/{id}/escalations/{approvalId}/execute` — act on an escalated settlement

For a settlement that came back `escalated`. The operator's signed decision goes to the Policy Service, which
re-runs every rejecting rule against the current policy and the chain and only then co-signs. A human can
override an escalation reason, never a rejecting rule or an on-chain limit.

```json
{ "decision": "approve", "operator_signature": "0x…" }
```

`operator_signature` is the operator's EIP-712 signature of `ApprovalDecision(string approvalId, string decision,
bytes32 proposalHash)` (domain `TethranPolicy`, version `1`). Response, approved:

```json
{ "decision": "approved", "reasons": ["OVER_SOFT_LIMIT"], "plan_id": 3, "payouts": [ … ], "receipt": { … },
  "trace_id": "…", "settlement_trace_id": "…" }
```

`reasons` are the escalation reasons the human overrode. Rejected: `{ "decision": "rejected", "reasons": [ … ], "plan_id": 3, "trace_id": "…" }`
and nothing is paid. Calling again after an approval resumes the payouts and never pays twice. Errors: `400`, `403`
no signature, `404` no such escalation, `409` not escalated.

#### `POST /milestones/{id}/evidence/summary` — evidence summary for the client or arbiter

No body. A live model call (no replay), traced. Advisory only: it never decides a release or a dispute.

```json
{ "ok": true, "summary": { "summary": "…", "supporting": ["…"], "against": ["…"], "missing": ["…"], "confidence": 0.8,
    "disclaimer": "…" }, "trace_id": "…" }
```

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
- `POST /internal/vault-actions` `{ "vault": "0x…", "actions": [ …operator-signed vault actions… ] }` → submits them
  in order with the treasury account (gas only, no authority) → `{ "transactions": [{ "type": "setPolicy", "version": 7, "tx": "0x…" }] }`

### Checkout (built; Simulated until Stripe keys are set)

Two providers behind one interface. With `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set, sessions are real
Stripe Checkout Sessions (test mode) and Stripe calls `POST /webhooks/stripe`. Without them the checkout is
**Simulated**: completing a session produces the same Stripe-format event, signed the way Stripe signs it, and
hands it to the same webhook handler, so signature verification, once-only handling and the amount check run for
real. No money moves and no Stripe account is used.

#### `GET /checkout/options`

```json
{ "provider": "simulated", "simulated": true, "label": "Simulated: no money moves and no Stripe account is used",
  "methods": [
    { "id": "card", "label": "Card", "via": "stripe" },
    { "id": "apple_pay", "label": "Apple Pay", "via": "stripe", "note": "Shown by Stripe on supported devices and browsers" },
    { "id": "google_pay", "label": "Google Pay", "via": "stripe", "note": "Shown by Stripe on supported devices and browsers" },
    { "id": "paypal", "label": "PayPal", "via": "stripe", "note": "Availability depends on the Stripe account's country" },
    { "id": "cashapp", "label": "Cash App Pay", "via": "stripe", "note": "US customers only" },
    { "id": "stablecoin", "label": "Stablecoin (test USDT)", "via": "treasury_deposit", "note": "Demo simplification: pay the treasury deposit address" }
  ] }
```

#### `POST /checkout/sessions` — start paying a draft milestone

```json
{ "milestone_id": "c9fe85ad-…", "method": "google_pay" }
```

```json
{ "session_id": "cs_sim_3f…", "provider": "simulated", "simulated": true, "milestone_id": "c9fe85ad-…", "method": "google_pay",
  "amount_usd_cents": 10000, "currency": "usd", "status": "open", "url": "http://localhost:3000/pay/simulated/cs_sim_3f…", "label": "Simulated" }
```

With real Stripe, `url` is the Stripe-hosted page and `label` is `"Stripe (test mode)"`. For `"stablecoin"` the
response carries `deposit` (the same object as `GET /milestones/{id}/deposit`) and the client confirms with
`POST /milestones/{id}/deposit/confirm`. Errors: `400` unknown method, `404`, `409` milestone already paid.

#### `GET /checkout/sessions/{id}` (Simulated only) — the session, as above

#### `POST /checkout/sessions/{id}/complete` (Simulated only) — the client finishes paying

```json
{ "outcome": "paid" }
```

`outcome` is `paid`, `failed` or `cancelled`. A paid session sends a signed `checkout.session.completed` event
through the webhook path:

```json
{ "session": { "status": "paid", "…": "…" }, "already": false,
  "webhook": { "event_id": "evt_sim_…", "duplicate": false, "outcome": "funded", "trace_id": "…" } }
```

The escrow is funded card-funded, with the chargeback hold. Completing again returns `already: true`.

#### `POST /checkout/sessions/{id}/dispute` (Simulated only) — a chargeback on a paid session

Sends a signed `charge.dispute.created` event. Inside the card hold the escrow is refunded to the treasury
(`"outcome": "refunded: chargeback during the hold"`); after it the case is flagged for a human.

### Wallets: WDK user wallets and the review screen (built)

The client, payee and subcontractor wallets are Tether WDK wallets (`@tetherto/wdk` core with
`@tetherto/wdk-wallet-evm`), derived from one BIP-39 test seed (`DEMO_WALLET_SEED`). Roles: `client` (account 0),
`payee_amara` (1), `subcontractor` (2), `client_b` (3). A WDK transaction policy on every account allows only
test-USDT transfers up to a cap, raw transactions only to the escrow, and EIP-712 signing; WDK refuses anything else.
**Demo custody:** in the product these wallets live on the user's device; here a demo wallet service holds the test
seed. Every response says so in `custody`. Treasury, Policy Service, agent signer and operator keys are not WDK wallets.

- `GET /wallets` → `{ "wallets": [{ "role": "client", "address": "0x0234…", "chain_id": 11155111 }, …], "provider": "Tether WDK (…)", "custody": "…" }`
- `GET /wallets/{role}/balance` → `{ "usdt": { "base_units": "100000000", "display": "100 tUSDT (test token)" }, "gas": { "wei": "…", "display": "0.004 ETH (test)" }, … }`
- `GET|POST /wallets/{role}/recipients` — saved recipients, `{ "name": "Tethran treasury (demo)", "address": "0x…" }`

#### `POST /wallets/{role}/transfers/review` — what the review screen shows; nothing is signed

```json
{ "to": "0x7076…B09e", "amount": "100000000", "chain_id": 11155111, "payment_reference": "deposit:c9fe85ad-…" }
```

```json
{ "from": "0x0234…", "recipient": { "address": "0x7076…", "saved_name": "Tethran treasury (demo)", "saved": true },
  "network": { "name": "Sepolia", "chain_id": 11155111 },
  "amount": { "base_units": "100000000", "display": "100 tUSDT (test token)" },
  "fee": { "wei": "11067732", "display": "0.000000000011067732 ETH (test), estimated", "paid_in": "ETH" },
  "payment_reference": "deposit:c9fe85ad-…", "can_sign": true, "blocked": [], "custody": "…" }
```

The fee is shown separately from the amount. `blocked` lists every reason it cannot be signed:
`WRONG_NETWORK` (the app's `chain_id` is not the wallet's chain, or the RPC is not that chain),
`DUPLICATE_PENDING` (same payment reference still pending), `ALREADY_SENT`, `BAD_ADDRESS`, `BAD_AMOUNT`,
`NO_REFERENCE`, `WALLET_POLICY` (the WDK policy refuses it), `FEE_UNAVAILABLE`.

#### `POST /wallets/{role}/transfers` — sign and send (same body)

Runs the same checks and refuses before signing: `409 WRONG_NETWORK`, `409 DUPLICATE_PENDING`, `409 ALREADY_SENT`,
`409 WALLET_POLICY`, `400` bad input. Then WDK signs and sends:
`{ "payment_reference": "…", "tx_hash": "0x178e…", "status": "pending", "fee": { … }, "custody": "…" }`.
If the outcome is unknown (`502 SEND_UNKNOWN`), the reference stays blocked; it is never sent twice.

#### `GET /wallets/transfers/{payment_reference}` — reconnect: recheck the same transaction

`{ "payment_reference": "…", "status": "pending" | "confirmed" | "failed" | "unknown", "tx_hash": "0x…", "rechecked": true, "last_known": "pending" }`.
It reads the same hash from the chain and never resubmits. A failed transaction frees the reference.

#### `POST /wallets/{role}/escrow/{milestoneId}/approve|dispute` — the client's own escrow action

Signed by the role's WDK wallet (the client approves; the client or provider disputes):
`{ "role": "client", "milestone_id": "…", "action": "approve", "tx_hash": "0x…", "signed_by": "Tether WDK wallet", "custody": "…" }`.

#### `POST /wallets/{role}/attestations/{milestoneId}` — sign a dispute attestation (EIP-712)

`{ "kind": "client", "release_to_provider": false }` → `{ "signer": "0x…", "signature": "0x…", "release_to_provider": false, "custody": "…" }`.
Pass the result to `POST /arbiter/disputes/{id}/attestations`.

### Identity (built; SIMULATED verification)

#### `POST /milestones/{id}/identity` — record the verified names (simulated verification provider)

`{ "payer_verified_name": "Demo Client Ltd", "customer_verified_name": "Demo Client Ltd" }` →
`{ "milestone_id": "…", "simulated": true, "simulated_id_ref": "SIM-ID-c9fe85ad", "note": "SIMULATED verification: …" }`.

The release check is **strict**: no identity record, or names that differ, hold the release
(`409 IDENTITY_MISMATCH` on `POST /milestones/{id}/release`) and open an identity hold for the operator.

### Operator (built)

- `GET /operator/queue` → `{ "identity_holds": [{ "milestone_id": "…", "reason": "payer and customer names differ", "status": "open", "opened_at": "…" }], "policy_approvals": [ …Policy Service pending approvals… ], "reconciliation_queue": "/reconciliation/queue", "simulated_identity": true }`
- `GET /operator/identity-holds/{milestoneId}/typed-data?decision=release|hold` → the EIP-712 payload to sign:
  domain `{ "name": "TethranOperator", "version": "1", "chainId": 11155111 }`, type `IdentityDecision(string milestoneId, string decision)`.
- `POST /operator/identity-holds/{milestoneId}/decision` `{ "decision": "release", "operator_signature": "0x…" }`.
  The signature must recover to the provider's vault operator. `release` releases the escrow at once:
  `{ "milestone_id": "…", "decision": "release", "released": true, "release": { "release_tx": "0x…", … } }`. `hold` keeps it held.
  Errors: `403` signature, `404` no hold, `409` already decided.
- Limits, payees and the approval queue are set through the Policy Service (`POST /v1/policy`,
  `POST /v1/approvals/{id}/decision`); escalated settlements are executed with
  `POST /milestones/{id}/escalations/{approvalId}/execute`; the audit log is `GET /v1/audit` on the Policy Service.

### Arbiter (built)

- `GET /arbiter/disputes` → `[{ "milestone_id": "…", "title": "…", "amount": "100000000", "timeout": 1794500000, "attestations": [ … ], "evidence_summary": "/milestones/…/evidence/summary" }]`
- `GET /arbiter/disputes/{id}/typed-data?kind=client|provider|arbiter&release_to_provider=true|false` → the escrow's
  `Attestation` typed data (domain `TethranEscrow` v1, chain id, escrow address).
- `POST /arbiter/disputes/{id}/attestations` `{ "signer": "0x…", "signature": "0x…", "release_to_provider": false }`.
  The signer must be the client, provider or arbiter of that milestone and the signature must be theirs for that
  outcome. With one: `{ "recorded": true, "decided": false, "waiting_for": "one more party with the same outcome" }`.
  With two different parties agreeing, the backend submits `escrow.decide` (anyone may; the signatures decide):
  `{ "recorded": true, "decided": true, "outcome": "refund to funder", "decide_tx": "0x…", "state": "refunded" }`.

### Treasury traces

Every treasury action (`POST /milestones`, deposit confirm, webhook, release, refund, chargeback) is one Opik
trace with its chain calls as spans. Responses carry `trace_id`; the funding record stores it too.

### Planned (INTERFACES.md section 4 and the build plan)

`POST /payouts/{id}/status`, reconciliation, wallet review endpoints, operator and arbiter endpoints (Blocks 3 and
4). They are added to this file as they are built.

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
  "version": 2, "operator_signature": "0x…",
  "vault": "0xeE59D8994620A9125641b36848A636E04e24feA8",
  "vault_actions": [
    { "type": "setPolicy", "version": 7, "perTxCap": "1000000000", "dailyCap": "1000000000000", "minReserve": "0", "operator_signature": "0x…" },
    { "type": "setPayees", "version": 8, "payees": ["0x…", "0x…"], "allowed": true, "operator_signature": "0x…" }
  ] }
```

Two kinds of operator signature, as decided:

- `operator_signature` signs the whole document (all fields, including the off-chain-only ones: soft limit, tax
  share, confidence threshold, hold length) with `PolicyDocument(uint256 version, bytes32 policyHash)`, domain
  `TethranPolicy` v1. It must recover to the operator and `version` must be the next one.
- each `vault_actions` entry is signed in the vault's own format (`SetPolicy`, `SetPayees`, domain `TethranVault`
  v1 with the chain id and vault address). Each must recover to the vault's **on-chain** operator (which must be
  the operator above), and the versions must continue from the vault's on-chain `policyVersion`.

After the actions, the vault's limits must equal the document's `per_tx_cap`, `daily_cap` and `vault_min_reserve`,
and every payee on `payee_allowlist` must be allowed on the vault; otherwise `409` "the policy and the vault would
disagree". `vault_actions` can be empty when only off-chain fields change. The actions are relayed to the vault
(through the backend) and confirmed **before** the new policy becomes active; if the relay fails the policy is not
changed (`502`). Response:

```json
{ "policy": { … }, "version": 3, "vault": "0xeE59…", "vault_transactions": [{ "type": "setPolicy", "version": 7, "tx": "0x2bba…" }] }
```

Errors: `400` malformed, `403` a signature does not verify, `409` wrong version or policy and vault would disagree,
`502` relay failed.

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

## Payouts, phone registry and reconciliation (built; rails simulated)

Code: `services/backend/src/payouts.ts`, `phoneRegistry.ts`, `reconciliation.ts`. Everything about mobile money (M-Pesa,
MTN MoMo, Airtel), bank transfers, phone lookup, fees and FX rates is **simulated** (`simulated: true`); no external
call is made. The on-chain leg (the vault pays the rail's deposit wallet) is done by the settlement orchestrator; these
adapters handle the off-chain leg after it. Status flow of a leg: `pending` → `processing` → `delivered` | `failed`,
driven by the clock (pending 5 s, then processing until the rail's expected time) and by `advance` for the demo.

Forcing a failure for the demo: body `{ "fail": "timeout" | "rejected" }` on the status route, or pay exactly
`13130000` (timeout) or `13140000` (rejected) base units.

Simulated price list: M-Pesa 1.5% (KES 129.00 per USDT, 30 s), MTN MoMo 1.0% (GHS 15.50, 60 s), Airtel 1.2%
(UGX 3700.00, 60 s), bank 0.5% with a 1 USDT minimum (NGN 1500.00, 10 min), USDT no fee, immediate. The fee is
deducted from the amount; the local amount is computed on the net amount.

### `POST /payouts/quote`

```json
{ "rail": "mpesa", "amount": "100000000", "country": "KE" }
```

`country` is optional (rail default). Rails: `usdt`, `mpesa`, `mtn_momo`, `airtel`, `bank`.

```json
{
  "simulated": true, "rail": "mpesa", "country": "KE", "amount": "100000000", "fee": "1500000", "net_amount": "98500000",
  "fx": { "simulated": true, "label": "Simulated FX rate, not a market rate: 1 USDT = 129.00 KES", "base": "USDT", "quote": "KES", "rate": "129.000000" },
  "local_amount": "12706.50", "currency": "KES", "expected_seconds": 30, "expected": "about 30 seconds (simulated)"
}
```

### `GET /payouts?milestone_id=…` and `GET /payouts/{id}`

`{id}` is the on-chain payout id (the `payouts` row). `offchain` is `null` until the leg is initiated.

```json
{
  "id": 2, "milestone_id": "c9fe85ad-…", "payee_id": "payee_kofi", "rail": "mpesa", "amount": "30000000",
  "to_address": "0x…b3", "chain_id": 11155111, "tx": "0x…", "onchain_status": "confirmed", "onchain_simulated": true, "at": "…",
  "offchain": {
    "simulated": true, "adapter": "MobileMoneySim", "provider_ref": "SIM-MPESA-3F9A1C2B7D10", "status": "processing", "reason": null,
    "fee": "450000", "net_amount": "29550000", "local_amount": "3811.95", "currency": "KES", "country": "KE", "fx_rate": "129.000000",
    "expected_seconds": 30, "initiated_at": "…", "updated_at": "…", "delivered_at": null
  }
}
```

The list is `{ "simulated": true, "payouts": [ … ] }`. `404` unknown payout.

### `POST /payouts/{id}/status`

Returns the current status after advancing, and starts the off-chain leg if it has not started. Body may be empty.

```json
{ "advance": true, "fail": "rejected" }
```

`advance: true` moves the leg one step (pending → processing → terminal). `fail` marks the leg to fail when it ends.
Response is the same object as `GET /payouts/{id}`; a failed leg has `"status": "failed", "reason": "rejected by the recipient's provider (simulated)"`.
`409 NOT_CONFIRMED` when the on-chain payout has not confirmed; `400` bad `fail` value.

### Phone registry (FR-8.3, simulated)

Only an HMAC-SHA256 hash of the E.164 number is stored (salt from `PHONE_HASH_SALT`; a labelled demo default is used
if unset). Plain numbers are never stored or returned. No ownership check by SMS (simulated).

#### `POST /phone-registry`

```json
{ "phone": "+234 801 234 4567", "rail": "mpesa", "wallet_address": "0x…b2", "account_ref": "optional", "consent": true }
```

`consent` must be exactly `true` (`400 CONSENT_REQUIRED`). Same number, same wallet: idempotent. Active number to a
different wallet: `409 ALREADY_REGISTERED`.

```json
{ "simulated": true, "phone_hash": "9c1e…(64 hex)", "phone_masked": "+234•••••4567", "rail": "mpesa", "consented": true, "consent_at": "…" }
```

#### `DELETE /phone-registry/{phoneHash}` — withdraw consent

The wallet and account reference are erased; the hash and timestamps stay for audit.
`{ "simulated": true, "phone_hash": "…", "consented": false, "consent_withdrawn_at": "…" }`. `404` unknown hash.

#### `POST /phone-registry/resolve`

Body `{ "phone": "+2348012344567" }`. Never returns the wallet address.

```json
{ "simulated": true, "phone_masked": "+234•••••4567", "country": "NG", "registered": true, "consented": true, "rail": "mpesa", "phone_hash": "…" }
```

Unknown or withdrawn: `"registered": false, "consented": false, "rail": null`.

#### `POST /send-to-phone`

Body `{ "phone": "+254711000111", "amount": "100000000" }`. Resolves only; **does not move money**. The caller turns the
payee into a payout. `404 NOT_REGISTERED` if unknown or consent withdrawn.

```json
{
  "simulated": true, "note": "Resolved only. No money was sent; …", "phone_masked": "+254•••••0111",
  "payee": { "payee_id": "phone_9c1e4a7b2d10", "name": "Phone +254•••••0111", "address": "0x…b2", "rail": "mpesa", "simulated": true, "verified_name": null, "phone_hash": "…" },
  "amount": "100000000", "quote": { "…": "same as POST /payouts/quote" }
}
```

### Reconciliation (M10)

Built from the existing tables. The country comes **only** from the contract's country profile (through the
milestone's invoice). There is no default: a milestone without one has `country: null` and a `NO_COUNTRY_PROFILE`
gap, and `export.csv` refuses with `409 NO_COUNTRY_PROFILE` naming the milestones. `reconciliation_meta` now only
carries a printed invoice number.

#### `GET /reconciliation/milestones/{id}`

```json
{
  "milestone_id": "c9fe85ad-…", "state": "paid_out", "country": "KE", "complete": true, "gaps": [],
  "invoice": { "number": "INV-001", "invoice_ref": "INV-001", "title": "…", "amount": "100000000", "amount_usd_cents": 10000, "issued_at": "…", "provider_id": "prov-demo" },
  "payment": { "funding_source": "card", "card_funded": true, "simulated_fiat_conversion": true, "fundings": [ { "id": 1, "source": "card", "reference": "…", "amount": "100000000", "escrow_tx": "0x…", "status": "funded", "at": "…" } ], "stripe_events": [] },
  "escrow_tx": "0x…", "release_tx": "0x…",
  "settlement_plan": { "id": 1, "decision": "paid_out", "proposal_hash": "…", "trace_id": "…", "reasons": [], "at": "…" },
  "payouts": [ { "id": 1, "rail": "usdt", "amount": "60000000", "tx": "0x…", "status": "confirmed", "simulated": false } ],
  "offchain_legs": [ { "simulated": true, "payout_id": 2, "adapter": "MobileMoneySim", "rail": "mpesa", "provider_ref": "SIM-MPESA-…", "status": "delivered", "reason": null, "fee": "450000", "local_amount": "3811.95", "currency": "KES", "country": "KE" } ],
  "receipt": { "token_id": 1, "mint_tx": "0x…", "holder": "0x…", "chain_id": 11155111, "at": "…" },
  "identity": { "match": true, "simulated": true },
  "totals": { "gross": "100000000", "tax_reserve": "10000000", "paid_onchain": "90000000", "fees": "450000", "net_paid": "89550000", "fees_simulated": true }
}
```

`complete` is true when there are no gaps and the receipt exists (or the milestone is refunded). Each gap is
`{ code, severity: "problem" | "info", message, record: { table, id } }`. Codes: `FUNDING_FAILED`, `FUNDING_MISMATCH`,
`ESCROW_TX_MISSING`, `PAID_NOT_RELEASED` (info), `RELEASED_NOT_SETTLED`, `PAYOUT_NOT_CONFIRMED`, `OFFCHAIN_LEG_MISSING`
(info), `OFFCHAIN_IN_FLIGHT` (info), `OFFCHAIN_FAILED`, `SETTLED_NO_RECEIPT`, `IDENTITY_MISMATCH`. `404` unknown milestone.

#### `GET /reconciliation?from=&to=&country=`

`from` and `to` are ISO dates (a date-only `to` includes that whole day), matched on the invoice date. `country` is a code such as `KE`.

```json
{ "count": 1, "complete": 1, "items": [ { "milestone_id": "…", "invoice_number": "INV-001", "state": "paid_out", "country": "KE", "gross": "100000000", "complete": true, "gaps": [] } ] }
```

#### `GET /reconciliation/queue`

Failed, disputed and suspicious items, each with a reason and the record it points to. Kinds: `funding_failed`,
`funding_mismatch`, `dispute_or_chargeback`, `disputed_milestone`, `plan_rejected`, `plan_escalated`, `payout_failed`,
`offchain_failed` (simulated), `identity_mismatch` (simulated).

```json
{ "count": 1, "items": [ { "kind": "offchain_failed", "reason": "off-chain leg failed after the on-chain payout confirmed: provider timeout (simulated)", "milestone_id": "…", "record": { "table": "offchain_payouts", "id": 2 }, "at": "…", "simulated": true } ] }
```

#### `GET /reconciliation/export.csv?from=&to=&country=`

`Content-Type: text/csv`, CRLF lines, RFC 4180 quoting; text fields starting with `=`, `+`, `-` or `@` get a leading
`'` (spreadsheet formula guard). Amounts are decimal USDT (6 places). The handler returns
`{ "__raw": true, "contentType": "text/csv", "body": "…", "filename": "tethran-reconciliation.csv" }` and the HTTP layer sends the body as is.

```
invoice_number,invoice_date,country,funded_at,settled_at,gross,fee,tax_reserve,net_paid,currency,chain_id,escrow_tx,release_tx,payout_txs,receipt_id,receipt_mint_tx,trace_id,complete
INV-001,2026-11-12,KE,2026-11-12T10:00:00.000Z,2026-11-12T10:00:00.000Z,100.000000,0.450000,10.000000,89.550000,USDT,11155111,0x…,0x…,0x…;0x…,1,0x…,trace-…,true
```

`fee` is the simulated off-chain rail fee; `net_paid` is the on-chain payouts minus that fee; `tax_reserve` comes from the approved plan.

## x402 (pay-per-request data)

Implemented directly from the x402 message format, scheme `exact`. This backend is its own facilitator: it
verifies the EIP-3009 `TransferWithAuthorization` and settles it on-chain on TestUSDT through ChainClient (the
treasury pays gas; `payTo` is the treasury). Hosted facilitators settle USDC on their own networks, not our test
token, so none is used. The payment is real on the test network; **the data served is demo data** and says so
(`simulated_data: true`).

| Resource | Price (base units) |
|---|---|
| `GET /x402/corridor-rules?corridor=US-KE` | 20000 (0.02 tUSDT) |
| `GET /x402/fx-quote?to=KES` (NGN, KES, ZAR, GHS) | 10000 |
| `GET /x402/invoices/{id}/status` | 10000 |
| `GET /x402/milestones/{id}/settlement-proof` | 10000 |

`GET /x402` lists them (free).

Flow: a request without `X-PAYMENT` gets `402` and `{ x402Version: 1, error, accepts: [requirement] }`. The
requirement has `scheme`, `network` (`eip155:<chainId>`), `maxAmountRequired`, `resource`, `payTo`, `asset`,
`maxTimeoutSeconds` and `extra: { name, version }` (the token's EIP-712 domain). The client retries with
`X-PAYMENT`: base64 of `{ x402Version, scheme, network, payload: { signature, authorization: { from, to, value,
validAfter, validBefore, nonce } } }`. The server checks network, payee, amount, validity window, signature and
nonce, settles, waits for the receipt and answers `200` with the data and an `X-PAYMENT-RESPONSE` header (base64
`{ success, transaction, network, payer }`). The same authorization sent again is answered from the record and
never settled twice; a nonce already used on-chain is refused.

**Agent purchase tool.** During a settlement in `live` or `live+replay` mode, the orchestrator (not the model)
buys corridor rules and an FX quote for the contract's country and passes them to the agent as untrusted
`paid_data`. It pays from the WDK `agent_budget` wallet (account 4 of the demo seed). Two caps: the client refuses
before signing when a purchase would pass `X402_CAP_PER_RUN` (default 50000 = 0.05 tUSDT per settlement run), and
the WDK signing policy refuses any authorization above 1 tUSDT or for another token. A failed or over-cap purchase
never blocks a settlement; it is recorded in the trace. Nothing is bought in `replay` mode.

## Demo seed

`DEMO_MODE=1 CHAIN=<chain> npm run seed` (in `services/backend`) rebuilds the demo state; see `docs/DEMO.md`.
`POST /milestones` accepts an optional `scenario` (one of the nine seeded names), which selects the saved proposal
in `replay` mode. `POST /milestones/{id}/settle` without `agent_mode` uses the server's `AGENT_MODE` (it used to
fall back to `live`).
