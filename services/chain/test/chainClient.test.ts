import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeError } from "ethers";
import {
  EvmChainClient,
  IdempotencyInFlightError,
  InMemoryIdempotencyStore,
  NotBuiltYetError,
  SqliteIdempotencyStore,
  loadChain,
  milestoneIdToBytes32,
} from "../src";
import type { ChainConfig, IdempotencyStore } from "../src";

const CONFIG: ChainConfig = {
  key: "test", name: "Test", chainId: 31337, rpcUrl: "http://127.0.0.1:1", testnet: true,
  usdt: "0x0000000000000000000000000000000000000001",
  escrow: "0x0000000000000000000000000000000000000002",
  receiptNft: "",
};

function fakeSender(fail?: () => Error) {
  const sent: { to: string; data: string }[] = [];
  return {
    sent,
    getAddress: async () => "0x00000000000000000000000000000000000000aa",
    sendTransaction: async (tx: { to: string; data: string }) => {
      if (fail) throw fail();
      sent.push(tx);
      return { hash: `0x${String(sent.length).padStart(64, "0")}` };
    },
  };
}

for (const [name, makeStore] of [
  ["in-memory", () => new InMemoryIdempotencyStore()],
  ["sqlite", () => new SqliteIdempotencyStore(":memory:")],
] as [string, () => IdempotencyStore][]) {
  test(`${name} store: reserve once, complete, release only when unsent`, () => {
    const store = makeStore();
    assert.equal(store.get("k"), undefined);
    assert.equal(store.reserve("k", 1), true);
    assert.equal(store.reserve("k", 1), false);
    assert.deepEqual({ ...store.get("k") }, { key: "k", chainId: 1, txHash: null });
    store.release("k");
    assert.equal(store.get("k"), undefined);
    store.reserve("k", 1);
    store.complete("k", "0xabc");
    assert.equal(store.get("k")?.txHash, "0xabc");
    assert.throws(() => store.complete("missing", "0x1"));
  });
}

test("a repeated idempotency key returns the first TxRef and sends nothing", async () => {
  const sender = fakeSender();
  const client = new EvmChainClient(CONFIG, sender, new InMemoryIdempotencyStore());
  const first = await client.approve("m-1", "key-1");
  const second = await client.approve("m-1", "key-1");
  assert.deepEqual(second, first);
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].to, CONFIG.escrow);
  assert.ok(sender.sent[0].data.endsWith(milestoneIdToBytes32("m-1").slice(2)));
  await client.release("m-1", "key-2");
  assert.equal(sender.sent.length, 2);
});

test("an empty idempotency key is refused", async () => {
  const client = new EvmChainClient(CONFIG, fakeSender(), new InMemoryIdempotencyStore());
  await assert.rejects(client.approve("m-1", ""), /idempotencyKey is required/);
});

test("a revert before broadcast frees the key; an unknown failure keeps it claimed", async () => {
  const store = new InMemoryIdempotencyStore();
  const reverting = new EvmChainClient(CONFIG, fakeSender(() => makeError("reverted", "CALL_EXCEPTION")), store);
  await assert.rejects(reverting.approve("m-1", "key-r"));
  assert.equal(store.get("key-r"), undefined);

  const flaky = new EvmChainClient(CONFIG, fakeSender(() => makeError("timeout", "TIMEOUT")), store);
  await assert.rejects(flaky.approve("m-1", "key-t"));
  assert.equal(store.get("key-t")?.txHash, null);
  const healthy = new EvmChainClient(CONFIG, fakeSender(), store);
  await assert.rejects(healthy.approve("m-1", "key-t"), IdempotencyInFlightError);
});

test("a key used on another chain is refused", async () => {
  const store = new InMemoryIdempotencyStore();
  store.reserve("key-x", 84532);
  store.complete("key-x", "0xabc");
  const client = new EvmChainClient(CONFIG, fakeSender(), store);
  await assert.rejects(client.approve("m-1", "key-x"), /was used on chain 84532/);
});

test("decide encodes the attestations; attestationTypedData matches INTERFACES.md", async () => {
  const sender = fakeSender();
  const client = new EvmChainClient(CONFIG, sender, new InMemoryIdempotencyStore());
  await client.decide("m-1", true, ["0x12", "0x34"], [CONFIG.usdt, CONFIG.escrow], "key-d");
  assert.equal(sender.sent.length, 1);
  assert.ok(sender.sent[0].data.includes(milestoneIdToBytes32("m-1").slice(2)));
  const td = client.attestationTypedData("m-1", 2, false);
  assert.deepEqual(td.domain, { name: "TethranEscrow", version: "1", chainId: 31337, verifyingContract: CONFIG.escrow });
  assert.deepEqual(td.types.Attestation.map((f) => f.name), ["milestoneId", "kind", "releaseToProvider"]);
  assert.deepEqual(td.message, { milestoneId: milestoneIdToBytes32("m-1"), kind: 2, releaseToProvider: false });
});

test("calls whose contracts are not built yet fail loudly", async () => {
  const client = new EvmChainClient(CONFIG, fakeSender(), new InMemoryIdempotencyStore());
  await assert.rejects(
    client.vaultExecute({ vault: "", to: "", amount: "1", agentSig: "", policySig: "" }, "k"), NotBuiltYetError);
});

test("loadChain refuses a chain that is not marked as a test network", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tethran-")), "chains.json");
  writeFileSync(path, JSON.stringify({
    defaultChain: "main",
    chains: {
      main: { name: "Mainnet", chainId: 1, rpcUrl: "http://x", usdt: "", escrow: "", receiptNft: "" },
      test: { name: "T", chainId: 5, rpcUrl: "http://x", testnet: true, usdt: "", escrow: "", receiptNft: "" },
    },
  }));
  assert.throws(() => loadChain("main", path), /not marked as a test network/);
  assert.throws(() => loadChain("nope", path), /no chain/);
  assert.equal(loadChain("test", path).chainId, 5);
});
