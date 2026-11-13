// Demo wallet (Tethran wallet): balance, add funds by simulated card, pay from the wallet, insufficient balance,
// duplicate submits, activity. Test doubles only; no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { WdkWallets } from "../../chain/src/index";
import { ApiError } from "../src/errors";
import { createWalletLayer, MAX_TOPUP_CENTS } from "../src/wallets";

const USDT = "0x00000000000000000000000000000000000000e1";
const ESCROW_DEPOSIT = "0x00000000000000000000000000000000000000b2";
const CHAIN = 11155111;
const ADDR: Record<string, string> = {
  client: "0x00000000000000000000000000000000000000c1",
  payee_amara: "0x00000000000000000000000000000000000000a1",
  subcontractor: "0x00000000000000000000000000000000000000d1",
};

/** WDK stand-in with a per-wallet token balance that top-ups raise and sends lower; a faucet that records mints. */
function harness(opts: { faucet?: boolean; failMint?: number } = {}) {
  const balance = new Map<string, bigint>(Object.keys(ADDR).map((r) => [r, 0n]));
  const sent: { role: string; amount: bigint }[] = [];
  const mints: { to: string; amount: string; key: string }[] = [];
  let failMints = opts.failMint ?? 0;
  const account = (role: string) => ({
    getAddress: async () => ADDR[role],
    getBalance: async () => 10n ** 16n,
    getTokenBalance: async () => balance.get(role)!,
    quoteTransfer: async () => ({ fee: 21_000n * 10n ** 9n }),
    transfer: async (o: { amount: bigint }) => {
      balance.set(role, balance.get(role)! - o.amount);
      sent.push({ role, amount: o.amount });
      return { hash: "0x" + String(sent.length).padStart(64, "0"), fee: 1n };
    },
  });
  const wallets = {
    chainId: CHAIN,
    account: async (r: string) => account(r),
    address: async (r: string) => ADDR[r],
    sender: () => { throw new Error("unused"); },
    dispose() {},
  } as unknown as WdkWallets;
  const db = new DatabaseSync(":memory:");
  const layer = createWalletLayer({
    db, wallets, now: () => new Date("2026-11-13T10:00:00Z"),
    chain: { chainId: CHAIN, name: "Sepolia", usdt: USDT, ready: async () => {}, txStatus: async () => "pending" },
    ...(opts.faucet === false ? {} : {
      faucet: {
        mint: async (to: string, amount: string, key: string) => {
          if (failMints > 0) { failMints--; throw new Error("rpc timeout"); }
          mints.push({ to, amount, key });
          const role = Object.keys(ADDR).find((r) => ADDR[r] === to)!;
          balance.set(role, balance.get(role)! + BigInt(amount));
          return { txHash: "0x" + "ab".repeat(32) };
        },
        waitConfirmed: async () => {},
      },
    }),
  });
  return { layer, db, balance, sent, mints };
}

const code = (c: string) => (e: unknown) => e instanceof ApiError && e.code === c;
const pay = (amount: string, ref = "deposit:M1") => ({ to: ESCROW_DEPOSIT, amount, chain_id: CHAIN, payment_reference: ref });

test("balance: a new demo wallet shows 0; adding $250 by simulated card shows 250 tUSDT (1 USD = 1 test USDT)", async () => {
  const h = harness();
  assert.equal((await h.layer.balance("client") as any).usdt.base_units, "0");
  const r: any = await h.layer.fund("client", { amount_usd_cents: 25_000, idempotency_key: "topup-0001" });
  assert.equal(r.amount.base_units, "250000000");
  assert.equal(r.simulated, true);
  assert.match(r.label, /^Wallet: test USDT/);
  assert.equal(r.status, "confirmed");
  assert.deepEqual(h.mints, [{ to: ADDR.client, amount: "250000000", key: "wallet-topup:topup-0001" }]);
  assert.equal((await h.layer.balance("client") as any).usdt.base_units, "250000000");
});

test("fund: the freelancer's wallet can be funded too; other wallets, bad amounts and missing keys are refused", async () => {
  const h = harness();
  await h.layer.fund("payee_amara", { amount_usd_cents: 100, idempotency_key: "topup-amara-1" });
  assert.equal(h.balance.get("payee_amara"), 1_000_000n);
  await assert.rejects(h.layer.fund("subcontractor", { amount_usd_cents: 100, idempotency_key: "topup-sub-01" }), code("NOT_A_USER_WALLET"));
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: 99, idempotency_key: "topup-0002" }), code("BAD_AMOUNT"));
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: 12.5, idempotency_key: "topup-0002" }), code("BAD_AMOUNT"));
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: MAX_TOPUP_CENTS + 1, idempotency_key: "topup-0002" }), code("AMOUNT_TOO_LARGE"));
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: 100 }), code("NO_IDEMPOTENCY_KEY"));
  await assert.rejects(h.layer.fund("nobody", { amount_usd_cents: 100, idempotency_key: "topup-0003" }), (e) => e instanceof ApiError && e.status === 404);
  assert.equal(h.mints.length, 1);
});

