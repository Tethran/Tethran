import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, verifyTypedData } from "ethers";
import { ServiceError } from "../src/service";
import { transferDomain, transferTypes } from "../src/cosign";
import {
  ATTESTATION_KIND,
  attestationDomain,
  attestationTypes,
  onChainMilestoneId,
  policyHash,
} from "../src/typed";
import type { Policy } from "../src/index";
import { goodProposal, policy as basePolicy, withActions } from "./helpers";
import { VAULT_PAYEES_TYPES, VAULT_POLICY_TYPES } from "../src/vaultActions";
import { CHAIN_ID, ESCROW, escalatingProposal, makeHarness, signApproval, signPolicy, submit, VAULT } from "./service-helpers";

const MILESTONE = "11111111-1111-4111-8111-111111111111";

async function expectError(p: Promise<unknown> | (() => unknown), status: number) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert.ok(e instanceof ServiceError, "expected a ServiceError, got " + String(e));
    assert.equal(e.status, status);
    return e;
  }
  assert.fail("expected an error");
}

// ---- proposals ----

test("approved: returns co-signatures that recover to the Policy signer, and audits first", async () => {
  const h = makeHarness();
  const r = await submit(h);
  assert.equal(r.decision, "approved");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.cosignatures?.length, 1); // one payout; the tax_reserve gets none
  const s = r.cosignatures![0];
  const value = { to: s.to, amount: s.amount, proposalHash: "0x" + r.proposal_hash, actionId: s.action_id, deadline: s.deadline };
  assert.equal(verifyTypedData(transferDomain(CHAIN_ID, VAULT), transferTypes, value, s.signature), h.policySigner.address);
  // valid for 15 minutes from the service clock
  assert.equal(s.deadline, Date.parse("2026-11-12T10:00:00Z") / 1000 + 900); // the harness clock
  assert.equal(s.amount, "450000000");

  const rows = h.audit.list({ milestone_id: MILESTONE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "approved");
  assert.equal(rows[0].proposal_hash, r.proposal_hash);
  assert.equal(rows[0].trace_id, "trace-1");
  assert.equal(rows[0].policy_version, 1);
});

