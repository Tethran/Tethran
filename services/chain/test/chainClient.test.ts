import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, makeError } from "ethers";
import {
  CannotResolveError,
  EvmChainClient,
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  InMemoryIdempotencyStore,
  MilestoneMismatchError,
  NotBuiltYetError,
  VAULT_TYPES,
  vaultActionId,
  SqliteIdempotencyStore,
  assertMilestoneMatches,
  loadChain,
  milestoneIdToBytes32,
  safeErrorMessage,
} from "../src";
import type { ChainConfig, ChainReader, IdempotencyStore, MilestoneView } from "../src";

const CONFIG: ChainConfig = {
  key: "test", name: "Test", chainId: 31337, rpcUrl: "http://127.0.0.1:1", testnet: true, confirmations: 1,
  usdt: "0x0000000000000000000000000000000000000001",
  escrow: "0x0000000000000000000000000000000000000002",
  receiptNft: "",
};
const ALICE = "0x00000000000000000000000000000000000000aa";
const BOB = "0x00000000000000000000000000000000000000bb";

/** A stand-in for the RPC node. Tests change its fields to describe what the chain looks like. */
function fakeNode() {
  const node = {
    chainId: 31337,
    mined: 0,   // sender's mined transaction count
    pending: 0, // sender's count including the mempool
    receipts: new Map<string, { status: number; blockNumber: number }>(),
    mempool: new Map<string, { from: string; to: string; data: string }>(),
  };
  const reader = {
    send: async (method: string) => {
      if (method === "eth_chainId") return "0x" + node.chainId.toString(16);
      throw new Error("unexpected rpc call " + method);
    },
    call: async () => { throw new Error("no contract reads in unit tests"); },
    getTransactionCount: async (_a: string, tag?: string) => (tag === "pending" ? node.pending : node.mined),
    getTransactionReceipt: async (h: string) => node.receipts.get(h) ?? null,
    getTransaction: async (h: string) => node.mempool.get(h) ?? null,
    getBlockNumber: async () => 100,
  } as unknown as ChainReader;
  return { node, reader };
}

function fakeSender(address = ALICE, fail?: () => Error) {
  const sent: { to: string; data: string }[] = [];
  return {
    sent,
    getAddress: async () => address,
    sendTransaction: async (tx: { to: string; data: string }) => {
      if (fail) throw fail();
      sent.push(tx);
      return { hash: `0x${address.slice(-2)}${String(sent.length).padStart(62, "0")}` };
    },
  };
}

function setup(opts: { store?: IdempotencyStore; address?: string; fail?: () => Error; minAge?: number } = {}) {
  const { node, reader } = fakeNode();
  const store = opts.store ?? new InMemoryIdempotencyStore();
  const sender = fakeSender(opts.address, opts.fail);
  const client = new EvmChainClient(CONFIG, sender, store, { provider: reader, resolveMinAgeMs: opts.minAge ?? 0 });
  return { node, reader, store, sender, client };
}

// ---- stores ----

for (const [name, makeStore] of [
  ["in-memory", () => new InMemoryIdempotencyStore()],
  ["sqlite", () => new SqliteIdempotencyStore(":memory:")],
] as [string, () => IdempotencyStore][]) {
  test(`${name} store: reserve once, complete, release only when unsent, forget`, () => {
    const store = makeStore();
    const rec = { key: "k", chainId: 1, callHash: "0xc", nonceAtReserve: 7, reservedAt: 1000 };
    assert.equal(store.get("k"), undefined);
    assert.equal(store.reserve(rec), true);
    assert.equal(store.reserve({ ...rec, callHash: "0xother" }), false);
    assert.deepEqual({ ...store.get("k") }, { ...rec, txHash: null });
    store.release("k");
    assert.equal(store.get("k"), undefined);

    store.reserve(rec);
    store.complete("k", "0xabc");
    assert.equal(store.get("k")?.txHash, "0xabc");
    store.release("k"); // no effect once a hash is recorded
    assert.equal(store.get("k")?.txHash, "0xabc");
    store.forget("k");
    assert.equal(store.get("k"), undefined);
    assert.throws(() => store.complete("missing", "0x1"));
  });
}

