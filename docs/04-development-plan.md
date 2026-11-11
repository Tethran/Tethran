# Development Plan

**Product:** Tethran

**Version:** Draft v0.2 (10 November 2026)

**Track:** Mobile Money & Peer-to-Peer (Tether), built on WDK and an EVM test network

**Format:** Phases only. No timelines or time estimates. Phases may overlap across team members; each has exit criteria instead of dates.

---

## Working conventions

- **Development.md** is kept in every repo, logging each change and why it was made.
- No AI attribution lines (such as Co-Authored-By) in commits or pull requests.
- Everything in the PRD is in scope. Nothing is labelled optional; sequencing only decides what is built first.
- All networks are test networks. Never use mainnet funds. Seed scripts must rebuild state from nothing.
- Ownership of each phase is **[TBD]** until the team split is agreed.
- This is new work started during the event; commit history should show it.

---

## Phase 0 — Foundations and verification

**Objective:** Settle the unknowns that shape the build.

**Work**
- Confirm LLM provider and model, hosting, Opik deployment mode and wallet runtime (browser, React Native or Node).
- Create the repository with README and Development.md.
- Work through the verification checklist in the Architecture document (section 15): test USDT or own token, WDK smart-account support, WDK fiat on-ramp, x402 on an EVM test network, Stripe sandbox wallet behaviour, WDK policy hooks.
- Ask the organiser to confirm that an agent-based product fits the Mobile Money & P2P track, and how multi-track entry works.
- Read the BuilderBase rubric for exact scoring weights.

**Exit criteria:** Every checklist item has a recorded answer; any failed assumption has a chosen fallback.

---

## Phase 1 — Wallets and chain core

**Objective:** The ledger layer works without AI or UI.

**Work**
- WDK wallets for client, provider, subcontractor, treasury and agent.
- Test USDT (or self-deployed token) with six decimals; faucet and funding scripts.
- Escrow contract: fund, approve, release, refund, timeout, with tests.
- Vault as a two-signer smart account; spending guard contract; tests for over-limit rejection.
- Typed-attestation verification (client, provider, arbiter).

- `ReceiptNFT` contract (non-transferable ERC-721, hashes only) minted after release, with tests.
- `ChainClient` interface and a per-chain config file from the start; contracts deployable to any EVM network.
- Second EVM test network deployment once the first is passing (same contracts, config only).

**Exit criteria:** A scripted run funds an escrow, approves with two of three attestations, releases to the vault, pays out with two signatures, rejects an over-limit transfer on-chain and refunds a timed-out escrow, repeatably from a clean state.

---

## Phase 2 — Policy Service and operator console

**Objective:** Limits are enforced outside the agent and controlled by a human.

**Work**
- Policy Service as a separate process holding the second signing key.
- Rule engine: per-transaction cap, daily cap, approved payees, minimum tax reserve, chargeback hold.
- Operator-signed policy updates with version checks, written to the on-chain guard.
- Human approval queue for violations and low confidence.
- Append-only audit log of decisions with reasons.

**Exit criteria:** Policy tests pass for allowed, blocked and escalated cases; an operator change takes effect on-chain; an unsigned change is rejected.

---

## Phase 3 — Settlement Agent, guardrails and observability

**Objective:** The LLM sits at the core, constrained and observable.

**Work**
- Intensive system prompts per role using the shared skeleton.
- Structured output schema with strict validation.
- Tooling: read tools, x402 purchase tools, propose and submit tools; WDK agent tooling where verified.
- Input guards: injection detection, redaction, untrusted-content delimiting.
- Opik integration: traces per run, spans per call, trace ID stored with records.
- Evaluation dataset and experiments for all nine seeded scenarios.
- Online LLM-as-judge metrics and guardrail event logging.

**Exit criteria:** The agent produces valid proposals for the seeded scenarios; injection and over-limit cases are blocked by the guardrail layers; traces and scores are visible in Opik.

---

## Phase 4 — Payment bridge and identity

**Objective:** Offchain payments connect to onchain escrow, tied to verified identities.

**Work**
- Stripe sandbox checkout with card, Apple Pay, Google Pay, PayPal and Cash App Pay.
- Verified, idempotent webhook handler.
- Treasury service that funds escrow after payment success and refunds on cancellation.
- Funding-source tracking and the chargeback hold for card-funded milestones.
- Simulated identity service and identity-matched release with hold and escalation on mismatch.
- Clear UI labelling of simulated conversion and verification.