test("escalated: no signatures, a pending approval is created, audit row exists", async () => {
  const h = makeHarness();
  const r = await submit(h, escalatingProposal());
  assert.equal(r.decision, "escalated");
  assert.deepEqual(r.reasons, ["NEEDS_HUMAN"]);
  assert.equal(r.cosignatures, undefined);
  assert.ok(r.approval_id);
  const pending = h.service.listApprovals("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, r.approval_id);
  assert.equal(h.audit.list().length, 1);
  assert.equal(h.audit.list()[0].decision, "escalated");
});

test("rejected: no signatures, no approval, reasons and audit row", async () => {
  const h = makeHarness();
  const r = await submit(h, withActions([{ type: "payout", payee_id: "payee-1", amount: "1000000001", asset: "USDT" }]));
  assert.equal(r.decision, "rejected");
  assert.ok(r.reasons.includes("OVER_PER_TX_CAP"));
  assert.equal(r.cosignatures, undefined);
  assert.equal(h.service.listApprovals("pending").length, 0);
  assert.deepEqual(h.audit.list()[0].reasons, r.reasons);
});

test("schema-invalid proposal is rejected and logged without reading the chain", async () => {
  let reads = 0;
  const h = makeHarness({
    chain: {
      async vaultFor() { reads++; throw new Error("no"); },
      async vaultState() { reads++; throw new Error("no"); },
      async milestoneFacts() { reads++; throw new Error("no"); },
      async payees() { reads++; throw new Error("no"); },
      async vaultPolicy() { reads++; throw new Error("no"); },
      async vaultPayeeAllowed() { reads++; throw new Error("no"); },
      chainId: () => CHAIN_ID,
    },
  });
  const r = await submit(h, { nonsense: true });
  assert.equal(r.decision, "rejected");
  assert.deepEqual(r.reasons, ["SCHEMA_INVALID"]);
  assert.equal(reads, 0);
  assert.equal(h.audit.list().length, 1);
  assert.equal(h.audit.list()[0].milestone_id, "unknown");
});

test("daily cap uses the chain's spentToday and the reserve uses the chain balance", async () => {
  const h = makeHarness();
  h.fake.state.spentToday = "1700000000"; // 1700 + 450 > 2000
  const r = await submit(h);
  assert.equal(r.decision, "rejected");
  assert.deepEqual(r.reasons, ["OVER_DAILY_CAP"]);
});

test("duplicate proposal: second identical proposal is rejected with DUPLICATE_PROPOSAL and no signatures", async () => {
  const h = makeHarness();
  const first = await submit(h);
  assert.equal(first.decision, "approved");
  const second = await submit(h, goodProposal(), "trace-2");
  assert.equal(second.decision, "rejected");
  assert.ok(second.reasons.includes("DUPLICATE_PROPOSAL"));
  assert.equal(second.cosignatures, undefined);
  assert.equal(h.audit.list().length, 2);
});

test("a chain read failure is an error, not a guessed decision", async () => {
  const h = makeHarness({
    chain: {
      async vaultFor() { throw new Error("rpc https://example.invalid/key123 failed"); },
      async vaultState() { throw new Error("x"); },
      async milestoneFacts() { throw new Error("x"); },
      async payees() { throw new Error("x"); },
      async vaultPolicy() { throw new Error("x"); },
      async vaultPayeeAllowed() { throw new Error("x"); },
      chainId: () => CHAIN_ID,
    },
  });
  const e = await expectError(submit(h), 502);
  assert.ok(!e.message.includes("key123"), "URL must be removed from the message");
  assert.equal(h.audit.list().length, 0);
});

test("audit is written before signing: a failing signer leaves a row and returns an error, never a signature", async () => {
  const h = makeHarness({
    signer: {
      async signTypedData() {
        throw new Error("signer exploded");
      },
    },
  });
  await expectError(submit(h), 500);
  const rows = h.audit.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "approved");
});

test("missing trace_id or proposal is a 400", async () => {
  const h = makeHarness();
  await expectError(h.service.submitProposal({ proposal: goodProposal() }), 400);
  await expectError(h.service.submitProposal({ trace_id: "t" }), 400);
  await expectError(h.service.submitProposal("text"), 400);
});

// ---- policy ----

/** The operator's vault-format SetPolicy action for a document's on-chain limits. */
async function vaultSetPolicy(h: ReturnType<typeof makeHarness>, version: number, doc: Policy, by: { signTypedData: Wallet["signTypedData"] } = h.operator) {
  const v = { version, perTxCap: doc.per_tx_cap, dailyCap: doc.daily_cap, minReserve: doc.vault_min_reserve };
  const domain = { name: "TethranVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT };
  return { type: "setPolicy" as const, ...v, operator_signature: await by.signTypedData(domain, VAULT_POLICY_TYPES, v) };
}

async function vaultSetPayees(h: ReturnType<typeof makeHarness>, version: number, payees: string[], allowed: boolean) {
  const v = { version, payees, allowed };
  const domain = { name: "TethranVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT };
  return { type: "setPayees" as const, ...v, operator_signature: await h.operator.signTypedData(domain, VAULT_PAYEES_TYPES, v) };
}

function nextPolicy(version: number, extra: Partial<Policy> = {}): Policy {
  return { ...basePolicy, version, per_tx_cap: "900000000", ...extra };
}

test("getPolicy returns the active policy and version", () => {
  const h = makeHarness();
  assert.deepEqual(h.service.getPolicy(), { policy: basePolicy, version: 1 });
});

test("setPolicy with a good operator signature and version + 1 is applied, audited, and its vault actions relayed", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  const sig = await signPolicy(h.operator, 2, doc);
  const action = await vaultSetPolicy(h, 3, doc);
  const r = await h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig, vault: VAULT, vault_actions: [action] });
  assert.equal(r.version, 2);
  assert.deepEqual(h.service.getPolicy().policy, doc);
  assert.equal(h.policyStore.history().length, 2);
  assert.equal(h.chainWriter.calls.length, 1);
  assert.equal(h.chainWriter.calls[0].vault, VAULT);
  assert.deepEqual(h.chainWriter.calls[0].actions.map((a) => [a.type, a.version]), [["setPolicy", 3]]);
  assert.equal(r.vault_transactions.length, 1);
  const row = h.audit.list({ milestone_id: "policy" })[0];
  assert.equal(row.proposal_hash, policyHash(doc).slice(2));
  // new policy is used by the next proposal
  const r2 = await submit(h, withActions([{ type: "payout", payee_id: "payee-1", amount: "950000000", asset: "USDT" }, { type: "tax_reserve", amount: "50000000", reason: "t" }]));
  assert.ok(r2.reasons.includes("OVER_PER_TX_CAP"));
});