test("sqlite store keeps its records across a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tethran-idem-")), "idem.sqlite");
  const first = new SqliteIdempotencyStore(path);
  first.reserve({ key: "k", chainId: 5, callHash: "0xc", nonceAtReserve: 3, reservedAt: 42 });
  first.complete("k", "0xabc");
  first.close();
  const second = new SqliteIdempotencyStore(path);
  assert.deepEqual({ ...second.get("k") }, {
    key: "k", chainId: 5, callHash: "0xc", nonceAtReserve: 3, reservedAt: 42, txHash: "0xabc",
  });
  assert.equal(second.reserve({ key: "k", chainId: 5, callHash: "0xc", nonceAtReserve: 3, reservedAt: 43 }), false);
  second.close();
});

// ---- one transaction per key ----

test("a repeated key with the same call returns the first TxRef and sends nothing", async () => {
  const { sender, client } = setup();
  const first = await client.approve("m-1", "key-1");
  const second = await client.approve("m-1", "key-1");
  assert.deepEqual(second, first);
  assert.equal(first.idempotencyKey, "key-1");
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].to, CONFIG.escrow);
  assert.ok(sender.sent[0].data.endsWith(milestoneIdToBytes32("m-1").slice(2)));
  await client.release("m-1", "key-2");
  assert.equal(sender.sent.length, 2);
});

test("a key reused for a different call throws and sends nothing", async () => {
  const { sender, client } = setup();
  await client.approve("m-1", "key-1");
  await assert.rejects(client.approve("m-2", "key-1"), IdempotencyKeyReuseError); // other milestone
  await assert.rejects(client.release("m-1", "key-1"), IdempotencyKeyReuseError); // other function
  assert.equal(sender.sent.length, 1);
});

test("two calls with the same key at the same moment send one transaction", async () => {
  const { sender, client } = setup();
  const [a, b] = await Promise.all([client.approve("m-1", "key-1"), client.approve("m-1", "key-1")]);
  assert.deepEqual(a, b);
  assert.equal(sender.sent.length, 1);
});

test("an empty idempotency key is refused", async () => {
  const { client } = setup();
  await assert.rejects(client.approve("m-1", ""), /idempotencyKey is required/);
});

test("keys are scoped to the sender: two signers can share a store and a key", async () => {
  const store = new InMemoryIdempotencyStore();
  const alice = setup({ store, address: ALICE });
  const bob = setup({ store, address: BOB });
  const a = await alice.client.approve("m-1", "same-key");
  const b = await bob.client.approve("m-1", "same-key");
  assert.notEqual(a.txHash, b.txHash);
  assert.equal(alice.sender.sent.length, 1);
  assert.equal(bob.sender.sent.length, 1);
});

test("a key already used on another chain is refused", async () => {
  const { store, client } = setup();
  store.reserve({ key: `${ALICE}:key-x`, chainId: 84532, callHash: "0xc", nonceAtReserve: 0, reservedAt: 0 });
  store.complete(`${ALICE}:key-x`, "0xabc");
  await assert.rejects(client.approve("m-1", "key-x"), /was used on chain 84532/);
});

test("a send the node refused up front frees the key", async () => {
  for (const code of ["CALL_EXCEPTION", "INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"] as const) {
    const { store, client } = setup({ fail: () => makeError("refused", code) });
    await assert.rejects(client.approve("m-1", "key-r"));
    assert.equal(store.get(`${ALICE}:key-r`), undefined, code);
  }
});

