# Product Requirements Document (PRD)

**Product:** Tethran — enforceable, traceable, deliverable payments for Africa's freelancers and agencies

**Version:** Draft v0.3 (12 Nov 2026)

**Event and track:** W3Node Node Engine Hackathon 2026 — Mobile Money & Peer-to-Peer (Tether)

**Open items:** marked **[TBD]**

## What changed (12 Nov 2026)

- `docs/INTERFACES.md` (v0.6) is the source of truth for interfaces; requirements here follow it.
- M4 escrow: `createAndFund` by the treasury with stored parties, vault, timeout and per-milestone hold; client-only approval; disputes only while Funded and before the timeout (extends the timeout by 7 days); two of three attestations decide; refund to the funder; chargeback and rescue refunds (`refundApproved`).
- M6 vault: the spending guard is built into the vault (one per provider); two co-signatures with a deadline; the operator key is effectively the owner and a compromised operator key can drain the vault.
- M5 and M6: the agent never holds keys and has no submit tool; the orchestrator submits after the Policy Service co-signs; new Policy reason codes (`HOLD_ACTIVE`, `BELOW_VAULT_RESERVE`); the tax reserve is measured on the gross milestone amount.
- M14 receipts: the holder is the provider, minted by the treasury after the vault payout (the earlier [TBD] is closed).
- Section 9 (simulated versus real): Stripe is simulated in this build behind the same interface as the real path; identity, mobile money and bank rails are simulated. Each module now carries a build status.
- Decisions recorded: LLM through one provider-agnostic interface (Groq first, Gemini fallback, replay mode); Sepolia primary; own TestUSDT token with EIP-3009; SQLite; Opik cloud. Open questions 3 and 4 are updated.
- Planned or not built yet: payout adapters, reconciliation, x402, a second chain, the web app, invoicing and Stripe checkout.

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
| M4 | Escrow contract | USDT escrow: createAndFund, approve, release, refund, timeout, dispute, chargeback and rescue refunds |
| M5 | Settlement Agent | LLM planner: invoices, evidence review, splits, tax reserve, conversion, anomaly flags. Holds no keys |
| M6 | Policy Service, vault and operator console | Deterministic limits, co-signing, the vault with its built-in spending guard, approval queue. The operator console is not built yet |
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
- FR-1.3 Milestone states: draft, funded, in-review, approved, disputed, released, paid out, refunded (INTERFACES.md section 0 maps them to the on-chain states).
- Status: milestone creation and states are built; contracts with signing are planned.

### M2 Invoicing and collection
- FR-2.1 Generate a USD invoice per milestone with country-specific fields.
- FR-2.2 A pay link and QR code work without a client account.
- FR-2.3 Provider chooses who covers transaction fees.
- FR-2.4 Receipts are automatic; recurring invoices supported.
- FR-2.5 Unpaid invoices are tracked with reminders.
- Status: not built yet.

### M3 Payment bridge
- FR-3.1 Client can pay by card, Apple Pay, Google Pay, PayPal, Cash App Pay (Stripe sandbox) or stablecoin.
- FR-3.2 A verified payment-succeeded webhook, handled idempotently, triggers treasury funding of escrow. The treasury then reads the escrow milestone back and checks it against its own request.
- FR-3.3 Funding source (card or stablecoin) is recorded and drives release rules.
- FR-3.4 The simulated fiat-to-USDT conversion is labelled on screen.
- FR-3.5 A client paying in stablecoin sends it to a treasury deposit address and the treasury funds the escrow. This is a demo simplification and is labelled as such.
- Status: Stripe is simulated in this build behind the same interface as the real path. The webhook (signature check, idempotency, funding, chargeback handling) is built and tested with locally signed events; checkout session creation, the pay link and the payment methods other than card are not built yet. The stablecoin deposit flow is built.

### M4 Escrow contract
- FR-4.1 Only the treasury (FUNDER role) funds a milestone escrow with test USDT, through `createAndFund`. The parties, the provider's vault, the amount, a timeout and the chargeback hold are stored per milestone. The timeout must be at least a minimum set at deployment.
- FR-4.2 Release requires the client's approval (client only, before the timeout) or a dispute decided for the provider. Only the RELEASER role (the treasury) releases, to the stored vault, after the backend's identity check.
- FR-4.3 If nothing happens before the timeout, funds are refundable to the funder (anyone may trigger it) and the off-chain refund is initiated. A dispute that is not decided before the timeout also refunds.
- FR-4.4 Card-funded milestones add a configurable chargeback hold before payout (at most 30 days); stablecoin-funded milestones do not. During the hold the treasury may refund an Approved milestone (chargeback). If no release happens, the funder may refund 3 days after the hold ends (rescue).
- FR-4.5 Dispute outcomes are decided by exactly two of three signed EIP-712 attestations (client, provider, arbiter) from two different parties, verified on-chain, only while Disputed and before the timeout.
- FR-4.6 A dispute can start only while the milestone is Funded and before the timeout, and it extends the timeout to at least 7 days from then. Client approval is final for the client.
- Trust assumption: the treasury is funder and releaser, so the provider relies on the platform to release.
- Status: built, tested and deployed on Sepolia. A client wallet app for approval and dispute is not built yet.