test("setPolicy rejects a signature from the wrong signer", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  const sig = await signPolicy(Wallet.createRandom(), 2, doc);
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig }), 403);
  assert.equal(h.service.getPolicy().version, 1);
  assert.equal(h.chainWriter.calls.length, 0);
});

test("setPolicy rejects a signature over a different document", async () => {
  const h = makeHarness();
  const sig = await signPolicy(h.operator, 2, nextPolicy(2));
  await expectError(h.service.setPolicy({ policy: nextPolicy(2, { per_tx_cap: "999999999" }), version: 2, operator_signature: sig }), 403);
});

test("setPolicy rejects an unsigned change and a garbage signature", async () => {
  const h = makeHarness();
  await expectError(h.service.setPolicy({ policy: nextPolicy(2), version: 2 }), 403);
  await expectError(h.service.setPolicy({ policy: nextPolicy(2), version: 2, operator_signature: "0x1234" }), 403);
  assert.equal(h.service.getPolicy().version, 1);
});

test("setPolicy rejects the same version, +2 and lower versions even with a valid signature", async () => {
  const h = makeHarness();
  for (const v of [1, 3, 0]) {
    const doc = nextPolicy(v);
    const sig = await signPolicy(h.operator, v, doc);
    await expectError(h.service.setPolicy({ policy: doc, version: v, operator_signature: sig }), 409);
  }
  assert.equal(h.service.getPolicy().version, 1);
});

test("setPolicy rejects an invalid policy document", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2, { per_tx_soft_limit: "2000000000" }); // soft limit above the cap
  const sig = await signPolicy(h.operator, 2, doc);
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig }), 400);
  await expectError(h.service.setPolicy({ policy: "nope", version: 2, operator_signature: sig }), 400);
});

test("setPolicy rejects policy.version different from version", async () => {
  const h = makeHarness();
  const doc = nextPolicy(5);
  const sig = await signPolicy(h.operator, 2, doc);
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig }), 400);
});

// ---- approvals ----

test("approvals: operator approves an escalated proposal and gets co-signatures", async () => {
  const h = makeHarness();
  const esc = await submit(h, escalatingProposal());
  const id = esc.approval_id!;
  const sig = await signApproval(h.operator, id, "approve", esc.proposal_hash);
  const r = await h.service.decideApproval(id, { decision: "approve", operator_signature: sig });
  assert.equal(r.decision, "approved");
  assert.equal(r.cosignatures?.length, 1);
  assert.equal(h.service.listApprovals("pending").length, 0);
  assert.equal(h.service.listApprovals("approved").length, 1);
  const rows = h.audit.list();
  assert.equal(rows.length, 2); // the escalation and the human approval
  assert.equal(rows[1].decision, "approved");
});

test("approvals: reject is audited and returns no signatures", async () => {
  const h = makeHarness();
  const esc = await submit(h, escalatingProposal());
  const id = esc.approval_id!;
  const sig = await signApproval(h.operator, id, "reject", esc.proposal_hash);
  const r = await h.service.decideApproval(id, { decision: "reject", operator_signature: sig });
  assert.equal(r.decision, "rejected");
  assert.equal(r.cosignatures, undefined);
  assert.equal(h.service.listApprovals("rejected").length, 1);
  assert.equal(h.audit.list()[1].decision, "rejected");
});