test("a reverted gas estimate is asked again a limited number of times, then frees the key", async () => {
  let calls = 0;
  const { node, reader } = fakeNode();
  void node;
  const sent: string[] = [];
  const sender = {
    getAddress: async () => ALICE,
    sendTransaction: async () => {
      calls++;
      if (calls <= 2) throw makeError("stale node", "CALL_EXCEPTION");
      sent.push("0xok");
      return { hash: "0xok" };
    },
  };
  const store = new InMemoryIdempotencyStore();
  const opts = { provider: reader, estimateRetries: 2, estimateRetryMs: 1 };
  const ref = await new EvmChainClient(CONFIG, sender, store, opts).approve("m-1", "k");
  assert.equal(ref.txHash, "0xok");
  assert.equal(calls, 3);

  calls = -10; // now it keeps reverting: three tries, then the key is freed
  const failing = new EvmChainClient(CONFIG, sender, store, opts);
  await assert.rejects(failing.approve("m-2", "k2"));
  assert.equal(calls, -7);
  assert.equal(store.get(`${ALICE}:k2`), undefined);
});

test("any other failure keeps the key claimed: it is never sent again by a retry", async () => {
  for (const code of ["TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR", "UNKNOWN_ERROR"] as const) {
    const store = new InMemoryIdempotencyStore();
    const flaky = setup({ store, fail: () => makeError("maybe sent", code) });
    await assert.rejects(flaky.client.approve("m-1", "key-t"));
    assert.equal(store.get(`${ALICE}:key-t`)?.txHash, null, code);
    const healthy = setup({ store });
    await assert.rejects(healthy.client.approve("m-1", "key-t"), IdempotencyInFlightError);
    assert.equal(healthy.sender.sent.length, 0);
  }
});

test("if the hash cannot be recorded after sending, the key stays claimed and the hash is printed", async () => {
  const inner = new InMemoryIdempotencyStore();
  const broken: IdempotencyStore = {
    get: (k) => inner.get(k),
    reserve: (r) => inner.reserve(r),
    complete: () => { throw new Error("disk full"); },
    release: (k) => inner.release(k),
    forget: (k) => inner.forget(k),
  };
  const { sender, client } = setup({ store: broken });
  const printed: string[] = [];
  const original = console.error;
  console.error = (m: string) => { printed.push(m); };
  try {
    await assert.rejects(client.approve("m-1", "key-c"), /disk full/);
  } finally {
    console.error = original;
  }
  assert.equal(sender.sent.length, 1);
  assert.equal(inner.get(`${ALICE}:key-c`)?.txHash, null);
  assert.match(printed[0], /key-c.*sent 0xaa0+1/);
  await assert.rejects(client.approve("m-1", "key-c"), IdempotencyInFlightError);
  assert.equal(sender.sent.length, 1);
});

// ---- resolve ----

test("resolve: a confirmed transaction keeps its key", async () => {
  const { node, sender, client } = setup();
  const ref = await client.approve("m-1", "k");
  node.receipts.set(ref.txHash, { status: 1, blockNumber: 99 });
  assert.equal(await client.resolve("k"), "confirmed");
  assert.deepEqual(await client.approve("m-1", "k"), ref);
  assert.equal(sender.sent.length, 1);
});

test("resolve: a transaction that reverted on-chain frees the key, and the call can be sent again", async () => {
  const { node, sender, client } = setup();
  const ref = await client.approve("m-1", "k");
  node.receipts.set(ref.txHash, { status: 0, blockNumber: 99 });
  assert.equal(await client.resolve("k"), "freed");
  const again = await client.approve("m-1", "k");
  assert.notEqual(again.txHash, ref.txHash);
  assert.equal(sender.sent.length, 2);
});

test("resolve: a transaction still in the mempool is left alone", async () => {
  const { node, client } = setup();
  const ref = await client.approve("m-1", "k");
  node.mempool.set(ref.txHash, { from: ALICE, to: CONFIG.escrow, data: "0x" });
  node.pending = 1;
  assert.equal(await client.resolve("k"), "pending");
  assert.deepEqual(await client.approve("m-1", "k"), ref);
});

