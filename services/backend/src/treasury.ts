// Treasury service: creates milestones (choosing arbiter and vault), funds the escrow after a verified
// payment, releases after the identity check, and handles refunds and chargebacks.
//
// Money rules this file enforces:
// - Only the treasury key funds escrows (FUNDER role) and releases them (RELEASER role); ChainClient checks
//   the chain and test-network rules, the contracts enforce the rest.
// - Every funding is idempotent on its payment reference (Stripe payment id or deposit tx hash) and on the
//   escrow milestone id; a Stripe event is handled once (event id recorded).
// - After every funding the on-chain milestone is read back and compared with what was asked for
//   (funder, parties, vault, amount, timeout, hold). On a mismatch the milestone is not used.
// - SIMULATED: fiat-to-USDT conversion. A card payment is converted 1 USD = 1 test USDT by minting test USDT
//   to the treasury. Labelled as simulated in the API responses.
// - SIMULATED: identity check (see identity.ts). Enforced here, before release, not on-chain.
// - DEMO SIMPLIFICATION: a client paying in stablecoin sends test USDT to the treasury deposit address and the
//   treasury funds the escrow.
import type { DatabaseSync } from "node:sqlite";
import { getAddress, isAddress, isHexString } from "ethers";
import { assertMilestoneMatches, MilestoneMismatchError } from "../../chain/src/index";
import type { TreasuryChain } from "./chainPort";
import { milestones, vaultOf, type FundingSource, type MilestoneRow, type MilestoneState } from "./db";
import { ApiError, bad, safeErrorMessage } from "./errors";
import type { IdentityCheck } from "./identity";
import { StripeSignatureError, verifyStripeSignature } from "./stripe";

export interface TreasuryConfig {
  chainId: number;
  chainName: string;
  treasuryAddress: string;
  usdtAddress: string;
  /** The platform arbiter: the third signer in a dispute. Never the client or the provider. */
  arbiterAddress: string;
  /** Default escrow timeout for a new milestone, seconds from funding. */
  defaultTimeoutSeconds: number;
  /** Chargeback hold for card-funded milestones (the policy's chargeback_hold_seconds). */
  cardHoldSeconds: number;
  stripeWebhookSecret: string;
}

export interface TreasuryDeps {
  db: DatabaseSync;
  chain: TreasuryChain;
  identity: IdentityCheck;
  config: TreasuryConfig;
  now: () => Date;
}

/** USD cents to USDT base units (6 decimals) at the SIMULATED rate of 1 USD = 1 USDT. */
export function centsToBaseUnits(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) throw new ApiError(400, "amount_usd_cents must be a positive integer");
  return (BigInt(cents) * 10_000n).toString();
}

const ESCROW_TO_DB: Record<string, MilestoneState> = {
  None: "draft", Funded: "funded", Approved: "approved", Disputed: "disputed", Released: "released", Refunded: "refunded",
};