### M5 Settlement Agent
- FR-5.1 Receives contract, milestone, evidence, policy summary, tax profile and corridor data.
- FR-5.2 Returns only schema-valid structured proposals (splits, tax reserve, conversion, payouts, flags, confidence).
- FR-5.3 Summarises delivery evidence for the client or arbiter; never decides releases or disputes.
- FR-5.4 May buy data over x402 within a spending cap.
- FR-5.5 Treats contract text and evidence as untrusted input.
- FR-5.6 The agent holds no keys and has no submit tool. It has read tools, the x402 purchase tools (planned) and `propose_settlement` only. The orchestrator (backend code) submits the vault transaction after the Policy Service co-signs.
- FR-5.7 The model is called through one provider-agnostic interface: Groq first, Gemini as fallback, optional NVIDIA third, and a replay mode. Replies are validated against the schema, retried at most three attempts in total, and a total failure is a rejection (`SCHEMA_INVALID`), never executed as text. Only seeded demo data and redacted text are sent.
- Status: built; the nine seeded scenarios pass against Groq and Gemini and are traced in Opik. x402 purchases are not built yet.

### M6 Policy Service, vault and operator console
- FR-6.1 Each provider has one vault (`ProviderVault`). A transfer needs two co-signatures over the same typed data, which includes a deadline and a per-action id used once: the agent signer module and the Policy Service. Neither can move funds or change policy alone.
- FR-6.2 The Policy Service validates every proposal against: per-transaction cap, daily cap, approved payees, vault minimum reserve, minimum tax reserve (measured on the gross milestone amount) and chargeback hold. Rejections carry reason codes such as `HOLD_ACTIVE` and `BELOW_VAULT_RESERVE` (full list in INTERFACES.md section 2).
- FR-6.3 The spending guard is built into the vault and enforces the payee allowlist, per-transaction cap, daily cap (per UTC day) and minimum reserve on-chain. `vault_min_reserve` is enforced in both the Policy Service and the vault.
- FR-6.4 Policy changes are accepted only when signed by the operator. Changes to the on-chain limits are signed by the operator in the vault's own format and relayed to the vault through `POST /v1/policy`. The operator also signs signer rotation and a withdrawal to the provider's fixed payout address.
- FR-6.5 Violations or low-confidence proposals go to a human approval queue.
- FR-6.6 Every decision is logged with reasons, before anything is signed.
- Trust boundary: the operator key is effectively the owner of the vault. A compromised operator key can drain the vault: it can rotate both co-signers, allow any payee and raise the caps. The two-signature rule and the limits protect against a compromised agent or Policy Service and against mistakes, not against the operator. The fixed payout address constrains only the withdrawal function.
- Status: the Policy Service, co-signing, approval queue and the vault are built and tested; the vault is deployed on Sepolia. Relaying operator-signed limit changes through `POST /v1/policy` is a labelled stub until the operator console is built (not built yet).

### M7 x402
- FR-7.1 The agent pays an x402 endpoint for corridor and tax-rule data.
- FR-7.2 Invoice-status and settlement-proof endpoints are payable via x402.
- Status: planned, not built yet.

### M8 Payout adapters and send-to-phone
- FR-8.1 Common adapter interface: quote, initiate, status.
- FR-8.2 Simulated adapters: M-Pesa, MTN MoMo, Airtel, bank, USDT.
- FR-8.3 Users can send to a phone number resolved through a consented phone-to-wallet registry (simulated).
- Status: the adapters and the registry are not built yet. In the current slice the vault pays an on-chain wallet that stands for a simulated rail, and the payout is marked simulated.

### M9 Country profiles
- FR-9.1 Profiles for NG, KE, ZA, GH define currency, tax identifiers, invoice fields, rails and rule sources.
- FR-9.2 Adding a country requires configuration only.

### M10 Reconciliation and identity
- FR-10.1 Each invoice links to payment, funding, escrow, settlement transactions and the agent trace.
- FR-10.2 Identity-matched release: the verified name on the payment record must match the verified customer before release; mismatches are held and escalated (simulated verification).
- FR-10.3 Tax-ready exports (CSV) per period and country profile.
- FR-10.4 Failed, disputed and suspicious payments are listed in a dedicated queue.
- Status: reconciliation and exports are not built yet; a per-milestone timeline endpoint exists. The identity check is simulated and enforced by the backend before release, not on-chain.

### M14 NFT receipts
- FR-14.1 After the vault payout is confirmed, a non-transferable ERC-721 receipt is minted by the receipt contract. The treasury mints it.
- FR-14.2 The receipt stores the invoice hash, settlement-plan hash, amount, chain ID and release transaction hash. No personal data is stored on-chain.
- FR-14.3 The receipt is verifiable through a public link, read from the chain. The client reaches it through that link. The invoice view is not built yet.
- FR-14.4 Minting happens once per milestone (a second mint reverts).
- FR-14.5 The holder of the receipt is the provider (decided).
- Status: built, tested and deployed on Sepolia.

