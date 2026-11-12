// Test doubles: an in-memory escrow, vault and receipt contract behind the TreasuryChain port, a fake
// Policy Service and a fixed LLM. They model the on-chain rules the backend relies on, not every revert.
import { DatabaseSync } from "node:sqlite";
import { Wallet, getAddress, id as keccakUtf8, verifyTypedData } from "ethers";
import type { MilestoneView, ReceiptView, TxRef, VaultState } from "../../chain/src/index";
import { VAULT_TYPES } from "../../chain/src/index";
import { LlmAllFailedError, MemoryTracer } from "../../llm/src/index";
import type { LlmProvider } from "../../llm/src/index";
import { createAgentSigner } from "../src/agentSigner";
import type { TreasuryChain } from "../src/chainPort";
import { openDb } from "../src/db";
import { createIdentityCheck } from "../src/identity";
import { createOrchestrator } from "../src/orchestrator";
import type { Cosignature, PolicyClient, PolicyDecision } from "../src/policyClient";
import { createTreasury } from "../src/treasury";
import { createAgent, loadSavedProposals } from "../src/replay";
import { migrateContracts } from "../src/contracts";
import { migratePayouts } from "../src/payouts";
import { migrateReconciliation } from "../src/reconciliation";

export const CHAIN_ID = 31337;
export const TREASURY = getAddress("0x00000000000000000000000000000000000000a0");
export const ARBITER = getAddress("0x00000000000000000000000000000000000000a1");
export const CLIENT = getAddress("0x00000000000000000000000000000000000000c1");
export const PROVIDER = getAddress("0x00000000000000000000000000000000000000b1");
export const OPERATOR = getAddress("0x00000000000000000000000000000000000000d1");
export const VAULT = getAddress("0x00000000000000000000000000000000000000f1");
export const USDT = getAddress("0x00000000000000000000000000000000000000e1");
export const WEBHOOK_SECRET = "whsec_test_only";
export const M1 = "11111111-1111-4111-8111-111111111111";