test("approvals: a second decision is refused", async () => {
  const h = makeHarness();
  const esc = await submit(h, escalatingProposal());
  const id = esc.approval_id!;
  const sig = await signApproval(h.operator, id, "approve", esc.proposal_hash);
  await h.service.decideApproval(id, { decision: "approve", operator_signature: sig });
  await expectError(h.service.decideApproval(id, { decision: "approve", operator_signature: sig }), 409);
  const rejectSig = await signApproval(h.operator, id, "reject", esc.proposal_hash);
  await expectError(h.service.decideApproval(id, { decision: "reject", operator_signature: rejectSig }), 409);
});

test("approvals: approve is refused when a rejecting rule now fails", async () => {
  const h = makeHarness();
  const esc = await submit(h, escalatingProposal());
  const id = esc.approval_id!;
  h.fake.state.spentToday = "1999000000"; // the chain's daily limit is now used up
  const sig = await signApproval(h.operator, id, "approve", esc.proposal_hash);
  const r = await h.service.decideApproval(id, { decision: "approve", operator_signature: sig });
  assert.equal(r.decision, "rejected");
  assert.ok(r.reasons.includes("OVER_DAILY_CAP"));
  assert.equal(r.cosignatures, undefined);
  assert.equal(h.service.listApprovals("rejected").length, 1);
  assert.equal(h.audit.list()[1].decision, "rejected");
});

test("approvals: a non-operator signature is refused and the approval stays pending", async () => {
  const h = makeHarness();
  const esc = await submit(h, escalatingProposal());
  const id = esc.approval_id!;
  const sig = await signApproval(Wallet.createRandom(), id, "approve", esc.proposal_hash);
  await expectError(h.service.decideApproval(id, { decision: "approve", operator_signature: sig }), 403);
  // a signature for "reject" cannot be used to approve
  const rejectSig = await signApproval(h.operator, id, "reject", esc.proposal_hash);
  await expectError(h.service.decideApproval(id, { decision: "approve", operator_signature: rejectSig }), 403);
  assert.equal(h.service.listApprovals("pending").length, 1);
});

test("approvals: unknown id is 404, bad decision is 400, bad status filter is 400", async () => {
  const h = makeHarness();
  await expectError(h.service.decideApproval("nope", { decision: "approve", operator_signature: "0x00" }), 404);
  await expectError(h.service.decideApproval("nope", { decision: "maybe", operator_signature: "0x00" }), 400);
  await expectError(async () => h.service.listApprovals("weird"), 400);
});

test("approvals: a signing failure after approval leaves the audit row and returns an error", async () => {
  const h = makeHarness({ signer: { async signTypedData() { throw new Error("boom"); } } });
  const esc = await submit(h, escalatingProposal());
  const sig = await signApproval(h.operator, esc.approval_id!, "approve", esc.proposal_hash);
  await expectError(h.service.decideApproval(esc.approval_id!, { decision: "approve", operator_signature: sig }), 500);
  assert.equal(h.audit.list().length, 2);
});

// ---- attestations ----

async function attest(wallet: { signTypedData: Wallet["signTypedData"] }, milestone: string, kind: number, release: boolean) {
  return wallet.signTypedData(attestationDomain(CHAIN_ID, ESCROW), attestationTypes, {
    milestoneId: onChainMilestoneId(milestone),
    kind,
    releaseToProvider: release,
  });
}

test("attestation verify: true for the right signer, kind, outcome and milestone", async () => {
  const h = makeHarness();
  const client = Wallet.createRandom();
  const signature = await attest(client, MILESTONE, ATTESTATION_KIND.client, true);
  const base = { milestone_id: MILESTONE, type: "client", signer: client.address, signature, release_to_provider: true };
  assert.deepEqual(h.service.verifyAttestation(base), { valid: true });

  assert.deepEqual(h.service.verifyAttestation({ ...base, signer: Wallet.createRandom().address }), { valid: false }); // wrong signer
  assert.deepEqual(h.service.verifyAttestation({ ...base, type: "provider" }), { valid: false }); // wrong kind
  assert.deepEqual(h.service.verifyAttestation({ ...base, release_to_provider: false }), { valid: false }); // wrong outcome
  assert.deepEqual(h.service.verifyAttestation({ ...base, milestone_id: "22222222-2222-4222-8222-222222222222" }), { valid: false }); // wrong milestone
  assert.deepEqual(h.service.verifyAttestation({ ...base, signature: "0x1234" }), { valid: false }); // malformed signature
});

