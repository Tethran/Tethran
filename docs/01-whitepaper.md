# Money You Can Trust, Track and Delegate

## Enforceable, Traceable and Deliverable Payments for Africa's Freelancers and Agencies

**Whitepaper — Draft v0.2 (10 November 2026)**

**Status:** Working draft for the W3Node Node Engine Hackathon 2026, Mobile Money & Peer-to-Peer track (Tether). Items marked **[TBD]** are unconfirmed and must be resolved by the team before external use.

| | |
|---|---|
| Product name | Tethran |
| Track | Mobile Money & Peer-to-Peer (sponsored by Tether) |
| Settlement asset | USDT (test token on an EVM test network) |
| Wallet layer | Tether Wallet Development Kit (WDK) |
| Named customer | [TBD] |

---

## 1. Abstract

Freelancers and small agencies across Africa sell to clients worldwide, but getting paid is slow, uncertain and expensive. Promises to pay cannot be enforced, payment legs cannot be tied to verified identities, stablecoin value rarely reaches the mobile wallets where people actually spend, and automating money with AI is unsafe by default.

This paper describes a mobile-first platform in which a **contract becomes a self-enforcing payment workflow**. A client funds a milestone by card, wallet, PayPal, Cash App or stablecoin. The money is locked in a USDT escrow contract. On delivery, an **AI Settlement Agent** proposes how to move it (subcontractor splits, tax reserve, conversion, mobile-money payout). The agent is deliberately **untrusted**: an independent Policy Service, a multi-signature vault with on-chain spending limits, and a human operator enforce the rules. Every payment is reconciled to an invoice and to a verified identity, and every agent decision is traced.

## 2. The problem

### 2.1 Getting paid across borders

- **Slow payment.** An analysis of the 2026 Global Payment Delay Index by Jobbers puts the average wait for Nigerian freelancers at 51 days.
- **Access, FX and tax.** A survey of 1,006 African remote workers found that cross-border payment delays, exchange-rate volatility and unclear tax obligations still frustrate workers and employers.
- **Platform gaps.** Major payment platforms often do not support payouts in African countries or allow receiving but not withdrawing. (Indicative; freelancer-focused sources.)

### 2.2 Peer-to-peer trust

- Fake payment confirmations, reversed bank transfers and accounts frozen over disputed funds are common in P2P crypto trades, and an informal deal carries no consumer protection.
- Typical tricks include marking a trade as paid without paying, sending fake bank alerts and moving conversations off-platform to WhatsApp.

### 2.3 Mobile money's last mile

- Mobile money passed $2 trillion in transactions in 2025, with 2.3 billion registered accounts and 593 million active monthly. Sub-Saharan Africa leads.
- Cross-border integration remains fragmented. Sub-Saharan Africa is the most expensive region for mobile-money remittances at 8.78%, against a 3% UN target. In Q4 2023, fees averaged 33% on $200 transfers from Tanzania to Kenya, Uganda and Rwanda.
- Platforms must work with M-Pesa, bank transfers and other rails at once, because there is no dominant payout rail.

### 2.4 Regulation is tightening

On 5 November 2026 the Central Bank of Nigeria issued its Regulations for the Operations of Non-Security Virtual Assets. Among other things, P2P providers need CBN approval; they must verify that the name and BVN on the naira account match the verified customer before releasing tokens; they must reconcile the crypto and naira legs of each transaction; and they must run procedures for failed, disputed or suspicious transactions. Foreign-currency stablecoins can only be issued through a licensed Nigerian entity with ₦15 billion in capital. Kenya and South Africa are also building frameworks.

### 2.5 Agents holding money are unsafe by default

In May 2026 an attacker drained about $150,000 from Grok's wallet with a prompt injection hidden in Morse code. In February 2026 an autonomous agent called Lobstar Wilde lost about $440,000 after a state-management failure. The lesson drawn by security researchers is that spending limits must live at the wallet or custody layer, not in the system prompt.

### 2.6 Why existing tools fall short