test("resolve: a dropped transaction frees the key only when old enough and nothing is pending", async () => {
  const young = setup({ minAge: 60_000 });
  await young.client.approve("m-1", "k");
  await assert.rejects(young.client.resolve("k"), CannotResolveError); // too recent: the node may just be behind

  const busy = setup();
  await busy.client.approve("m-1", "k");
  busy.node.pending = 1; // something from this sender is still in the mempool
  await assert.rejects(busy.client.resolve("k"), CannotResolveError);

  const dropped = setup();
  await dropped.client.approve("m-1", "k");
  assert.equal(await dropped.client.resolve("k"), "freed");
});

test("resolve: a key with no hash is freed only if the sender has mined nothing since", async () => {
  const store = new InMemoryIdempotencyStore();
  const crashed = setup({ store, fail: () => makeError("timeout", "TIMEOUT") });
  crashed.node.mined = crashed.node.pending = 5;
  await assert.rejects(crashed.client.approve("m-1", "k"));

  const later = setup({ store });
  later.node.mined = later.node.pending = 6; // one transaction was mined after the key was claimed
  await assert.rejects(later.client.resolve("k"), /pass the transaction hash/);
  assert.equal(store.get(`${ALICE}:k`)?.txHash, null);

  const quiet = setup({ store });
  quiet.node.mined = quiet.node.pending = 5;
  assert.equal(await quiet.client.resolve("k"), "freed");
  assert.equal(store.get(`${ALICE}:k`), undefined);
});

test("resolve with a supplied hash: accepted only if it is this sender's exact call", async () => {
  const store = new InMemoryIdempotencyStore();
  const probe = setup(); // a healthy client, only to learn the calldata of approve("m-1")
  await probe.client.approve("m-1", "probe");
  const data = probe.sender.sent[0].data;

  const crashed = setup({ store, fail: () => makeError("timeout", "TIMEOUT") });
  await assert.rejects(crashed.client.approve("m-1", "k"));

  const { node, client } = setup({ store });
  node.mined = node.pending = 1;
  node.mempool.set("0xother", { from: ALICE, to: CONFIG.escrow, data: data.slice(0, -2) + "ff" });
  node.mempool.set("0xbob", { from: BOB, to: CONFIG.escrow, data });
  node.mempool.set("0xreal", { from: ALICE, to: CONFIG.escrow, data });
  await assert.rejects(client.resolve("k", { txHash: "0xmissing" }), /was not found/);
  await assert.rejects(client.resolve("k", { txHash: "0xother" }), /not the call behind this key/);
  await assert.rejects(client.resolve("k", { txHash: "0xbob" }), /not the call behind this key/);
  assert.equal(store.get(`${ALICE}:k`)?.txHash, null);

  node.receipts.set("0xreal", { status: 1, blockNumber: 99 });
  assert.equal(await client.resolve("k", { txHash: "0xreal" }), "confirmed");
  assert.equal((await client.approve("m-1", "k")).txHash, "0xreal");
});

test("resolve: an unknown key is an error", async () => {
  const { client } = setup();
  await assert.rejects(client.resolve("nope"), CannotResolveError);
});

// ---- test networks only ----

test("the client refuses to work when the RPC reports a different chain id", async () => {
  const { node, sender, client } = setup();
  node.chainId = 1;
  await assert.rejects(client.approve("m-1", "k"), /RPC reports chain id 1/);
  await assert.rejects(client.txStatus("0x1"), /RPC reports chain id 1/);
  await assert.rejects(client.balance(ALICE), /RPC reports chain id 1/);
  assert.equal(sender.sent.length, 0);
});

test("a mainnet chain id is refused even if the config calls it a test network", () => {
  for (const chainId of [1, 137, 8453, 42161]) {
    assert.throws(
      () => new EvmChainClient({ ...CONFIG, chainId }, fakeSender(), new InMemoryIdempotencyStore()),
      /is a mainnet/,
    );
  }
  assert.throws(
    () => new EvmChainClient({ ...CONFIG, testnet: false }, fakeSender(), new InMemoryIdempotencyStore()),
    /not marked as a test network/,
  );
});