test("attestation verify: provider and arbiter kinds map to 1 and 2", async () => {
  const h = makeHarness();
  const w = Wallet.createRandom();
  for (const [type, kind] of [["provider", 1], ["arbiter", 2]] as const) {
    const signature = await attest(w, MILESTONE, kind, false);
    assert.deepEqual(h.service.verifyAttestation({ milestone_id: MILESTONE, type, signer: w.address, signature, release_to_provider: false }), { valid: true });
  }
});

test("attestation verify: a signature for another escrow or chain is invalid", async () => {
  const h = makeHarness();
  const w = Wallet.createRandom();
  const signature = await w.signTypedData(attestationDomain(CHAIN_ID + 1, ESCROW), attestationTypes, {
    milestoneId: onChainMilestoneId(MILESTONE),
    kind: 0,
    releaseToProvider: true,
  });
  assert.deepEqual(h.service.verifyAttestation({ milestone_id: MILESTONE, type: "client", signer: w.address, signature, release_to_provider: true }), { valid: false });
});

test("attestation verify: bad input is a 400", async () => {
  const h = makeHarness();
  const ok = { milestone_id: MILESTONE, type: "client", signer: Wallet.createRandom().address, signature: "0x00", release_to_provider: true };
  await expectError(async () => h.service.verifyAttestation({ ...ok, type: "judge" }), 400);
  await expectError(async () => h.service.verifyAttestation({ ...ok, signer: "nope" }), 400);
  await expectError(async () => h.service.verifyAttestation({ ...ok, release_to_provider: undefined }), 400);
  await expectError(async () => h.service.verifyAttestation({ ...ok, milestone_id: "" }), 400);
});

// ---- audit and secrets ----

test("getAudit filters by milestone", async () => {
  const h = makeHarness();
  await submit(h);
  await submit(h, { ...goodProposal(), milestone_id: "other" });
  assert.equal(h.service.getAudit().length, 2);
  assert.equal(h.service.getAudit("other").length, 1);
});

test("no key material in any result, error or audit row", async () => {
  const h = makeHarness();
  const secrets = [h.policySigner.privateKey, h.operator.privateKey].flatMap((k) => [k, k.slice(2)]);
  const seen: string[] = [];

  seen.push(JSON.stringify(await submit(h)));
  // A second milestone: the first is now settled, so a plan for it would be ALREADY_SETTLED.
  const esc = await submit(h, { ...escalatingProposal(), milestone_id: "33333333-3333-4333-8333-333333333333" });
  seen.push(JSON.stringify(esc));
  seen.push(JSON.stringify(h.service.listApprovals("pending")));
  const sig = await signApproval(h.operator, esc.approval_id!, "approve", esc.proposal_hash);
  seen.push(JSON.stringify(await h.service.decideApproval(esc.approval_id!, { decision: "approve", operator_signature: sig })));
  try {
    await h.service.setPolicy({ policy: nextPolicy(2), version: 2, operator_signature: "0x00" });
  } catch (e) {
    seen.push((e as Error).message);
  }
  seen.push(JSON.stringify(h.service.getAudit()));
  seen.push(JSON.stringify(h.service.getPolicy()));

  const text = seen.join("\n");
  for (const s of secrets) assert.ok(!text.includes(s), "secret leaked");
});

// ---- retry rule: only a proposal that already has co-signatures is a duplicate ----

