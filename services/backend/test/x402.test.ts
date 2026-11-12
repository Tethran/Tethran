import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Wallet } from "ethers";
import { openDb } from "../src/db";
import { migrateContracts } from "../src/contracts";
import { createHttpServer } from "../src/http";
import { createX402Client, createX402Server, type X402Chain } from "../src/x402";

const USDT = "0x00000000000000000000000000000000000000c1";
const PAY_TO = new Wallet(Wallet.createRandom().privateKey).address;

function fakeChain() {
  const used = new Set<string>();
  const settled: { from: string; value: string; nonce: string }[] = [];
  const chain: X402Chain = {
    chainId: 31337,
    usdtDomain: () => ({ name: "Tethran Test USDT", version: "1", chainId: 31337, verifyingContract: USDT }),
    authorizationUsed: async (from, nonce) => used.has(`${from.toLowerCase()}:${nonce}`),
    submitTransferWithAuthorization: async (a) => {
      used.add(`${a.from.toLowerCase()}:${a.nonce}`);
      settled.push({ from: a.from, value: a.value, nonce: a.nonce });
      return { txHash: "0x" + String(settled.length).padStart(64, "0") };
    },
    waitConfirmed: async () => {},
  };
  return { chain, settled, used };
}

async function start() {
  const db = openDb(":memory:");
  migrateContracts(db);
  const fc = fakeChain();
  const now = () => new Date();
  const x402 = createX402Server({ db, chain: fc.chain, payTo: PAY_TO, now });
  const server = createHttpServer({ x402 } as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, fc, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const payer = (w: Wallet) => ({ address: async () => w.address, signTypedData: (t: any) => w.signTypedData(t.domain, t.types, t.message) });

test("x402: unpaid request gets 402 with an exact-scheme requirement on the test token", async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/x402/corridor-rules?corridor=US-KE`);
    assert.equal(r.status, 402);
    const body: any = await r.json();
    assert.equal(body.accepts[0].scheme, "exact");
    assert.equal(body.accepts[0].network, "eip155:31337");
    assert.equal(body.accepts[0].asset, USDT);
    assert.equal(body.accepts[0].maxAmountRequired, "20000");
    assert.equal(s.fc.settled.length, 0);
  } finally { await s.close(); }
});

test("x402: client pays, server verifies and settles, data comes back with X-PAYMENT-RESPONSE", async () => {
  const s = await start();
  try {
    const w = new Wallet(Wallet.createRandom().privateKey);
    const c = createX402Client({ baseUrl: s.base, payer: payer(w), capPerRun: 50_000n, now: () => new Date() });
    const rules = await c.get("/x402/corridor-rules?corridor=US-KE");
    assert.equal(rules.data.country, "KE");
    assert.equal(rules.data.simulated_data, true);
    assert.equal(rules.paid, "20000");
    assert.ok(rules.transaction.startsWith("0x"));
    const fx = await c.get("/x402/fx-quote?to=KES");
    assert.equal(fx.data.to, "KES");
    assert.equal(c.spent(), 30_000n);
    assert.deepEqual(s.fc.settled.map((x) => [x.from, x.value]), [[w.address, "20000"], [w.address, "10000"]]);
  } finally { await s.close(); }
});

test("x402: spending cap refuses before anything is signed", async () => {
  const s = await start();
  try {
    let signed = 0;
    const w = new Wallet(Wallet.createRandom().privateKey);
    const c = createX402Client({
      baseUrl: s.base, capPerRun: 25_000n, now: () => new Date(),
      payer: { address: async () => w.address, signTypedData: async (t: any) => { signed++; return w.signTypedData(t.domain, t.types, t.message); } },
    });
    await c.get("/x402/corridor-rules?corridor=US-NG");
    await assert.rejects(c.get("/x402/fx-quote?to=NGN"), (e: any) => e.code === "SPENDING_CAP");
    assert.equal(signed, 1);
    assert.equal(s.fc.settled.length, 1);
  } finally { await s.close(); }
});

test("x402: forged, underpaid, wrong payTo and replayed payments are refused", async () => {
  const s = await start();
  try {
    const first: any = await (await fetch(`${s.base}/x402/fx-quote?to=NGN`)).json();
    const req = first.accepts[0];
    const w = new Wallet(Wallet.createRandom().privateKey);
    const nowS = Math.floor(Date.now() / 1000);
    const domain = { name: req.extra.name, version: req.extra.version, chainId: 31337, verifyingContract: req.asset };
    const types = { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
    const send = async (auth: any, signer: Wallet = w) => {
      const signature = await signer.signTypedData(domain, types, auth);
      const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization: auth } })).toString("base64");
      const r = await fetch(`${s.base}/x402/fx-quote?to=NGN`, { headers: { "x-payment": header } });
      return { status: r.status, body: (await r.json()) as any };
    };
    const good = { from: w.address, to: req.payTo, value: req.maxAmountRequired, validAfter: String(nowS - 60), validBefore: String(nowS + 300), nonce: "0x" + "11".repeat(32) };
    assert.match((await send({ ...good, value: "1" })).body.error, /below the price/);
    assert.match((await send({ ...good, to: new Wallet(Wallet.createRandom().privateKey).address })).body.error, /payTo/);
    assert.match((await send(good, new Wallet(Wallet.createRandom().privateKey))).body.error, /does not match the payer/);
    assert.match((await send({ ...good, validBefore: String(nowS - 1) })).body.error, /validity window/);
    assert.equal((await send(good)).status, 200);
    // Same authorization again: served from the record, not settled twice.
    assert.equal((await send(good)).status, 200);
    assert.equal(s.fc.settled.length, 1);
    // Nonce already used on-chain by a payment this server did not record: refused.
    s.db.exec("DELETE FROM x402_payments");
    assert.match((await send(good)).body.error, /already used/);
  } finally { await s.close(); }
});

test("CORS: the web app origin gets headers and a preflight answer; other origins and /internal do not", async () => {
  const s = await start();
  try {
    const pre = await fetch(`${s.base}/x402`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-payment/);
    const get = await fetch(`${s.base}/x402`, { headers: { origin: "http://localhost:3000" } });
    assert.equal(get.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const other = await fetch(`${s.base}/x402`, { headers: { origin: "http://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const internal = await fetch(`${s.base}/internal/payees`, { headers: { origin: "http://localhost:3000" } });
    assert.equal(internal.headers.get("access-control-allow-origin"), null);
  } finally { await s.close(); }
});
