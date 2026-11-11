# Product Requirements Document (PRD)

**Product:** Tethran — enforceable, traceable, deliverable payments for Africa's freelancers and agencies

**Version:** Draft v0.2 (10 November 2026)

**Event and track:** W3Node Node Engine Hackathon 2026 — Mobile Money & Peer-to-Peer (Tether)

**Open items:** marked **[TBD]**

---

## 1. Purpose

Let a freelancer or small agency in Africa invoice any client worldwide, receive funds safely through milestone escrow in USDT, and have an AI agent run the money (splits, tax reserve, conversion, payouts) within limits a human sets and the agent cannot override. Funds reach people through mobile money, bank or phone number, and every payment is tied to a verified identity and an invoice.

## 2. Problem and goals

**The four gaps:** unenforceable promises, untraceable money, dollars that stop at the wallet, and unsafe delegation.

### Goals
- G1. Deliver a working end-to-end flow: contract → funding → escrow → approval → agent-planned settlement → policy-checked execution → payout → reconciliation.
- G2. Support card, Apple Pay, Google Pay, PayPal, Cash App and stablecoin funding (sandbox or simulated).
- G3. Make the wallet experience trustworthy and failure-aware, as Tether's judges asked (section 8).
- G4. Put the LLM at the core of the workflow with layered guardrails and full Opik observability.
- G5. Work Africa-wide through country profiles, with global clients.

### Non-goals (for this build)
- Real money movement, live fiat acceptance, real identity verification or licensed payouts.
- Legal, tax or financial advice.
- Pooled custodial accounts.

## 3. Users

| Persona | Description | Needs |
|---|---|---|
| **Provider** | Freelancer or agency in Africa selling globally | Reliable payment, no chargeback surprises, payouts to phone or bank, tax handling |
| **Client** | Business or person anywhere | Trust that money releases only for delivered work, easy payment methods |
| **Operator** | The provider or agency admin, owner of policy | Set and change limits outside the agent, approve exceptions |
| **Arbiter** | Human who resolves disputes | Summarised evidence, clear decision flow |
| **Subcontractor / recipient** | Receives splits or payouts | On-time delivery to a phone, bank or wallet |

**Named customer:** [TBD]. One concrete real example is needed for the pitch.

## 4. Scope: modules (all in scope)

| ID | Module | Summary |
|---|---|---|
| M1 | Contracts and milestones | Builder, signing, milestone schedule, acceptance criteria |
| M2 | Invoicing and collection | USD invoices, no-account pay link and QR checkout, receipts, fee-payer choice, recurring invoices, unpaid tracker |
| M3 | Payment bridge | Stripe sandbox (card, Apple Pay, Google Pay, PayPal, Cash App) → webhook → treasury → escrow |
| M4 | Escrow contract | USDT escrow: fund, approve, release, refund, timeout, dispute |
| M5 | Settlement Agent | LLM planner: invoices, evidence review, splits, tax reserve, conversion, anomaly flags |
| M6 | Policy Service, vault and operator console | Deterministic limits, co-signing, on-chain spending guard, approval queue |
| M7 | x402 services | Agent pays for data; our APIs are payable |
| M8 | Payout adapters and send-to-phone | Mobile money, bank, USDT; phone-number resolution |
| M9 | Country profiles | NG, KE, ZA, GH currency, tax fields, rails, corridor rules |
| M10 | Reconciliation and identity | Invoice ↔ payment ↔ transaction ↔ trace; identity-matched release; exports |
| M11 | Observability | Opik tracing, evaluations, guardrails, dashboard |
| M12 | Wallet experience | WDK wallets, review screen, fee separation, duplicate blocking, network checks, reconnect handling |
| M14 | NFT receipts | Non-transferable on-chain receipt minted on release, storing hashes only |
| M13 | Multi-chain | Per-chain config and a single `ChainClient` interface; same contracts redeployed on further EVM networks; non-EVM chains later |

## 5. Functional requirements

### M1 Contracts and milestones
- FR-1.1 Provider creates a contract with parties, currency, milestones, amounts and acceptance criteria.
- FR-1.2 Both parties sign; the signed contract hash is recorded.
- FR-1.3 Milestone states: draft, funded, in-review, approved, disputed, released, refunded.