test("retry after a signing failure: the same proposal is signed on the second try, then becomes a duplicate", async () => {
  let failing = true;
  const real = Wallet.createRandom();
  const h = makeHarness({
    signer: {
      async signTypedData(domain, types, value) {
        if (failing) throw new Error("hsm offline");
        return real.signTypedData(domain as never, types as never, value as never);
      },
    },
  });
  await expectError(submit(h), 500); // approved and audited, but nothing was signed
  failing = false;
  const second = await submit(h);
  assert.equal(second.decision, "approved");
  assert.equal(second.cosignatures?.length, 1);
  const third = await submit(h);
  // The milestone now has an approved settlement: the same plan again is a duplicate, the milestone is settled, and
  // its budget is spent.
  assert.deepEqual([third.decision, third.reasons, third.cosignatures], ["rejected", ["ALREADY_SETTLED", "DUPLICATE_PROPOSAL", "OVER_MILESTONE_AMOUNT"], undefined]);
  // all three outcomes are in the audit log
  assert.deepEqual(h.audit.list({ milestone_id: MILESTONE }).map((r) => r.decision), ["approved", "approved", "rejected"]);
});

test("a rejected proposal can be submitted again and is evaluated afresh, not called a duplicate", async () => {
  const h = makeHarness();
  const p = withActions([{ type: "payout", payee_id: "payee-1", amount: "1000000001", asset: "USDT" }]);
  const first = await submit(h, p);
  const second = await submit(h, p);
  assert.deepEqual(second.reasons, first.reasons);
  assert.ok(!second.reasons.includes("DUPLICATE_PROPOSAL"));
});

test("a proposal waiting in the approval queue is a duplicate until a human decides it", async () => {
  const h = makeHarness();
  const first = await submit(h, escalatingProposal());
  assert.equal(first.decision, "escalated");
  const second = await submit(h, escalatingProposal());
  assert.deepEqual([second.decision, second.reasons], ["rejected", ["DUPLICATE_PROPOSAL"]]);
  assert.equal(h.service.listApprovals("pending").length, 1);
});

// ---- on-chain limits: vault-format operator signatures, relayed (INTERFACES 2b) ----

test("an off-chain-only change needs no vault action when the vault already agrees", async () => {
  const h = makeHarness();
  const doc = { ...basePolicy, version: 2, confidence_threshold: 0.8 };
  const r = await h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT });
  assert.deepEqual(r.vault_transactions, []);
  assert.equal(h.chainWriter.calls.length, 0);
});

test("changing an on-chain limit without the signed vault action is refused: policy and guard would disagree", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT }), 409);
  assert.equal(h.service.getPolicy().version, 1);
});

test("a vault action whose values differ from the document is refused", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  const action = await vaultSetPolicy(h, 3, { ...doc, per_tx_cap: "5" });
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT, vault_actions: [action] }), 409);
  assert.equal(h.chainWriter.calls.length, 0);
});

test("a vault action signed by someone other than the vault's operator is refused before anything is relayed", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  const action = await vaultSetPolicy(h, 3, doc, Wallet.createRandom());
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT, vault_actions: [action] }), 403);
  assert.equal(h.chainWriter.calls.length, 0);
});

test("vault versions must continue from the on-chain version, one by one", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  for (const v of [2, 4]) {
    const action = await vaultSetPolicy(h, v, doc);
    await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT, vault_actions: [action] }), 409);
  }
});

test("the vault's on-chain operator must be the operator this Policy Service trusts", async () => {
  const h = makeHarness();
  h.fake.vault.operator = Wallet.createRandom().address;
  const doc = nextPolicy(2);
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT, vault_actions: [await vaultSetPolicy(h, 3, doc)] }), 403);
});

test("a new payee on the allowlist needs a signed setPayees action; with it, both actions are relayed in order", async () => {
  const h = makeHarness();
  h.fake.allowed.delete("0x00000000000000000000000000000000000000a2");
  const doc = { ...nextPolicy(2) };
  const sig = await signPolicy(h.operator, 2, doc);
  const limits = await vaultSetPolicy(h, 3, doc);
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig, vault: VAULT, vault_actions: [limits] }), 409);
  const payees = await vaultSetPayees(h, 4, ["0x00000000000000000000000000000000000000a2"], true);
  const r = await h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig, vault: VAULT, vault_actions: [limits, payees] });
  assert.deepEqual(r.vault_transactions.map((x: { type: string }) => x.type), ["setPolicy", "setPayees"]);
});