test("loadChain refuses mainnet ids, unmarked chains and unknown names", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tethran-")), "chains.json");
  writeFileSync(path, JSON.stringify({
    defaultChain: "test",
    chains: {
      unmarked: { name: "X", chainId: 999, rpcUrl: "http://x", usdt: "", escrow: "", receiptNft: "" },
      lying: { name: "Mainnet", chainId: 1, rpcUrl: "http://x", testnet: true, usdt: "", escrow: "", receiptNft: "" },
      test: { name: "T", chainId: 5, rpcUrl: "http://x", testnet: true, usdt: "", escrow: "", receiptNft: "" },
    },
  }));
  assert.throws(() => loadChain("unmarked", path), /not marked as a test network/);
  assert.throws(() => loadChain("lying", path), /is a mainnet/);
  assert.throws(() => loadChain("nope", path), /no chain/);
  assert.equal(loadChain("test", path).chainId, 5);
  assert.equal(loadChain("test", path).confirmations, 1);
});

// ---- encoding and helpers ----

test("decide encodes the attestations; attestationTypedData matches INTERFACES.md", async () => {
  const { sender, client } = setup();
  await client.decide("m-1", true, ["0x12", "0x34"], [CONFIG.usdt, CONFIG.escrow], "key-d");
  assert.equal(sender.sent.length, 1);
  assert.ok(sender.sent[0].data.includes(milestoneIdToBytes32("m-1").slice(2)));
  const td = client.attestationTypedData("m-1", 2, false);
  assert.deepEqual(td.domain, { name: "TethranEscrow", version: "1", chainId: 31337, verifyingContract: CONFIG.escrow });
  assert.deepEqual(td.types.Attestation.map((f) => f.name), ["milestoneId", "kind", "releaseToProvider"]);
  assert.deepEqual(td.message, { milestoneId: milestoneIdToBytes32("m-1"), kind: 2, releaseToProvider: false });
});

test("refundApproved is sent to the escrow with its own selector", async () => {
  const { sender, client } = setup();
  await client.refund("m-1", "k1");
  await client.refundApproved("m-1", "k2");
  assert.equal(sender.sent[1].to, CONFIG.escrow);
  assert.notEqual(sender.sent[0].data.slice(0, 10), sender.sent[1].data.slice(0, 10));
});

test("calls whose contracts are not built yet fail loudly", async () => {
  const { client } = setup();
  await assert.rejects( // no ReceiptNFT address in this config
    client.mintReceipt({ milestoneId: "m", holder: ALICE, invoiceHash: "0x", settlementHash: "0x", amount: "1", releaseTx: "0x" }, "k"),
    NotBuiltYetError);
  const withNft = new EvmChainClient({ ...CONFIG, receiptNft: "0x00000000000000000000000000000000000000c3" }, fakeSender(),
    new InMemoryIdempotencyStore(), { provider: fakeNode().reader });
  const h = "0x" + "11".repeat(32);
  await withNft.mintReceipt({ milestoneId: "m-1", holder: BOB, invoiceHash: h, settlementHash: h, amount: "5", releaseTx: h }, "k");
});