### M2 Invoicing and collection
- FR-2.1 Generate a USD invoice per milestone with country-specific fields.
- FR-2.2 A pay link and QR code work without a client account.
- FR-2.3 Provider chooses who covers transaction fees.
- FR-2.4 Receipts are automatic; recurring invoices supported.
- FR-2.5 Unpaid invoices are tracked with reminders.

### M3 Payment bridge
- FR-3.1 Client can pay by card, Apple Pay, Google Pay, PayPal, Cash App Pay (Stripe sandbox) or stablecoin.
- FR-3.2 A verified payment-succeeded webhook, handled idempotently, triggers treasury funding of escrow.
- FR-3.3 Funding source (card or stablecoin) is recorded and drives release rules.
- FR-3.4 The simulated fiat-to-USDT conversion is labelled on screen.

### M4 Escrow contract
- FR-4.1 Treasury or client funds a milestone escrow with test USDT; a timeout is set.
- FR-4.2 Release requires a valid approval or dispute outcome.
- FR-4.3 If nothing happens before the timeout, funds are refundable and the offchain refund is initiated.
- FR-4.4 Card-funded milestones add a configurable chargeback hold before payout; stablecoin-funded milestones do not.
- FR-4.5 Dispute outcomes are decided by two of three signed attestations (client, provider, arbiter) verified on-chain.

### M5 Settlement Agent
- FR-5.1 Receives contract, milestone, evidence, policy summary, tax profile and corridor data.
- FR-5.2 Returns only schema-valid structured proposals (splits, tax reserve, conversion, payouts, flags, confidence).
- FR-5.3 Summarises delivery evidence for the client or arbiter; never decides releases or disputes.
- FR-5.4 May buy data over x402 within a spending cap.
- FR-5.5 Treats contract text and evidence as untrusted input.

### M6 Policy Service, vault and operator console
- FR-6.1 The vault requires two signatures: agent and Policy Service. No single key can sign alone.
- FR-6.2 The Policy Service validates every proposal against: per-transaction cap, daily cap, approved payees, minimum tax reserve, chargeback hold.
- FR-6.3 A spending guard in the vault contract enforces the same caps on-chain.
- FR-6.4 Policy changes are accepted only when signed by the operator.
- FR-6.5 Violations or low-confidence proposals go to a human approval queue.
- FR-6.6 Every decision is logged with reasons.

### M7 x402
- FR-7.1 The agent pays an x402 endpoint for corridor and tax-rule data.
- FR-7.2 Invoice-status and settlement-proof endpoints are payable via x402.

### M8 Payout adapters and send-to-phone
- FR-8.1 Common adapter interface: quote, initiate, status.
- FR-8.2 Simulated adapters: M-Pesa, MTN MoMo, Airtel, bank, USDT.
- FR-8.3 Users can send to a phone number resolved through a consented phone-to-wallet registry (simulated).

### M9 Country profiles
- FR-9.1 Profiles for NG, KE, ZA, GH define currency, tax identifiers, invoice fields, rails and rule sources.
- FR-9.2 Adding a country requires configuration only.

### M10 Reconciliation and identity
- FR-10.1 Each invoice links to payment, funding, escrow, settlement transactions and the agent trace.
- FR-10.2 Identity-matched release: the verified name on the payment record must match the verified customer before release; mismatches are held and escalated (simulated verification).
- FR-10.3 Tax-ready exports (CSV) per period and country profile.
- FR-10.4 Failed, disputed and suspicious payments are listed in a dedicated queue.

### M14 NFT receipts
- FR-14.1 On release, a non-transferable ERC-721 receipt is minted by the receipt contract.
- FR-14.2 The receipt stores the invoice hash, settlement-plan hash, amount, chain ID and release transaction hash. No personal data is stored on-chain.
- FR-14.3 The receipt is visible in the invoice view and verifiable through a public link.
- FR-14.4 Minting happens once per released milestone and is idempotent.
- FR-14.5 Holder of the receipt **[TBD: payer, provider or both]**.

### M11 Observability
- FR-11.1 Every model and tool call is traced in Opik.
- FR-11.2 The evaluation dataset covers: clean delivery, disputed delivery, injection attempt, over-limit request, unknown payee, low confidence, duplicate send, wrong network, identity mismatch.
- FR-11.3 Online LLM-as-judge scores are recorded per run.
- FR-11.4 A demo dashboard shows runs, scores and guardrail events.

