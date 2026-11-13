import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PolicyViolationError, type WdkWallets } from "../../chain/src/index";
import { ApiError } from "../src/errors";
import { createWalletLayer } from "../src/wallets";

const USDT = "0x00000000000000000000000000000000000000e1";
const TO = "0x00000000000000000000000000000000000000b2";
const CHAIN = 11155111;

/** A WDK stand-in: records transfers, can refuse like a WDK policy, reports statuses per hash. */
function fake(opts: { policyDeny?: boolean; failSend?: boolean } = {}) {
  const sent: { recipient: string; amount: bigint }[] = [];
  const status = new Map<string, "pending" | "confirmed" | "failed" | "unknown">();
  const account = {
    getAddress: async () => "0x00000000000000000000000000000000000000c1",
    getBalance: async () => 3n * 10n ** 15n,
    getTokenBalance: async () => 125_500_000n,
    quoteTransfer: async () => ({ fee: 21_000n * 10n ** 9n }),
    transfer: async (o: { recipient: string; amount: bigint }) => {
      if (opts.policyDeny) throw Object.assign(Object.create(PolicyViolationError.prototype), { message: "denied" });
      if (opts.failSend) throw new Error("socket hang up");
      sent.push(o);
      const hash = "0x" + String(sent.length).padStart(64, "0");
      status.set(hash, "pending");
      return { hash, fee: 21_000n * 10n ** 9n };
    },
  };
  const wallets = {
    chainId: CHAIN,
    account: async () => account,
    address: async () => account.getAddress(),
    sender: () => { throw new Error("unused"); },
    dispose() {},
  } as unknown as WdkWallets;
  let ready = true;
  const layer = createWalletLayer({
    db: new DatabaseSync(":memory:"), wallets, now: () => new Date("2026-11-12T10:00:00Z"),
    chain: {
      chainId: CHAIN, name: "Sepolia", usdt: USDT,
      ready: async () => { if (!ready) throw new Error("RPC reports chain id 1"); },
      txStatus: async (h) => status.get(h) ?? "unknown",
    },
  });
  return { layer, sent, status, setReady: (v: boolean) => { ready = v; } };
}

const body = (over: Record<string, unknown> = {}) => ({ to: TO, amount: "5000000", chain_id: CHAIN, payment_reference: "dep-M1", ...over });
const code = (c: string) => (e: unknown) => e instanceof ApiError && e.code === c;

test("review shows recipient, network, amount and the network fee separately, before anything is signed", async () => {
  const f = fake();
  f.layer.saveRecipient("client", { name: "Tethran treasury", address: TO });
  const r: any = await f.layer.review("client", body());
  assert.equal(r.can_sign, true);
  assert.deepEqual(r.recipient, { address: TO, saved_name: "Tethran treasury", saved: true });
  assert.deepEqual(r.network, { name: "Sepolia", chain_id: CHAIN });
  assert.equal(r.amount.display, "5 tUSDT (test token)");
  assert.equal(r.fee.paid_in, "ETH");
  assert.match(r.fee.display, /ETH \(test\), estimated/);
  assert.equal(f.sent.length, 0);
  assert.match(r.custody, /demo custody/);
});

test("wrong network is detected before signing: by the app's chain id and by the RPC's real chain id", async () => {
  const f = fake();
  const r: any = await f.layer.review("client", body({ chain_id: 84532 }));
  assert.equal(r.can_sign, false);
  assert.equal(r.blocked[0].code, "WRONG_NETWORK");
  await assert.rejects(f.layer.send("client", body({ chain_id: 84532 })), code("WRONG_NETWORK"));
  f.setReady(false);
  await assert.rejects(f.layer.send("client", body()), code("WRONG_NETWORK"));
  assert.equal(f.sent.length, 0);
});

test("a second send with the same payment reference is blocked while the first is pending, and after it is done", async () => {
  const f = fake();
  const first: any = await f.layer.send("client", body());
  assert.equal(first.status, "pending");
  await assert.rejects(f.layer.send("client", body()), code("DUPLICATE_PENDING"));
  assert.equal((await f.layer.review("client", body()) as any).blocked[0].code, "DUPLICATE_PENDING");
  f.status.set(first.tx_hash, "confirmed");
  await f.layer.status("dep-M1");
  await assert.rejects(f.layer.send("client", body()), code("ALREADY_SENT"));
  assert.equal(f.sent.length, 1);
  await f.layer.send("client", body({ payment_reference: "dep-M2" })); // a different reference is a different payment
  assert.equal(f.sent.length, 2);
});

test("two sends at the same moment with one reference: exactly one is signed", async () => {
  const f = fake();
  const results = await Promise.allSettled([f.layer.send("client", body()), f.layer.send("client", body())]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.sent.length, 1);
});

test("reconnect: status rechecks the same tx hash and never sends again", async () => {
  const f = fake();
  const first: any = await f.layer.send("client", body());
  const s1: any = await f.layer.status("dep-M1");
  assert.deepEqual([s1.status, s1.tx_hash, s1.rechecked], ["pending", first.tx_hash, true]);
  f.status.set(first.tx_hash, "confirmed");
  const s2: any = await f.layer.status("dep-M1");
  assert.deepEqual([s2.status, s2.last_known], ["confirmed", "pending"]);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.layer.status("nope"), (e: unknown) => e instanceof ApiError && e.status === 404);
});

test("a transfer that failed on-chain frees its reference; an unknown outcome keeps it blocked", async () => {
  const f = fake();
  const first: any = await f.layer.send("client", body());
  f.status.set(first.tx_hash, "failed");
  await f.layer.status("dep-M1");
  await f.layer.send("client", body());
  assert.equal(f.sent.length, 2);

  const g = fake({ failSend: true });
  await assert.rejects(g.layer.send("client", body()), code("SEND_UNKNOWN"));
  await assert.rejects(g.layer.send("client", body()), code("DUPLICATE_PENDING"));
});

test("a transfer refused by the WDK wallet policy sends nothing and frees the reference", async () => {
  const f = fake({ policyDeny: true });
  await assert.rejects(f.layer.send("client", body()), code("WALLET_POLICY"));
  await assert.rejects(f.layer.send("client", body()), code("WALLET_POLICY")); // not DUPLICATE_PENDING
});

test("bad input and unknown wallets are refused", async () => {
  const f = fake();
  await assert.rejects(f.layer.send("client", body({ to: "0x12" })), code("BAD_ADDRESS"));
  await assert.rejects(f.layer.send("client", body({ amount: "1.5" })), code("BAD_AMOUNT"));
  await assert.rejects(f.layer.send("client", body({ payment_reference: "" })), code("NO_REFERENCE"));
  await assert.rejects(f.layer.balance("treasury"), (e: unknown) => e instanceof ApiError && e.status === 404);
  const b: any = await f.layer.balance("client");
  assert.equal(b.usdt.display, "125.5 tUSDT (test token)");
});