Account products (Grey, Raenest, Payoneer, Wise, Cleva) help people receive money. Billing platforms such as GoFlex automate contracting, invoicing and delivery handoff. Escrow products exist in Africa (PaySureFy, EscrowPay, Truzo). Hackathon projects on Tether's WDK have shown agent policy engines, agent-to-agent escrow and AI-checked freelancer escrow. We did not find a product that combines all of the following for the African freelancer: funding by cards and wallets, identity-matched release, mobile-money delivery and an agent whose limits are enforced outside the model.

## 3. Reframing the problem

"Freelancers cannot get paid" is a symptom. Four gaps sit underneath:

1. **Unenforceable promises.** Pay-on-delivery depends on goodwill.
2. **Untraceable money.** Payment legs are not tied to verified identities, which is why alerts get faked and accounts frozen.
3. **Dollars that stop at the wallet.** Value on-chain does not reach the phone.
4. **Unsafe delegation.** Automating money is risky when the automation can be tricked.

Our answer is money that is **enforceable, traceable, deliverable and safely delegable**.

## 4. Our approach

### 4.1 A contract that pays itself

1. A freelancer or agency creates a **contract** with milestones and acceptance criteria.
2. The client **funds a milestone** by card, Apple Pay, Google Pay, PayPal, Cash App Pay or stablecoin.
3. The funds are **locked in a USDT escrow contract**.
4. On delivery, the client approves, or the dispute process applies.
5. The **Settlement Agent** proposes the settlement plan.
6. The **Policy Service** checks it against operator-set rules and co-signs.
7. Payments execute from a multi-signature vault; **payout adapters** deliver to bank, mobile money or a phone number.
8. Each step is reconciled to the invoice and the verified identities.

### 4.2 How each gap is closed

| Gap | Mechanism |
|---|---|
| Enforceable | Milestone escrow, a chargeback-aware hold for card funding, two-of-three dispute attestations |
| Traceable | Identity-matched release, a reconciliation ledger linking the fiat payment, token transfer and agent trace |
| Deliverable | Mobile-money and bank payout adapters, send-to-phone, stablecoin rails that avoid corridor fees |
| Delegable | Agent proposes; independent signer and on-chain caps enforce; humans review above limits; Opik evaluations |

### 4.3 Design principles

- **The agent proposes; it never holds the keys.** The vault requires two signatures, the agent's and the Policy Service's.
- **Rules live outside the agent.** A human operator sets limits through a separate console. A contract-level spending guard enforces them on-chain as a second line.
- **Humans keep the final say where it matters.** Anything above limits goes to a review screen showing the recipient, network and fee.
- **Defence in depth.** Prompt constraints, schema validation, input guards, deterministic policy, on-chain enforcement, human escalation and post-hoc evaluation.
- **Mobile-first and failure-aware.** The review screen separates fee from amount, blocks duplicate sends while a payment is pending, detects network mismatches before signing and recovers after reconnection.
- **Africa-wide, globally portable.** Country profiles (Nigeria, Kenya, South Africa, Ghana to start) configure currency, tax fields and payout rails.

## 5. How it works

### 5.1 Funding: bridging offchain and onchain
Clients pay through Stripe using card, Apple Pay, Google Pay, PayPal or Cash App Pay. A verified payment-succeeded webhook triggers a treasury service that funds the milestone's escrow with USDT. Stablecoin-funded milestones skip the card step.

**Hackathon scope.** The card side runs against Stripe's sandbox. The fiat-to-USDT conversion is a simulation backed by a test treasury wallet; no real money moves. A production deployment would need licensed on/off-ramp partners.

**Chargeback-aware release.** Card payments can be disputed after the fact. Card-funded milestones therefore release after a configurable hold, while stablecoin-funded ones release immediately.

### 5.2 Escrow
A Solidity escrow contract holds USDT per milestone. It supports funding, approval, release, a timeout refund and disputes. Decisions are made by two of three signed attestations (client, provider, arbiter), verified on-chain.

### 5.3 The Settlement Agent
An LLM placed at the core of the workflow. It interprets contracts, generates invoices, checks delivery evidence against acceptance criteria, plans splits, tax reserve and conversion timing, flags anomalies and pays for data it needs over x402. It returns structured proposals only and cannot move funds alone.