test("if the relay fails, the new policy is not activated", async () => {
  const h = makeHarness({ chainWriter: { async relayVaultActions() { throw new Error("rpc https://example.invalid/KEY down"); } } });
  const doc = nextPolicy(2);
  const e = await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: await signPolicy(h.operator, 2, doc), vault: VAULT, vault_actions: [await vaultSetPolicy(h, 3, doc)] }), 502);
  assert.ok(!e.message.includes("KEY"));
  assert.equal(h.service.getPolicy().version, 1);
});

test("malformed vault actions are refused", async () => {
  const h = makeHarness();
  const doc = nextPolicy(2);
  const sig = await signPolicy(h.operator, 2, doc);
  for (const bad of [{}, { type: "drain", version: 3, operator_signature: "0x" + "11".repeat(65) }, { type: "setPolicy", version: 3, perTxCap: "1.5", dailyCap: "1", minReserve: "0", operator_signature: "0x" + "11".repeat(65) }, "x"]) {
    await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig, vault: VAULT, vault_actions: [bad] }), 400);
  }
  await expectError(h.service.setPolicy({ policy: doc, version: 2, operator_signature: sig }), 400); // no vault
});

// ---- approvals of plans that move no money (lead's decision, 13 Nov 2026) ----

test("approvals: a NO_PAYOUTS escalation cannot be approved; it offers new_plan or reject only", async () => {
  const h = makeHarness();
  const esc = await submit(h, { ...goodProposal(), actions: [] });
  assert.equal(esc.decision, "escalated");
  assert.deepEqual(esc.reasons, ["NO_PAYOUTS"]);
  const id = esc.approval_id!;
  const approveSig = await signApproval(h.operator, id, "approve", esc.proposal_hash);
  await expectError(h.service.decideApproval(id, { decision: "approve", operator_signature: approveSig }), 409);
  assert.equal(h.service.listApprovals("pending").length, 1); // still pending: nothing was decided
  const sig = await signApproval(h.operator, id, "new_plan", esc.proposal_hash);
  const r: any = await h.service.decideApproval(id, { decision: "new_plan", operator_signature: sig });
  assert.equal(r.decision, "rejected");
  assert.equal(r.new_plan_requested, true);
  assert.equal(r.cosignatures, undefined);
  assert.equal(h.service.listApprovals("pending").length, 0);
});

test("approvals: any escalated plan with a zero payout total cannot be approved, even for another reason", async () => {
  const h = makeHarness();
  // Escalated for needs_human, but it pays nobody (only a tax reserve).
  const esc = await submit(h, { ...goodProposal(), needs_human: true, actions: [{ type: "tax_reserve", amount: "50000000", reason: "tax" }] });
  assert.equal(esc.decision, "escalated");
  const id = esc.approval_id!;
  const sig = await signApproval(h.operator, id, "approve", esc.proposal_hash);
  await expectError(h.service.decideApproval(id, { decision: "approve", operator_signature: sig }), 409);
  const rejectSig = await signApproval(h.operator, id, "reject", esc.proposal_hash);
  const r: any = await h.service.decideApproval(id, { decision: "reject", operator_signature: rejectSig });
  assert.equal(r.decision, "rejected");
  assert.equal(r.new_plan_requested, undefined);
});

test("approvals: new_plan needs the operator's signature over new_plan itself", async () => {
  const h = makeHarness();
  const esc = await submit(h, { ...goodProposal(), actions: [] });
  const id = esc.approval_id!;
  const wrong = await signApproval(h.operator, id, "reject", esc.proposal_hash); // signed for a different decision
  await expectError(h.service.decideApproval(id, { decision: "new_plan", operator_signature: wrong }), 403);
  await expectError(h.service.decideApproval(id, { decision: "maybe", operator_signature: wrong }), 400);
});