export function fakeChain(opts: { now: () => Date; policySigner: string }) {
  const nowS = () => Math.floor(opts.now().getTime() / 1000);
  const escrow = new Map<string, MilestoneView>();
  const balances = new Map<string, bigint>();
  const receipts = new Map<string, ReceiptView>();
  const usedActions = new Set<string>();
  const keys = new Map<string, TxRef>();
  const sent: string[] = [];
  // Deposits by tx hash; blockTime defaults to the harness clock (a test can set an earlier one).
  const deposits = new Map<string, { from: string; to: string; value: string; blockTime?: number }[]>();
  let n = 0;
  let failNextPay = false;
  const bal = (a: string) => balances.get(getAddress(a)) ?? 0n;
  const add = (a: string, v: bigint) => balances.set(getAddress(a), bal(a) + v);

  // Same key returns the same TxRef and does not run the effect twice (as ChainClient does).
  const tx = (key: string, label: string, effect: () => void): TxRef => {
    const prev = keys.get(key);
    if (prev) return prev;
    effect();
    const ref = { txHash: "0x" + (++n).toString(16).padStart(64, "0"), chainId: CHAIN_ID, idempotencyKey: key };
    keys.set(key, ref);
    sent.push(label);
    return ref;
  };
  const need = (id: string) => {
    const m = escrow.get(id);
    if (!m) throw new Error("WrongState(None)");
    return m;
  };

  const chain: TreasuryChain & { approve(id: string): void; fail(): void } = {
    chainId: CHAIN_ID,
    async mintTestUsdt(to, amount, key) { return tx(key, "mint", () => add(to, BigInt(amount))); },
    async createAndFund(p, key) {
      return tx(key, "createAndFund", () => {
        if (escrow.has(p.milestoneId)) throw new Error("MilestoneExists");
        if (bal(TREASURY) < BigInt(p.amount)) throw new Error("insufficient balance");
        add(TREASURY, -BigInt(p.amount));
        escrow.set(p.milestoneId, {
          funder: TREASURY, client: p.client, provider: p.provider, arbiter: p.arbiter, vault: p.vault, amount: p.amount,
          timeout: p.timeout, approvedAt: 0, holdSeconds: p.holdSeconds, cardFunded: p.cardFunded, state: "Funded",
        });
      });
    },
    approve(id) { const m = need(id); m.state = "Approved"; m.approvedAt = nowS(); },
    fail() { failNextPay = true; },
    async release(id, key) {
      return tx(key, "release", () => {
        const m = need(id);
        if (m.state !== "Approved") throw new Error(`WrongState(${m.state})`);
        if (m.cardFunded && nowS() < m.approvedAt + m.holdSeconds) throw new Error("HoldActive");
        m.state = "Released";
        add(m.vault, BigInt(m.amount));
      });
    },
    async refund(id, key) {
      return tx(key, "refund", () => {
        const m = need(id);
        if (nowS() < m.timeout) throw new Error("TimeoutNotReached");
        m.state = "Refunded";
        add(TREASURY, BigInt(m.amount));
      });
    },
    async refundApproved(id, key) {
      return tx(key, "refundApproved", () => {
        const m = need(id);
        if (m.state !== "Approved") throw new Error(`WrongState(${m.state})`);
        m.state = "Refunded";
        add(TREASURY, BigInt(m.amount));
      });
    },
    async vaultExecute(p, key) {
      if (failNextPay) { failNextPay = false; throw new Error("network down"); }
      return tx(key, "vaultExecute", () => {
        if (usedActions.has(p.actionId)) throw new Error("ActionAlreadyUsed");
        if (nowS() > p.deadline) throw new Error("Expired");
        const domain = { name: "TethranVault", version: "1", chainId: CHAIN_ID, verifyingContract: getAddress(p.vault) };
        const value = { to: getAddress(p.to), amount: BigInt(p.amount), proposalHash: p.proposalHash, actionId: p.actionId, deadline: p.deadline };
        const types = { Transfer: [...VAULT_TYPES.Transfer] };
        if (getAddress(verifyTypedData(domain, types, value, p.policySig)) !== getAddress(opts.policySigner)) throw new Error("InvalidPolicySignature");
        verifyTypedData(domain, types, value, p.agentSig);
        if (bal(p.vault) < BigInt(p.amount)) throw new Error("GuardBlocked(BELOW_VAULT_RESERVE)");
        usedActions.add(p.actionId);
        add(p.vault, -BigInt(p.amount));
        add(p.to, BigInt(p.amount));
      });
    },
    async mintReceipt(p, key) {
      return tx(key, "mintReceipt", () => {
        if (receipts.has(p.milestoneId)) throw new Error("AlreadyMinted");
        receipts.set(p.milestoneId, {
          tokenId: receipts.size + 1, holder: p.holder, milestoneId: keccakUtf8(p.milestoneId), invoiceHash: p.invoiceHash,
          settlementHash: p.settlementHash, amount: p.amount, chainId: CHAIN_ID, releaseTx: p.releaseTx, mintedAt: nowS(),
        });
      });
    },
    async setPolicy(p, key) { return tx(key, `setPolicy:${p.version}`, () => {}); },
    async setPayees(p, key) { return tx(key, `setPayees:${p.version}`, () => {}); },
    async decide(id, release, _sigs, _signers, key) {
      return tx(key, "decide", () => {
        const m = need(id);
        if (m.state !== "Disputed") throw new Error(`WrongState(${m.state})`);
        if (release) { m.state = "Approved"; m.approvedAt = nowS(); } else { m.state = "Refunded"; add(TREASURY, BigInt(m.amount)); }
      });
    },
    attestationTypedData(id, kind, release) {
      return {
        domain: { name: "TethranEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: "0x00000000000000000000000000000000000000e5" },
        types: { Attestation: [{ name: "milestoneId", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "releaseToProvider", type: "bool" }] },
        message: { milestoneId: keccakUtf8(id), kind, releaseToProvider: release },
      };
    },
    async milestone(id) {
      return escrow.get(id) ?? {
        funder: TREASURY, client: CLIENT, provider: PROVIDER, arbiter: ARBITER, vault: VAULT, amount: "0", timeout: 0,
        approvedAt: 0, holdSeconds: 0, cardFunded: false, state: "None",
      };
    },
    async vaultState(): Promise<VaultState> {
      return {
        policyVersion: 2, perTxCap: "0", dailyCap: "0", minReserve: "0", spentToday: "0", balance: bal(VAULT).toString(),
        agentSigner: "0x00000000000000000000000000000000000000aa", policySigner: opts.policySigner, operator: OPERATOR, providerPayout: PROVIDER,
      };
    },
    async receiptOf(id) { return receipts.get(id); },
    async balance(a) { return bal(a).toString(); },
    async waitConfirmed() {},
    async usdtTransfersInTx(h) { return (deposits.get(h) ?? []).map((t) => ({ ...t, blockTime: t.blockTime ?? Math.floor(opts.now().getTime() / 1000) })); },
  };
  return { chain, escrow, balances, receipts, sent, deposits, bal, add };
}

/** A Policy Service stand-in that signs every payout of an approved proposal with a real key. */
export function fakePolicy(signer: Pick<Wallet, "signTypedData">, opts: { decision?: PolicyDecision["decision"]; reasons?: string[]; now: () => Date }) {
  const submitted: { milestoneId: string; proposal: any; traceId: string }[] = [];
  const policy: PolicyClient = {
    async listApprovals() { return []; },
    async getPolicy() {
      return { version: 2, policy: { per_tx_cap: "900000000", per_tx_soft_limit: "800000000", confidence_threshold: 0.7, min_tax_reserve_bps: 1000 } };
    },
    async submitProposal(milestoneId, proposal: any, traceId) {
      submitted.push({ milestoneId, proposal, traceId });
      const decision = opts.decision ?? "approved";
      const proposal_hash = "ab".repeat(32);
      if (decision !== "approved") return { decision, reasons: opts.reasons ?? ["LOW_CONFIDENCE"], proposal_hash, approval_id: decision === "escalated" ? "ap-1" : undefined };
      const deadline = Math.floor(opts.now().getTime() / 1000) + 900;
      const cosignatures: Cosignature[] = [];
      for (let i = 0; i < proposal.actions.length; i++) {
        const a = proposal.actions[i];
        if (a.type !== "payout" && a.type !== "mobile_money_payout") continue;
        const to = a.payee_id === "payee_amara" ? getAddress("0x00000000000000000000000000000000000000b2") : getAddress("0x00000000000000000000000000000000000000b3");
        const actionId = keccakUtf8(`${proposal_hash}:${i}`);
        const domain = { name: "TethranVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT };
        const signature = await signer.signTypedData(domain, { Transfer: [...VAULT_TYPES.Transfer] },
          { to, amount: BigInt(a.amount), proposalHash: "0x" + proposal_hash, actionId, deadline });
        cosignatures.push({ action_index: i, action_id: actionId, to, amount: a.amount, deadline, signature });
      }
      return { decision, reasons: [], proposal_hash, cosignatures };
    },
    async decideApproval(_id, decision) {
      if (decision === "new_plan") return { decision: "rejected", reasons: ["NO_PAYOUTS"], proposal_hash: "ab".repeat(32), new_plan_requested: true } as never;
      if (decision !== "approve") return { decision: "rejected", reasons: ["HUMAN_REJECTED"], proposal_hash: "ab".repeat(32) };
      const last = submitted.at(-1)!;
      const signed = await (opts.decision = "approved", policy.submitProposal(last.milestoneId, last.proposal, last.traceId));
      return { ...signed, reasons: ["LOW_CONFIDENCE"] };
    },
  };
  return { policy, submitted };
}

export const GOOD_PROPOSAL = {
  milestone_id: M1,
  confidence: 0.92,
  evidence_used: ["ev-1"],
  actions: [
    { type: "payout", payee_id: "payee_amara", amount: "60000000", asset: "USDT" },
    { type: "mobile_money_payout", payee_id: "payee_kofi", amount: "30000000", provider: "mpesa" },
    { type: "tax_reserve", amount: "10000000", reason: "10 percent reserve" },
  ],
  flags: [],
  needs_human: false,
};

/** A provider that always fails like a rate-limited free tier. */
export function failingLlm(): LlmProvider & { calls: number } {
  const llm = {
    calls: 0,
    async complete(): Promise<never> {
      llm.calls++;
      throw new LlmAllFailedError([{ provider: "groq", model: "m", attempt: 1, reason: "HTTP 429" }]);
    },
  };
  return llm;
}

export function fixedLlm(reply: unknown): LlmProvider & { calls: number } {
  const llm = {
    calls: 0,
    async complete() {
      llm.calls++;
      return { text: JSON.stringify(reply), parsed: reply, usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixed", model: "fixed", latencyMs: 0 };
    },
  };
  return llm;
}

/** A full backend wired to the fakes. `clock` can be moved by tests. */
export function harness(opts: { decision?: PolicyDecision["decision"]; reply?: unknown; mode?: "live" | "replay" | "live+replay"; failLlm?: boolean } = {}) {
  let clock = new Date("2026-11-12T10:00:00Z");
  const now = () => clock;
  const policySigner = Wallet.createRandom();
  const agentKey = Wallet.createRandom();
  const fc = fakeChain({ now, policySigner: policySigner.address });
  const db: DatabaseSync = openDb(":memory:");
  migrateContracts(db);
  migratePayouts(db);
  migrateReconciliation(db);
  db.prepare("INSERT INTO vaults (provider_id, chain_id, vault, operator, provider_payout) VALUES ('prov-1', ?, ?, ?, ?)").run(CHAIN_ID, VAULT, OPERATOR, PROVIDER);
  db.prepare("INSERT INTO payees VALUES ('payee_amara', 'prov-1', 'Amara Studio (demo)', '0x00000000000000000000000000000000000000b2', 'usdt', 0, 'Amara Studio')").run();
  db.prepare("INSERT INTO payees VALUES ('payee_kofi', 'prov-1', 'Kofi Print Works (demo)', '0x00000000000000000000000000000000000000b3', 'mpesa', 1, 'Kofi Print Works')").run();
  const identity = createIdentityCheck(db);
  const tracer = new MemoryTracer();
  const treasury = createTreasury({
    db, chain: fc.chain, identity, now, tracer,
    config: {
      chainId: CHAIN_ID, chainName: "Hardhat local", treasuryAddress: TREASURY, usdtAddress: USDT, arbiterAddress: ARBITER,
      defaultTimeoutSeconds: 7 * 24 * 3600, cardHoldSeconds: 600, stripeWebhookSecret: WEBHOOK_SECRET,
    },
  });
  const { policy, submitted } = fakePolicy(policySigner, { decision: opts.decision, now });
  const llm = opts.failLlm ? failingLlm() : fixedLlm(opts.reply ?? GOOD_PROPOSAL);
  const agentSigner = createAgentSigner(agentKey, async () => policySigner.address, now);
  const agent = createAgent(llm, loadSavedProposals());
  const orchestrator = createOrchestrator({ db, chain: fc.chain, policy, agentSigner, agent, defaultAgentMode: opts.mode ?? "live", tracer, chainName: "Hardhat local", now });
  return {
    db, treasury, orchestrator, identity, tracer, llm, submitted, policySigner, agentKey, ...fc,
    now, setClock: (d: Date) => { clock = d; }, advance: (s: number) => { clock = new Date(clock.getTime() + s * 1000); },
  };
}

export async function fundedAndReleased(h: ReturnType<typeof harness>, id = M1) {
  await h.treasury.createMilestone({ id, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000 });
  h.deposits.set("0x" + "dd".repeat(32), [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n); // the deposit itself
  await h.treasury.confirmDeposit(id, "0x" + "dd".repeat(32));
  // SIMULATED identity verification: the payer is the customer.
  h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, 'Demo Client Ltd', 'Demo Client Ltd', 'SIM-T')").run(id);
  h.chain.approve(id);
  await h.treasury.release(id);
}
