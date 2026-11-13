// Connected wallets: the deposit and approve calls they send, and Get test USDT (DEMO_MODE only, limited per IP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { approveCall, createExternalMint, createIpLimiter, depositCall, EXTERNAL_MINT_BASE_UNITS } from "../src/externalWallet";
import { milestoneIdToBytes32 } from "../../chain/src/index";
import { ApiError } from "../src/errors";

const TOKEN = "0x00000000000000000000000000000000000000e1";
const TREASURY = "0x00000000000000000000000000000000000000a5";
const CLIENT = "0x00000000000000000000000000000000000000c1";
const ESCROW = "0x00000000000000000000000000000000000000e5";
const M1 = "11111111-1111-4111-8111-111111111111";

test("deposit call: a test-USDT transfer of the exact amount to the treasury, named for the review screen", () => {
  const c = depositCall({ chain_id: 11155111, token: TOKEN, deposit_address: TREASURY, amount: "400000000", from: CLIENT });
  assert.equal(c.to.toLowerCase(), TOKEN);
  const [to, amount] = new Interface(["function transfer(address,uint256)"]).decodeFunctionData("transfer", c.data);
  assert.deepEqual([String(to).toLowerCase(), amount], [TREASURY, 400_000_000n]);
  assert.equal(c.recipient.name, "Tethran treasury (escrow deposit)");
  assert.equal(c.from.toLowerCase(), CLIENT, "only the milestone's client may pay it");
});

test("approve call: the escrow's approve for this milestone id", () => {
  const c = approveCall(11155111, ESCROW, M1);
  const [id] = new Interface(["function approve(bytes32)"]).decodeFunctionData("approve", c.data);
  assert.equal(id, milestoneIdToBytes32(M1));
  assert.equal(c.to.toLowerCase(), ESCROW);
});

test("wallet top-ups are limited per IP (5 per 10 minutes)", async () => {

  const t = { now: new Date("2026-11-13T10:00:00Z") };
  const limit = createIpLimiter({ max: 5, windowMs: 600_000, now: () => t.now, what: "wallet top-ups" });
  const a = { headers: {}, socket: { remoteAddress: "10.0.0.2" } } as never;
  const b = { headers: {}, socket: { remoteAddress: "10.0.0.3" } } as never;
  for (let i = 0; i < 5; i++) limit(a);
  assert.throws(() => limit(a), (e: unknown) => e instanceof ApiError && e.status === 429);
  limit(b); // another address is not affected
  t.now = new Date(t.now.getTime() + 600_001);
  limit(a);
});

test("Get test USDT: DEMO_MODE only, a valid address, 100 per request, at most 3 per 10 minutes per IP", async () => {
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } } as never;
  const off = createExternalMint({ now: () => new Date() });
  await assert.rejects(off(req, { address: CLIENT }), (e: unknown) => e instanceof ApiError && e.code === "DEMO_ONLY");
  const minted: string[] = [];
  const t = { now: new Date("2026-11-13T10:00:00Z") };
  const on = createExternalMint({ now: () => t.now, mint: async (to, amount) => { minted.push(`${to}:${amount}`); return { txHash: "0x1" }; } });
  await assert.rejects(on(req, { address: "not-an-address" }), (e: unknown) => e instanceof ApiError && e.code === "BAD_ADDRESS");
  for (let i = 0; i < 3; i++) assert.equal((await on(req, { address: CLIENT })).amount, EXTERNAL_MINT_BASE_UNITS.toString());
  await assert.rejects(on(req, { address: CLIENT }), (e: unknown) => e instanceof ApiError && e.status === 429);
  t.now = new Date(t.now.getTime() + 10 * 60 * 1000 + 1);
  await on(req, { address: CLIENT });
  assert.equal(minted.length, 4);
});