test("fund outside demo mode (no faucet) is refused: DEMO_ONLY", async () => {
  const h = harness({ faucet: false });
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: 100, idempotency_key: "topup-0001" }), code("DEMO_ONLY"));
});

test("duplicate submit: the same key mints once, also when both submits arrive at the same time", async () => {
  const h = harness();
  const body = { amount_usd_cents: 5_000, idempotency_key: "topup-dup-01" };
  const results = await Promise.allSettled([h.layer.fund("client", body), h.layer.fund("client", body)]);
  assert.equal(h.mints.length, 1, "one mint for two simultaneous submits");
  assert.ok(results.some((r) => r.status === "fulfilled"));
  for (const r of results) if (r.status === "rejected") assert.ok(code("TOPUP_IN_PROGRESS")(r.reason));
  const again: any = await h.layer.fund("client", body);
  assert.equal(again.repeated, true);
  assert.equal(h.mints.length, 1, "a later repeat returns the first top-up");
  assert.equal(h.balance.get("client"), 50_000_000n);
  // The same key for a different amount or wallet is a mistake, not a repeat.
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: 6_000, idempotency_key: "topup-dup-01" }), code("IDEMPOTENCY_MISMATCH"));
  await assert.rejects(h.layer.fund("payee_amara", body), code("IDEMPOTENCY_MISMATCH"));
});

test("a failed mint records nothing; retrying with the same key succeeds", async () => {
  const h = harness({ failMint: 1 });
  await assert.rejects(h.layer.fund("client", { amount_usd_cents: 1_000, idempotency_key: "topup-retry-1" }), code("TOPUP_FAILED"));
  assert.equal((await h.layer.activity("client") as any).items.length, 0);
  await h.layer.fund("client", { amount_usd_cents: 1_000, idempotency_key: "topup-retry-1" });
  assert.equal(h.balance.get("client"), 10_000_000n);
});

test("insufficient balance: review blocks before signing and send refuses; nothing is sent", async () => {
  const h = harness();
  await h.layer.fund("client", { amount_usd_cents: 4_000, idempotency_key: "topup-0010" }); // 40 tUSDT
  const r: any = await h.layer.review("client", pay("400000000"));
  assert.equal(r.can_sign, false);
  assert.deepEqual(r.blocked.map((b: any) => b.code), ["INSUFFICIENT_BALANCE"]);
  assert.match(r.blocked[0].detail, /holds 40 tUSDT; this needs 400/);
  assert.equal(r.fee, null, "no fee estimate for a transfer that cannot be paid");
  await assert.rejects(h.layer.send("client", pay("400000000")), code("INSUFFICIENT_BALANCE"));
  assert.equal(h.sent.length, 0);
});

test("pay from the wallet: after adding funds the milestone payment is reviewed, sent once, and shows in the activity", async () => {
  const h = harness();
  await h.layer.fund("client", { amount_usd_cents: 50_000, idempotency_key: "topup-0020" }); // 500 tUSDT
  assert.equal((await h.layer.review("client", pay("400000000")) as any).can_sign, true);
  const sent: any = await h.layer.send("client", pay("400000000"));
  assert.equal(sent.status, "pending");
  assert.equal(h.balance.get("client"), 100_000_000n);
  // The same payment again is refused (duplicate submit), and nothing more leaves the wallet.
  await assert.rejects(h.layer.send("client", pay("400000000")), code("DUPLICATE_PENDING"));
  assert.equal(h.sent.length, 1);
  const a: any = await h.layer.activity("client");
  assert.deepEqual(a.items.map((i: any) => [i.kind, i.direction, i.display]).sort(), [["send", "out", "400 tUSDT"], ["top_up", "in", "500 tUSDT"]]);
  assert.equal(a.items.find((i: any) => i.kind === "send").detail, "Milestone payment into escrow");
});

test("activity: vault payouts to the wallet's address show as money in; other payees' payouts do not", async () => {
  const h = harness();
  h.db.exec(`CREATE TABLE payouts (amount TEXT, tx TEXT, status TEXT, at TEXT, to_address TEXT)`);
  h.db.prepare("INSERT INTO payouts VALUES (?, ?, ?, ?, ?)").run("360000000", "0x" + "11".repeat(32), "confirmed", "2026-11-13T09:00:00Z", ADDR.payee_amara);
  h.db.prepare("INSERT INTO payouts VALUES (?, ?, ?, ?, ?)").run("90000000", "0x" + "22".repeat(32), "confirmed", "2026-11-13T09:01:00Z", ADDR.subcontractor);
  h.db.prepare("INSERT INTO payouts VALUES (?, ?, ?, ?, ?)").run("10000000", null, "pending", "2026-11-13T09:02:00Z", ADDR.payee_amara);
  const a: any = await h.layer.activity("payee_amara");
  assert.deepEqual(a.items.map((i: any) => [i.kind, i.direction, i.display, i.detail]), [["payout", "in", "360 tUSDT", "Milestone payout from the vault"]]);
  // The freelancer can use that balance as a client: pay a milestone from the same wallet.
  h.balance.set("payee_amara", 360_000_000n);
  assert.equal((await h.layer.review("payee_amara", pay("200000000", "deposit:M9")) as any).can_sign, true);
});