### M12 Wallet experience
- FR-12.1 Self-custodial wallets via WDK for client, provider and subcontractor.
- FR-12.2 A review screen shows recipient address (with saved recipients), network, amount and fee separately before signing.
- FR-12.3 While a payment reference is pending, duplicate sends are blocked.
- FR-12.4 Network mismatches are detected before signing.
- FR-12.5 After a connection loss, the app shows the last known status and rechecks the same transaction on reconnect.
- FR-12.6 Anything above operator limits requires explicit human approval.

### M13 Multi-chain
- FR-13.1 One EVM test network works end to end first.
- FR-13.2 All chain access goes through one `ChainClient` interface; chain ID, RPC, USDT and contract addresses come from per-chain config.
- FR-13.3 Milestones, fundings and payouts record the chain used.
- FR-13.4 Additional EVM networks need only redeployment and config.
- FR-13.5 Non-EVM chains (Tron, Solana, TON) need their own contract implementations, built after the EVM flow is complete.
- FR-13.6 The wallet detects which chain it is on and blocks signing on a mismatch (see FR-12.4).

## 6. Agent behaviour requirements

- The agent is advisory. A rejected proposal is a normal outcome and must not be retried in a way that circumvents policy.
- Output conforms to a fixed schema; free text is never executed.
- The agent states confidence and the evidence used.
- The agent refuses instructions embedded in contracts or evidence.
- System prompts follow one skeleton: role, authority, input trust levels, procedure, schema, escalation rules, worked examples.

## 7. Non-functional requirements

- **Security:** Keys kept outside the agent's process; secrets never in prompts or logs; webhook signatures verified.
- **Auditability:** Append-only audit log of policy decisions, approvals and identity checks.
- **Privacy:** Personal data redacted before model calls where possible; only hashes on-chain.
- **Reliability:** Seed scripts rebuild test-network state.
- **Reproducibility:** Demo scenarios are seeded and repeatable.
- **Mobile-first:** Primary design target is a phone screen with weak connectivity.

## 8. Alignment with the Tether track

| Tether guidance (from the track session) | How it is met |
|---|---|
| Start with one receive flow, one network, a review screen users trust | M12 review screen; single test network |
| Show fees separately from the amount | FR-12.2 |
| Prevent duplicate sends while pending | FR-12.3 |
| Detect network mismatch before signing | FR-12.4 |
| Handle poor connections; recheck on reconnect | FR-12.5 |
| Human has the final say on what is sent | FR-12.6; policy and human review above limits |
| Show a failure handled in the demo; label simulated parts | Seeded failure scenarios; FR-3.4 |
| Use WDK for wallets, balances, fees, signing and transfers | M12 |
| Judging: technical implementation, product design, business functionality | Sections 5 to 7; named customer **[TBD]** |

## 9. Simulated versus real

| Area | Status |
|---|---|
| Stripe checkout (card, wallets, PayPal, Cash App) | Real sandbox integration |
| Fiat → USDT conversion | Simulated (test treasury) |
| Escrow contract, vault, transfers | Real on an EVM test network |
| WDK wallets | Real |
| x402 payments | Real on a test network **(verify)** |
| Identity verification, mobile money, bank, USDT payouts | Simulated adapters |
| Opik tracing and evaluation | Real |

## 10. Success criteria

- Complete flow demonstrable live, including one handled failure.
- All five funding methods demonstrable in the sandbox.
- Seeded evaluation scenarios pass, with traces visible in Opik.
- Public GitHub repository with README; demo video that walks the journey from review to receipt confirmation.

## 11. Assumptions and dependencies

- A test USDT is available on the chosen network, or a self-deployed test token is used.
- WDK provides (or can be combined with) smart-account support for a two-signer vault.
- Stripe sandbox wallet methods work on our test devices; Cash App Pay is US-only.
- The project is new work started at the event.

## 12. Open questions

1. Named customer and go-to-market **[TBD]**.
2. Organiser confirmation that an agent-based product fits this track; multi-track entry rules **[TBD]**.
3. LLM provider and model **[TBD]**.
4. Hosting and deployment target **[TBD]**.
5. Team ownership of modules **[TBD]**.
6. Exact BuilderBase rubric weights **[TBD]**.
