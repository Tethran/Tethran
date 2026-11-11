# Tasks (v0.1)

No timelines. Person A and Person B are role labels; swap them if the strengths are the other way round. Interfaces live in `docs/INTERFACES.md`. After every change, log it in `Development.md`.

**Rule:** anything you cannot finish gets stubbed behind its interface and labelled simulated. Never leave it half-built.

## Phase 0: Verify first (both, in parallel)

Record each answer in `Development.md`, with the fallback if it fails.

| # | Check | Fallback |
|---|---|---|
| V1 | Test USDT exists on the chosen EVM test network (Sepolia recommended) | Deploy our own 6-decimal test token |
| V2 | WDK supports a smart account or multisig, and gasless transfers | Minimal custom 2-of-2 account contract |
| V3 | WDK fiat on-ramp in test mode | Treasury script, labelled simulated |
| V4 | x402 works on an EVM test network | Mock x402 server and client, labelled simulated |
| V5 | Stripe sandbox: card, Apple Pay, Google Pay, PayPal; Cash App Pay (US only) | Card plus whichever wallets work; label the rest |
| V6 | WDK policy hooks | Policy Service only, plus the on-chain guard |
| V8 | WDK module availability and USDT address per extra EVM test network | Use our own test token there |
| V7 | Chosen LLM provider and model; Opik cloud or local | Local Opik |

Also settle: hosting, wallet runtime (browser, React Native or Node), repo created with README and Development.md.

## Person A: chain and trust core

0. `ChainClient` interface and `config/chains.json`; all chain calls go through it.
1. Repo scaffolding for contracts (Hardhat or Foundry), test token, faucet and funding scripts.
2. `MilestoneEscrow`: fund, approve, release, refund, timeout, dispute, card hold. Tests.
3. EIP-712 attestations and 2-of-3 `decide`. Tests.
4. Vault (2-of-2 smart account) and `SpendingGuard` with per-tx cap, daily cap, payee allowlist, minimum reserve. Over-limit rejection test.
5. Policy Service: `/v1/proposals`, rule engine in the documented order, co-signing, `/v1/policy` with operator signature and version check, approvals queue, audit log.
6. Treasury service: Stripe webhook (verified, idempotent) → fund escrow; refund on cancellation; funding-source tracking.
7. Identity-matched release (simulated) with hold and escalation.
7a. `ReceiptNFT` (soulbound ERC-721, hashes only), minted after confirmed release, idempotent per milestone; tests.
8. Wallet layer: WDK wallets, review screen logic, duplicate-send blocking, network-mismatch check, reconnect recheck of the same tx hash.

Exit: the scripted chain run in Phase 1 of the development plan passes from a clean state.

## Person B: product and agent

1. App scaffold (React, mobile-first), backend skeleton, DB tables from INTERFACES.md, seed script.
2. Settlement Agent: system prompts (shared skeleton), tool set, JSON-schema validation, input guards (injection, redaction, delimiting).
3. Opik: traces per run, trace ID on records, dataset for the nine scenarios, experiments, LLM-as-judge, guardrail events, demo dashboard.
4. Contract builder, signing, milestone states.
4a. Receipt view and public verification page.
5. Invoicing: pay link and QR (no account), country fields, receipts, fee-payer choice, recurring invoices, unpaid tracker.
6. Stripe checkout UI for the payment methods that pass V5.
7. Payout adapters (`MobileMoneySim`, `BankSim`, `UsdtSim`), phone registry and send-to-phone.
8. Country profiles (NG, KE, ZA, GH), reconciliation views, failure queue, CSV export.
9. x402: payable endpoints for corridor/tax data, invoice status and settlement proof; agent purchase tool with a spending cap.
10. Operator console, arbiter view, approval queue UI.

Exit: provider creates contract → client funds and approves → agent proposes → Policy Service decides → payout shown reconciled, in more than one country profile.

## Joint

- Once the first EVM chain passes end to end, redeploy the same contracts to a second EVM test network (config only) and use it for the wrong-network demo scenario.
- Agree any change to INTERFACES.md before merging.
- Integration run of the full journey, including one handled failure (duplicate send or wrong network) and all simulated parts labelled on screen.
- Seeded, repeatable demo and a recorded backup video.
- README, public repo, demo video (3 minutes max), pitch (5 minutes plus Q&A), a few slides.
- Human line-by-line review of escrow, vault, guard, attestations, Policy Service rules and key handling before the demo.

## Pending outside the build

- Ask the organiser (Percy): does an agent-based, mobile-first web product fit Mobile Money & P2P, and how does multi-track entry work?
- Check what was submitted at the 9 Nov checkpoint and under which track.
- Named customer and go-to-market: still TBD.