### 5.4 Policy Service, vault and operator console
The vault is a two-of-two smart account (agent key plus Policy Service key). The Policy Service enforces per-transaction and daily caps, an approved payee list, a minimum tax reserve and the chargeback hold. A spending guard in the contract repeats the caps on-chain. Only operator-signed policy changes are accepted.

### 5.5 Identity-matched release
Before release, the system checks that the verified name on the payment record matches the verified customer, and holds or escalates mismatches. This mirrors the traceability direction of Nigeria's new rules. In this build identity checks are simulated.

### 5.6 Mobile money and send-to-phone
Payout adapters (M-Pesa, MTN MoMo, Airtel, bank, USDT) share one interface. A user can send to a phone number resolved to a wallet through a consented registry. In this build adapters are simulated.

### 5.7 Records
Every invoice links to its funding, escrow and settlement transactions and the agent trace, with tax-ready exports per country profile.

### 5.8 Receipts as NFTs
When a milestone is released, a non-transferable (soulbound) ERC-721 receipt is minted on-chain. It stores only hashes of the invoice and settlement plan, the amount, the chain and the transaction reference, so it can be verified by anyone without exposing personal data. Holder of the receipt **[TBD: payer, provider or both]**.

## 6. Why Tether's stack

- **WDK** provides self-custodial wallets for humans, machines and AI agents, with modules for several chains. Because it is self-custodial, keys stay with their owners.
- **USDT** is the settlement asset; fees are shown separately from the amount.
- **Agent tooling:** WDK's agent-oriented tooling lets the agent hold and use a wallet within our policy layer.
- **Testnet:** Development runs on an EVM test network, as Tether recommends for demos.

## 6a. Multi-chain by design

The first build runs on one EVM test network. All chain access sits behind a single interface with per-chain configuration, so the same escrow, vault and spending-guard contracts can be redeployed on other EVM networks with configuration changes. Non-EVM chains such as Tron, Solana and TON would need their own contract implementations and are later work.

## 7. Observability and safety

The agent is instrumented with Opik, an open-source LLM observability platform with tracing, evaluation and guardrails. Every model and tool call is traced. A dataset of seeded scenarios (clean delivery, disputed delivery, prompt-injection attempt, over-limit request, unknown payee, duplicate send, wrong network, identity mismatch) runs as evaluations, and online LLM-as-judge metrics score runs for issues such as hallucination.

## 8. Africa-wide, globally scalable

Country profiles configure currency, tax identifiers, invoice fields, payout rails and corridor rules. Adding a country is configuration, not redesign. The same four gaps exist in other emerging markets, so the workflow generalises.

## 9. Compliance posture

The platform is designed for traceability and minimal custody: funds sit in an escrow contract and a policy-governed vault rather than a pooled operating account, and payments are tied to verified identities. How regulators would classify a production version depends on jurisdiction and licensed partners; Nigeria's November 2026 rules in particular need legal counsel. This hackathon build runs on test networks with simulated payments and is **not legal, tax or financial advice**.

## 10. Limitations and open items

- Fiat acceptance, identity verification and local payouts are sandboxed or simulated.
- LLM behaviour is non-deterministic; guardrails and seeded evaluations reduce but do not eliminate risk.
- **[TBD]** Whether a test USDT exists on the chosen network; fallback is a self-deployed test token.
- **[TBD]** WDK module availability for smart-account (multi-signature) support and fiat on-ramp.
- **[TBD]** Confirmation from the organiser that an agent-based product fits this track and how multi-track entry works.
- **[TBD]** Named customer, team roles, LLM model, hosting.

## 11. Source notes

Figures come from a mix of trade press, industry reports and blogs. Verify each against its primary source before external publication. Key sources: GSMA State of the Industry Report on Mobile Money 2026 and press coverage of it; Jobbers' 2026 Global Payment Delay Index as reported by BusinessDay; the Rayda remote-work report as reported by The African Mirror; Nairametrics coverage of the CBN's 5 November 2026 regulations; Techpoint and TechCabal reporting on Nigerian P2P fraud and escrow products; Spark and Cointelegraph reporting on agent-wallet incidents; Tether and WDK documentation and press; Opik documentation; TechCabal coverage of GoNomads and GoFlex.
