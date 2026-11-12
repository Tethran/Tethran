import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { ApiError } from "../src/errors";
import { createOperator, OPERATOR_TYPES } from "../src/operator";
import { CHAIN_ID, CLIENT, M1, TREASURY, harness } from "./helpers";

const fundApproved = async (h: ReturnType<typeof harness>, identity?: [string, string]) => {
  await h.treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000 });
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  if (identity) h.db.prepare("INSERT OR REPLACE INTO identity_records VALUES (?, ?, ?, 'SIM')").run(M1, identity[0], identity[1]);
  h.chain.approve(M1);
};

function setup(operatorKey = Wallet.createRandom()) {
  const h = harness();
  h.db.prepare("UPDATE vaults SET operator = ?").run(operatorKey.address);
  const vs = h.chain.vaultState.bind(h.chain);
  h.chain.vaultState = async (v: string) => ({ ...(await vs(v)), operator: operatorKey.address });
  const policy = { listApprovals: async () => [{ id: "ap-1" }] } as never;
  const op = createOperator({ db: h.db, chain: h.chain, treasury: h.treasury, policy, now: h.now });
  const sign = (decision: string, by = operatorKey) =>
    by.signTypedData({ name: "TethranOperator", version: "1", chainId: CHAIN_ID }, OPERATOR_TYPES, { milestoneId: M1, decision });
  return { h, op, sign };
}
const status = (s: number) => (e: unknown) => e instanceof ApiError && e.status === s;

test("identity hold: the release is held, shown in the operator queue, and released by the vault operator's signature", async () => {
  const { h, op, sign } = setup();
  await fundApproved(h, ["Ada Okafor", "Someone Else"]);
  await assert.rejects(h.treasury.release(M1), (e: unknown) => e instanceof ApiError && e.code === "IDENTITY_MISMATCH");
  const q: any = await op.queue();
  assert.equal(q.identity_holds.length, 1);
  assert.deepEqual(q.policy_approvals, [{ id: "ap-1" }]);
  await assert.rejects(op.decideIdentity(M1, { decision: "release", operator_signature: await sign("release", Wallet.createRandom()) }), status(403));
  await assert.rejects(op.decideIdentity(M1, { decision: "release", operator_signature: await sign("hold") }), status(403)); // signed another decision
  const r: any = await op.decideIdentity(M1, { decision: "release", operator_signature: await sign("release") });
  assert.equal(r.released, true);
  assert.equal(h.escrow.get(M1)?.state, "Released");
  await assert.rejects(op.decideIdentity(M1, { decision: "release", operator_signature: await sign("release") }), status(409));
});

test("identity hold kept by the operator: nothing is released", async () => {
  const { h, op, sign } = setup();
  await fundApproved(h);
  await assert.rejects(h.treasury.release(M1));
  const r: any = await op.decideIdentity(M1, { decision: "hold", operator_signature: await sign("hold") });
  assert.equal(r.released, false);
  assert.equal(h.escrow.get(M1)?.state, "Approved");
  await assert.rejects(h.treasury.release(M1), (e: unknown) => e instanceof ApiError && e.code === "IDENTITY_MISMATCH");
});

test("arbiter: two parties signing the same outcome decide the dispute on-chain; one is not enough", async () => {
  const { h, op } = setup();
  await h.treasury.createMilestone({ id: M1, provider_id: "prov-1", title: "Brand pack", client_address: CLIENT, amount_usd_cents: 10_000 });
  const tx = "0x" + "dd".repeat(32);
  h.deposits.set(tx, [{ from: CLIENT, to: TREASURY, value: "100000000" }]);
  h.add(TREASURY, 100_000_000n);
  await h.treasury.confirmDeposit(M1, tx);
  // the fake escrow uses fixed party addresses; give it signers we hold keys for
  const client = Wallet.createRandom(), arbiter = Wallet.createRandom(), stranger = Wallet.createRandom();
  const m = h.escrow.get(M1)!;
  m.client = client.address; m.arbiter = arbiter.address; m.state = "Disputed";
  const sign = async (w: Wallet, kind: "client" | "arbiter", release: boolean) => {
    const td: any = op.attestationTypedData(M1, kind, release);
    return { signer: w.address, signature: await w.signTypedData(td.domain, td.types, td.message), release_to_provider: release };
  };
  assert.equal((await op.disputes()).length, 1);
  await assert.rejects(op.attest(M1, { ...(await sign(stranger as never, "client", false)) }), status(403)); // not a party
  const wrongKind = await sign(client as never, "arbiter", false); // client signing as the arbiter
  await assert.rejects(op.attest(M1, { ...wrongKind, signer: client.address }), status(403));
  const first: any = await op.attest(M1, await sign(client as never, "client", false));
  assert.equal(first.decided, false);
  const second: any = await op.attest(M1, await sign(arbiter as never, "arbiter", false));
  assert.deepEqual([second.decided, second.outcome, second.state], [true, "refund to funder", "refunded"]);
  assert.equal(h.sent.filter((s) => s === "decide").length, 1);
});

test("attestations are refused for a milestone that is not disputed", async () => {
  const { h, op } = setup();
  await fundApproved(h, ["A", "A"]);
  await assert.rejects(op.attest(M1, { signer: CLIENT, signature: "0x", release_to_provider: true }), status(409));
});

test("escalated approvals: typed data from the Policy Service's definitions; the signed decision is relayed, not decided here", async () => {
  const h = harness();
  const relayed: unknown[] = [];
  const policy = {
    listApprovals: async () => [{ id: "ap-1", proposal_hash: "ab".repeat(32) }],
    decideApproval: async (id: string, decision: string, sig: string) => { relayed.push([id, decision, sig]); return { decision: "approved", reasons: [] }; },
  } as never;
  const op = createOperator({ db: h.db, chain: h.chain, treasury: h.treasury, policy, now: h.now });
  const td: any = await op.approvalTypedData("ap-1", "approve");
  assert.equal(td.domain.name, "TethranPolicy");
  assert.deepEqual(td.message, { approvalId: "ap-1", decision: "approve", proposalHash: "0x" + "ab".repeat(32) });
  const operator = Wallet.createRandom();
  const sig = await operator.signTypedData(td.domain, td.types, td.message);
  await op.decideApproval("ap-1", { decision: "approve", operator_signature: sig });
  assert.deepEqual(relayed, [["ap-1", "approve", sig]]);
  await assert.rejects(op.approvalTypedData("ap-9", "approve"), (e: unknown) => e instanceof ApiError && e.status === 404);
  await assert.rejects(op.approvalTypedData("ap-1", "maybe"), (e: unknown) => e instanceof ApiError && e.status === 400);
  await assert.rejects(op.decideApproval("ap-1", { decision: "approve" }), (e: unknown) => e instanceof ApiError && e.status === 403);
});