### M11 Observability
- FR-11.1 Every model and tool call is traced in Opik.
- FR-11.2 The evaluation dataset covers: clean delivery, disputed delivery, injection attempt, over-limit request, unknown payee, low confidence, duplicate send, wrong network, identity mismatch.
- FR-11.3 Online LLM-as-judge scores are recorded per run.
- FR-11.4 A demo dashboard shows runs, scores and guardrail events.
- Status: Opik cloud. One trace per settlement run with a span per LLM attempt and tool call is built, and the nine eval scenarios are traced. Online LLM-as-judge scores, treasury-action tracing and the dashboard are not built yet.

### M12 Wallet experience
- FR-12.1 Self-custodial wallets via WDK for client, provider and subcontractor.
- FR-12.2 A review screen shows recipient address (with saved recipients), network, amount and fee separately before signing.
- FR-12.3 While a payment reference is pending, duplicate sends are blocked.
- FR-12.4 Network mismatches are detected before signing.
- FR-12.5 After a connection loss, the app shows the last known status and rechecks the same transaction on reconnect.
- FR-12.6 Anything above operator limits requires explicit human approval.
- Status: the web app is not built yet (separate workstream). The Policy Service's approval queue exists on the backend side. The runtime for user wallets (browser, React Native or Node) is still **[TBD]**.

### M13 Multi-chain
- FR-13.1 One EVM test network works end to end first. Sepolia is the primary network and the full slice has run on it.
- FR-13.2 All chain access goes through one `ChainClient` interface; chain ID, RPC, USDT and contract addresses come from per-chain config.
- FR-13.3 Milestones, fundings and payouts record the chain used.
- FR-13.4 Additional EVM networks need only redeployment and config.
- FR-13.5 Non-EVM chains (Tron, Solana, TON) need their own contract implementations, built after the EVM flow is complete.
- FR-13.6 The wallet detects which chain it is on and blocks signing on a mismatch (see FR-12.4).
- Status: `ChainClient` and per-chain config are built; it checks that the RPC reports the configured chain id and refuses mainnet chain ids. A second chain is not built yet.

## 6. Agent behaviour requirements

- The agent is advisory and never holds keys. A rejected proposal is a normal outcome and must not be retried in a way that circumvents policy.
- Output conforms to a fixed schema; free text is never executed.
- The agent states confidence and the evidence used.
- The agent refuses instructions embedded in contracts or evidence.
- System prompts follow one skeleton: role, authority, input trust levels, procedure, schema, escalation rules, worked examples.

## 7. Non-functional requirements

- **Security:** Keys kept outside the LLM (the agent signer module is separate from it); each service loads only its own keys; secrets never in prompts, logs or traces; webhook signatures verified. The operator key is effectively the vault owner (FR-6).
- **Auditability:** Append-only audit log of policy decisions, approvals and identity checks. Storage is SQLite.
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
| Stripe checkout (card, wallets, PayPal, Cash App) | Simulated in this build, behind the same interface as the real path. The webhook is verified and tested with locally signed events; checkout creation is not built yet |
| Fiat → USDT conversion | Simulated (test treasury, 1:1) |
| Off-chain refund to the client | Simulated |
| Escrow contract, vault, receipt NFT, transfers | Real on Sepolia, with our own TestUSDT token (not Tether USDT) |
| Stablecoin deposit to the treasury | Real on-chain transfer; a demo simplification |
| Wallets | Services use ethers v6 key wallets; WDK user wallets are planned with the web app |
| x402 payments | Planned, not built yet **(verify)** |
| Identity verification, mobile money, bank payouts | Simulated (the on-chain leg goes to a wallet standing for the rail; adapters not built yet) |
| LLM calls (Groq, Gemini) | Real, with seeded demo data only |
| Opik tracing | Real (Opik cloud); evaluation scoring partly built |

## 10. Success criteria

- Complete flow demonstrable live, including one handled failure.
- All five funding methods demonstrable in the sandbox.
- Seeded evaluation scenarios pass, with traces visible in Opik.
- Public GitHub repository with README; demo video that walks the journey from review to receipt confirmation.

## 11. Assumptions and dependencies

- A self-deployed test token (`TestUSDT`, with EIP-3009) is used; no Tether test USDT is relied on.
- The two-signature vault is a custom contract, because WDK's smart account is single-owner (checked in Phase 0).
- Stripe sandbox wallet methods work on our test devices (not yet checked); Cash App Pay is US-only.
- The project is new work started at the event.

## 12. Open questions

1. Named customer and go-to-market **[TBD]**.
2. Organiser confirmation that an agent-based product fits this track; multi-track entry rules **[TBD]**.
3. LLM provider and model: decided. Groq first (`openai/gpt-oss-120b`), Gemini fallback (`gemini-3.5-flash`), through one interface; model names are configuration.
4. Hosting and deployment target **[TBD]**: services currently run locally and the chain is Sepolia through a hosted RPC; Opik is cloud. Wallet runtime for the web app **[TBD]**.
5. Team ownership of modules **[TBD]**.
6. Exact BuilderBase rubric weights **[TBD]**.