export function createTreasury(deps: TreasuryDeps) {
  const { db, chain, config } = deps;
  const iso = () => deps.now().toISOString();
  const nowS = () => Math.floor(deps.now().getTime() / 1000);

  function need(id: string): MilestoneRow {
    const m = milestones.get(db, id);
    if (!m) throw new ApiError(404, "milestone not found");
    return m;
  }

  /** Brings the database state in line with the escrow (the chain is the authority). Keeps paid_out and in_review. */
  async function sync(id: string): Promise<MilestoneRow> {
    const m = need(id);
    if (m.state === "draft" && !m.escrow_tx) return m;
    const onChain = await chain.milestone(id);
    const mapped = ESCROW_TO_DB[onChain.state];
    const keep = (m.state === "paid_out" && mapped === "released") || (m.state === "in_review" && mapped === "funded");
    if (!keep && mapped !== m.state) milestones.setState(db, id, mapped);
    return need(id);
  }

  return {
    sync,

    /**
     * Creates a draft milestone. The backend picks the arbiter (the platform arbiter) and the provider's vault;
     * the vault is checked on-chain: its payout address must be the provider and its operator must match the record.
     */
    async createMilestone(input: {
      id: string; provider_id: string; title: string; client_address: string; amount_usd_cents: number;
      timeout_seconds?: number; invoice_ref?: string;
    }): Promise<MilestoneRow> {
      if (!/^[0-9a-f-]{36}$/i.test(input.id)) bad("id must be a UUID");
      if (milestones.get(db, input.id)) throw new ApiError(409, "milestone already exists");
      if (!isAddress(input.client_address)) bad("client_address must be an address");
      if (typeof input.title !== "string" || input.title.length === 0 || input.title.length > 200) bad("title is required (max 200 chars)");
      const v = vaultOf(db, input.provider_id, config.chainId);
      if (!v) throw new ApiError(404, "provider has no vault on this chain");
      const onChain = await chain.vaultState(v.vault);
      if (getAddress(onChain.providerPayout) !== getAddress(v.provider_payout) || getAddress(onChain.operator) !== getAddress(v.operator)) {
        throw new ApiError(409, "vault on-chain does not match the provider record", "VAULT_MISMATCH");
      }
      const client = getAddress(input.client_address);
      const provider = getAddress(v.provider_payout);
      const arbiter = getAddress(config.arbiterAddress);
      if (new Set([client, provider, arbiter]).size !== 3) bad("client, provider and arbiter must be three different addresses");
      if (client === getAddress(config.treasuryAddress)) bad("the client cannot be the treasury");

      const timeoutSeconds = input.timeout_seconds ?? config.defaultTimeoutSeconds;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) bad("timeout_seconds must be a positive integer");
      const row: MilestoneRow = {
        id: input.id.toLowerCase(), provider_id: input.provider_id, title: input.title, client_address: client,
        provider_address: provider, arbiter_address: arbiter, vault: getAddress(v.vault),
        amount: centsToBaseUnits(input.amount_usd_cents), amount_usd_cents: input.amount_usd_cents,
        timeout: timeoutSeconds, // seconds after funding; the absolute time is set at funding
        funding_source: null, card_funded: 0, hold_seconds: 0, chain_id: config.chainId, state: "draft",
        escrow_tx: null, release_tx: null, invoice_ref: input.invoice_ref ?? `INV-${input.id.slice(0, 8)}`, created_at: iso(),
      };
      db.prepare(
        `INSERT INTO milestones (id, provider_id, title, client_address, provider_address, arbiter_address, vault, amount,
          amount_usd_cents, timeout, funding_source, card_funded, hold_seconds, chain_id, state, escrow_tx, release_tx, invoice_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, 'draft', NULL, NULL, ?, ?)`,
      ).run(row.id, row.provider_id, row.title, row.client_address, row.provider_address, row.arbiter_address, row.vault,
        row.amount, row.amount_usd_cents, row.timeout, row.chain_id, row.invoice_ref, row.created_at);
      return need(row.id);
    },

    /**
     * Funds the escrow for a draft milestone. Idempotent on `reference` (one funding per payment) and on the
     * milestone (the escrow id can only be funded once). After funding, the on-chain milestone is verified.
     */
    async fund(id: string, source: FundingSource, reference: string): Promise<{ milestone: MilestoneRow; escrow_tx: string; simulated: string[] }> {
      const m = need(id);
      const prior = db.prepare("SELECT * FROM fundings WHERE reference = ?").get(reference) as { milestone_id: string; escrow_tx: string | null; status: string; timeout_at: number; source: string } | undefined;
      if (prior && prior.milestone_id !== id) throw new ApiError(409, "this payment reference already funded another milestone");
      if (prior?.status === "funded") return { milestone: m, escrow_tx: prior.escrow_tx!, simulated: [] };
      if (m.state !== "draft") throw new ApiError(409, `milestone is ${m.state}, not draft`);
      const otherFunding = db.prepare("SELECT reference FROM fundings WHERE milestone_id = ? AND status = 'funded'").get(id);
      if (otherFunding) throw new ApiError(409, "milestone already funded by another payment");

      if (prior && prior.source !== source) throw new ApiError(409, "payment reference was first used with another funding source");
      // The absolute timeout is fixed at the first attempt, so a retry sends exactly the same call.
      const timeoutAt = prior?.timeout_at ?? nowS() + m.timeout;
      if (!prior) {
        db.prepare("INSERT INTO fundings (milestone_id, source, reference, amount, chain_id, timeout_at, escrow_tx, status, at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)")
          .run(id, source, reference, m.amount, config.chainId, timeoutAt, iso());
      } else {
        db.prepare("UPDATE fundings SET status = 'pending' WHERE reference = ?").run(reference);
      }
      const simulated: string[] = [];
      const cardFunded = source === "card";
      const holdSeconds = cardFunded ? config.cardHoldSeconds : 0;
      const request = {
        milestoneId: id, client: m.client_address, provider: m.provider_address, arbiter: m.arbiter_address,
        vault: m.vault, amount: m.amount, timeout: timeoutAt, cardFunded, holdSeconds,
      };
      try {
        if (cardFunded) {
          // SIMULATED fiat-to-USDT conversion: the card payment in USD becomes test USDT in the treasury.
          const minted = await chain.mintTestUsdt(config.treasuryAddress, m.amount, `convert:${reference}`);
          await chain.waitConfirmed(minted.txHash);
          simulated.push("fiat-to-USDT conversion (test USDT minted to the treasury at 1 USD = 1 USDT)");
        }
        const tx = await chain.createAndFund(request, `fund:${id}`);
        await chain.waitConfirmed(tx.txHash);
        const onChain = await chain.milestone(id);
        assertMilestoneMatches(onChain, { ...request, funder: config.treasuryAddress });
        db.prepare("UPDATE fundings SET status = 'funded', escrow_tx = ? WHERE reference = ?").run(tx.txHash, reference);
        milestones.setState(db, id, "funded", { escrow_tx: tx.txHash, funding_source: source, card_funded: cardFunded ? 1 : 0, hold_seconds: holdSeconds });
        return { milestone: need(id), escrow_tx: tx.txHash, simulated };
      } catch (e) {
        const status = e instanceof MilestoneMismatchError ? "mismatch" : "failed";
        db.prepare("UPDATE fundings SET status = ? WHERE reference = ?").run(status, reference);
        if (e instanceof MilestoneMismatchError) throw new ApiError(409, e.message, "FUNDING_MISMATCH");
        throw new ApiError(502, "funding failed: " + safeErrorMessage(e));
      }
    },

    /** DEMO SIMPLIFICATION: where and how much a stablecoin-paying client sends. */
    depositInstructions(id: string) {
      const m = need(id);
      return {
        milestone_id: id, chain_id: config.chainId, network: config.chainName, token: config.usdtAddress,
        token_symbol: "tUSDT (test token)", amount: m.amount, from: m.client_address, deposit_address: config.treasuryAddress,
        note: "Demo simplification: send the exact amount from the client address to the treasury deposit address, then confirm with the transaction hash.",
      };
    },

    /** Confirms a stablecoin deposit by reading the transaction on-chain, then funds the escrow. */
    async confirmDeposit(id: string, txHash: string) {
      const m = need(id);
      if (!isHexString(txHash, 32)) bad("tx_hash must be a 32-byte hex string");
      const transfers = await chain.usdtTransfersInTx(txHash);
      const paid = transfers
        .filter((t) => getAddress(t.from) === m.client_address && getAddress(t.to) === getAddress(config.treasuryAddress))
        .reduce((sum, t) => sum + BigInt(t.value), 0n);
      if (paid === 0n) throw new ApiError(409, "no confirmed test USDT transfer from the client to the treasury in that transaction", "DEPOSIT_NOT_FOUND");
      if (paid < BigInt(m.amount)) throw new ApiError(409, `deposit of ${paid} is less than the milestone amount ${m.amount}`, "DEPOSIT_TOO_SMALL");
      return this.fund(id, "stablecoin", txHash.toLowerCase());
    },

    /**
     * Verified, idempotent Stripe webhook. Handles:
     *   checkout.session.completed (payment_status "paid") and payment_intent.succeeded -> fund (card)
     *   charge.dispute.created and charge.refunded -> chargeback
     * The milestone comes from metadata.milestone_id, which the checkout session sets on itself and on the
     * payment intent (payment_intent_data.metadata), so charges carry it too.
     */
    async handleStripeWebhook(rawBody: string, signatureHeader: string | undefined) {
      try {
        verifyStripeSignature(rawBody, signatureHeader, config.stripeWebhookSecret, nowS());
      } catch (e) {
        throw new ApiError(e instanceof StripeSignatureError ? 400 : 500, "signature verification failed: " + (e as Error).message, "BAD_SIGNATURE");
      }
      let event: { id?: string; type?: string; data?: { object?: Record<string, any> } };
      try {
        event = JSON.parse(rawBody);
      } catch {
        throw new ApiError(400, "body is not JSON");
      }
      if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) bad("not a Stripe event");
      const seen = db.prepare("SELECT outcome FROM stripe_events WHERE event_id = ?").get(event.id!) as { outcome: string } | undefined;
      if (seen) return { event_id: event.id, duplicate: true, outcome: seen.outcome };

      const obj = event.data!.object!;
      const milestoneId: string | undefined = obj.metadata?.milestone_id;
      let outcome = "ignored";
      const record = (o: string) => {
        db.prepare("INSERT OR IGNORE INTO stripe_events (event_id, type, milestone_id, outcome, at) VALUES (?, ?, ?, ?, ?)")
          .run(event.id!, event.type!, milestoneId ?? null, o, iso());
        return { event_id: event.id, duplicate: false, outcome: o };
      };

      if (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded") {
        if (event.type === "checkout.session.completed" && obj.payment_status !== "paid") return record("ignored: not paid");
        if (!milestoneId) return record("ignored: no milestone_id in metadata");
        const m = need(milestoneId);
        const cents = event.type === "checkout.session.completed" ? obj.amount_total : obj.amount_received;
        if (String(obj.currency).toLowerCase() !== "usd" || cents !== m.amount_usd_cents) {
          return record(`rejected: paid ${cents} ${obj.currency}, expected ${m.amount_usd_cents} usd`);
        }
        const reference = String(event.type === "checkout.session.completed" ? obj.payment_intent ?? obj.id : obj.id);
        await this.fund(milestoneId, "card", `stripe:${reference}`);
        outcome = "funded";
      } else if (event.type === "charge.dispute.created" || event.type === "charge.refunded") {
        if (!milestoneId) return record("ignored: no milestone_id in metadata");
        outcome = (await this.chargeback(milestoneId)).outcome;
      }
      return record(outcome);
    },

    /**
     * A card payment was disputed or refunded at Stripe. If the milestone is Approved and still inside its card
     * hold, the RELEASER refunds the escrow to the treasury. Otherwise it is recorded for a human.
     */
    async chargeback(id: string): Promise<{ outcome: string; tx?: string }> {
      const m = await sync(id);
      if (!m.card_funded) return { outcome: "flagged: not card-funded" };
      const onChain = await chain.milestone(id);
      const holdEnd = onChain.approvedAt + onChain.holdSeconds;
      if (onChain.state === "Approved" && nowS() < holdEnd) {
        const tx = await chain.refundApproved(id, `chargeback:${id}`);
        await chain.waitConfirmed(tx.txHash);
        milestones.setState(db, id, "refunded");
        return { outcome: "refunded: chargeback during the hold", tx: tx.txHash };
      }
      return { outcome: `flagged for a human: escrow is ${onChain.state}${onChain.state === "Approved" ? " and the hold has ended" : ""}` };
    },

    /** Releases an Approved milestone to the provider's vault, after the (simulated) identity check. */
    async release(id: string) {
      const m = await sync(id);
      if (m.state === "released" || m.state === "paid_out") return { milestone: m, release_tx: m.release_tx, already: true };
      if (m.state !== "approved") throw new ApiError(409, `milestone is ${m.state}; the client must approve it first`);
      const identity = deps.identity.check(m);
      if (!identity.match) {
        throw new ApiError(409, "release held: payer and customer names do not match (simulated identity check)", "IDENTITY_MISMATCH");
      }
      const onChain = await chain.milestone(id);
      // Only card-funded milestones have a hold. (Comparing a stablecoin milestone's approval time with this
      // clock would misfire: block time can run ahead of the wall clock.) The escrow enforces the hold anyway.
      const holdEnd = onChain.approvedAt + onChain.holdSeconds;
      if (onChain.cardFunded && nowS() < holdEnd) throw new ApiError(409, `card chargeback hold runs until ${new Date(holdEnd * 1000).toISOString()}`, "HOLD_ACTIVE");
      const tx = await chain.release(id, `release:${id}`);
      await chain.waitConfirmed(tx.txHash);
      milestones.setState(db, id, "released", { release_tx: tx.txHash });
      return { milestone: need(id), release_tx: tx.txHash, already: false, identity: { simulated: true, match: true } };
    },

    /**
     * Returns the funds of a milestone to the treasury when the escrow allows it: after the timeout (Funded or
     * Disputed), or the funder's rescue of an Approved milestone after hold + grace. The off-chain refund to the
     * client (Stripe refund) is SIMULATED in this build: no Stripe key is configured.
     */
    async refund(id: string) {
      const m = await sync(id);
      if (m.state === "refunded") return { milestone: m, already: true };
      const onChain = await chain.milestone(id);
      let tx;
      if (onChain.state === "Funded" || onChain.state === "Disputed") {
        if (nowS() < onChain.timeout) throw new ApiError(409, `refund opens at the timeout, ${new Date(onChain.timeout * 1000).toISOString()}`, "TIMEOUT_NOT_REACHED");
        tx = await chain.refund(id, `refund:${id}`);
      } else if (onChain.state === "Approved") {
        tx = await chain.refundApproved(id, `rescue:${id}`); // the escrow enforces hold + 3 days grace
      } else {
        throw new ApiError(409, `escrow is ${onChain.state}; nothing to refund`);
      }
      await chain.waitConfirmed(tx.txHash);
      milestones.setState(db, id, "refunded");
      return {
        milestone: need(id), refund_tx: tx.txHash, already: false,
        offchain_refund: m.funding_source === "card"
          ? { simulated: true, note: "Stripe refund to the client is simulated in this build (no Stripe key configured)" }
          : { simulated: true, note: "Return of the stablecoin deposit to the client is simulated in this build" },
      };
    },
  };
}

export type Treasury = ReturnType<typeof createTreasury>;