**Exit criteria:** A sandbox payment by each method results in a funded escrow; a cancelled milestone refunds both legs; card-funded and stablecoin-funded milestones follow different release rules; a name mismatch holds a release.

---

## Phase 5 — Wallet experience and resilience

**Objective:** The wallet flow is trustworthy on a phone with weak connectivity.

**Work**
- Review screen: recipient, network, amount and fee shown separately; saved recipients.
- Pending-reference tracking that blocks duplicate sends.
- Network-mismatch detection before signing.
- Reconnect handling that rechecks the same transaction hash and never resubmits.
- Human approval step for anything above operator limits.
- Mobile-first layout and testing on real phones.

**Exit criteria:** Each failure case (duplicate send, wrong network, dropped connection, over-limit) is demonstrable and handled with a clear message.

---

## Phase 6 — Product surfaces

**Objective:** The workflow is usable end to end.

**Work**
- Contract builder with milestones, signing and contract-hash recording.
- Invoicing: country-specific fields, no-account pay link and QR checkout, receipts, fee-payer choice, recurring invoices, unpaid tracker and reminders.
- Provider dashboard, client pay and approval view, operator console, arbiter view.
- Country profiles for Nigeria, Kenya, South Africa and Ghana.
- Reconciliation views, failed and disputed payment queue, CSV exports.

- Receipt view and public verification page.

**Exit criteria:** A provider can create a contract, issue an invoice, have a client fund and approve, and see settlement reconciled in more than one country profile.

---

## Phase 7 — Machine payments and payout rails

**Objective:** The remaining feature set is complete.

**Work**
- x402 endpoints for corridor and tax rules, invoice status and settlement proof.
- Agent purchases data over x402 within a spending cap.
- Payout adapters with a common interface: M-Pesa, MTN MoMo, Airtel, bank and USDT simulations.
- Phone registry and send-to-phone with consent.

**Exit criteria:** The agent pays for data and uses it in a plan; payouts complete through each simulated rail; a phone-number send resolves and delivers.

---

## Phase 8 — Hardening, demo and submission

**Objective:** A reliable demonstration and complete submission assets.

**Work**
- Seeded, repeatable demo covering the full journey from review to receipt confirmation, with one handled failure and simulated parts labelled on screen.
- Failure rehearsal: faucet failure, LLM variance, test-network issues; fallbacks and a recorded backup video.
- Public repository with README; Development.md complete.
- Demo video; pitch of five minutes plus Q and A; a few slides.
- Named-customer and go-to-market sections finalised **[TBD]**.

**Exit criteria:** A clean-state run of the demo passes end to end; every required submission item exists.

---

## External gates (see the event schedule for dates)

| Gate | Required content |
|---|---|
| Team lock | Teams of one to four; each teammate applies and is accepted individually |
| Checkpoint (mandatory) | Project concept; technical foundation; team status update. Confirm what was submitted and under which track. |
| Final submission | Project title, public repository with README, demo video link, submitted on BuilderBase |
| Judging | Pitch plus Q and A; at least one team member present at the venue; criteria are technical implementation, product design and business functionality |

---

## Risks tracked through the phases

| Risk | Mitigation |
|---|---|
| No test USDT on the chosen network | Self-deployed token (Phases 0 and 1) |
| WDK lacks the smart-account support we need | Minimal custom account contract (Phase 1) |
| LLM variance in the demo | Seeded scenarios, evaluations, recorded backup (Phases 3 and 8) |
| Non-EVM chains need separate contracts | Build EVM first behind `ChainClient`; Tron, Solana and TON are separate work after the EVM flow is complete |
| Two-signer vault complexity | Early scripted proof (Phase 1) |
| Scope breadth across a team | Clear module ownership and a shared Development.md |
| Track fit questioned | Early confirmation from the organiser (Phase 0); pitch led by mobile money and P2P |
| Regulatory questions from judges | Clear simulated-versus-real labelling; traceability design; no legal-advice claims |

---

## Open items

Named customer, go-to-market, LLM model, hosting, Opik deployment, wallet runtime, module ownership, organiser confirmation of track fit: all **[TBD]**.