test("vault calls go to the vault address with the right function and arguments", async () => {
  const { sender, client } = setup();
  const VAULT = "0x00000000000000000000000000000000000000f1";
  const h = "0x" + "ab".repeat(32);
  const actionId = vaultActionId(h, 2);
  // keccak256(abi.encode(bytes32, uint256)): the hash followed by the index as a 32-byte number
  assert.equal(actionId, keccak256(h + (2).toString(16).padStart(64, "0")));

  await client.vaultExecute({
    vault: VAULT, to: BOB, amount: "5000000", proposalHash: h, actionId, deadline: 1_800_000_900,
    agentSig: "0x11", policySig: "0x22",
  }, "k1");
  await client.setPolicy({ vault: VAULT, version: 1, perTxCap: "1", dailyCap: "2", minReserve: "3", operatorSig: "0x33" }, "k2");
  await client.setPayees({ vault: VAULT, version: 2, payees: [BOB, ALICE], allowed: true, operatorSig: "0x44" }, "k3");
  await client.rotateVaultSigners({ vault: VAULT, version: 3, agentSigner: ALICE, policySigner: BOB, operatorSig: "0x55" }, "k4");
  await client.vaultWithdraw({ vault: VAULT, version: 4, amount: "7", operatorSig: "0x66" }, "k5");

  assert.equal(sender.sent.length, 5);
  assert.ok(sender.sent.every((t) => t.to === VAULT));
  assert.equal(new Set(sender.sent.map((t) => t.data.slice(0, 10))).size, 5); // five different functions
  assert.ok(sender.sent[0].data.includes(actionId.slice(2)));
  assert.ok(sender.sent[0].data.includes((1_800_000_900).toString(16)));
  // the same transfer again with the same key sends nothing; with a changed deadline it is a different call
  await client.vaultExecute({
    vault: VAULT, to: BOB, amount: "5000000", proposalHash: h, actionId, deadline: 1_800_000_900,
    agentSig: "0x11", policySig: "0x22",
  }, "k1");
  assert.equal(sender.sent.length, 5);

  assert.deepEqual(client.vaultDomain(VAULT), { name: "TethranVault", version: "1", chainId: 31337, verifyingContract: VAULT });
  assert.deepEqual(VAULT_TYPES.Transfer.map((f) => f.name), ["to", "amount", "proposalHash", "actionId", "deadline"]);
  assert.deepEqual(VAULT_TYPES.SetPayees.map((f) => f.type), ["uint256", "address[]", "bool"]);
});

test("assertMilestoneMatches: the backend's check after funding", () => {
  const expected = {
    milestoneId: "m-1", funder: ALICE, client: "0x" + "c1".repeat(20), provider: "0x" + "c2".repeat(20),
    arbiter: "0x" + "c3".repeat(20), vault: "0x" + "c4".repeat(20), amount: "5000000",
    timeout: 2_000_000_000, cardFunded: true, holdSeconds: 3600,
  };
  const onChain: MilestoneView = {
    funder: ALICE.toUpperCase().replace("0X", "0x"), client: expected.client, provider: expected.provider,
    arbiter: expected.arbiter, vault: expected.vault, amount: "5000000", timeout: 2_000_000_000,
    approvedAt: 0, holdSeconds: 3600, cardFunded: true, state: "Funded",
  };
  assertMilestoneMatches(onChain, expected); // address case does not matter
  assertMilestoneMatches({ ...onChain, timeout: onChain.timeout + 600 }, expected); // a dispute pushed it out

  const wrong = (change: Partial<MilestoneView>, field: string) => assert.throws(
    () => assertMilestoneMatches({ ...onChain, ...change }, expected),
    (e: unknown) => e instanceof MilestoneMismatchError && e.fields.some((f) => f.includes(field)),
    field,
  );
  // the front-running case: same id and parties, but someone else's money, amount and vault
  wrong({ funder: BOB }, "funder");
  wrong({ vault: BOB }, "vault");
  wrong({ amount: "1" }, "amount");
  wrong({ client: BOB }, "client");
  wrong({ provider: BOB }, "provider");
  wrong({ arbiter: BOB }, "arbiter");
  wrong({ timeout: onChain.timeout - 1 }, "timeout");
  wrong({ cardFunded: false }, "cardFunded");
  wrong({ holdSeconds: 0 }, "holdSeconds");
  wrong({ state: "None" }, "state");
  assertMilestoneMatches({ ...onChain, state: "Approved" }, expected, "Approved");
});

test("safeErrorMessage removes URLs (an RPC URL can carry an API key)", () => {
  const e = makeError("could not reach https://rpc.example/v2/SECRETKEY123 (request failed)", "NETWORK_ERROR");
  const text = safeErrorMessage(e);
  assert.ok(!text.includes("SECRETKEY123"));
  assert.ok(!text.includes("rpc.example"));
  assert.match(text, /\[url removed\]/);
  assert.match(text, /NETWORK_ERROR/);
  assert.ok(!safeErrorMessage(new Error("see wss://node.example/ws?key=abc now")).includes("abc"));
  assert.equal(safeErrorMessage("plain string"), "plain string");
});
