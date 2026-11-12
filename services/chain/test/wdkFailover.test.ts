// WDK wallet reads go through @tetherto/wdk-failover-provider: the API-key RPC first, the public RPC second. A primary
// that does not answer in time moves the call to the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Mnemonic, randomBytes } from "ethers";
import { createWdkProvider, createWdkWallets, isFailoverError } from "../src/wdk";

/** "hang" never answers (a timed-out RPC); "revert" answers every call with a JSON-RPC error; "ok" answers balances. */
function endpoint(mode: "hang" | "ok" | "revert") {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const msgs = [parsed].flat();
      for (const m of msgs) calls.push(m.method);
      if (mode === "hang") return; // no reply at all
      const out = msgs.map((m) => mode === "revert"
        ? { jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted", data: "0x" } }
        : { jsonrpc: "2.0", id: m.id, result: m.method === "eth_chainId" ? "0x7a69" : m.method === "eth_getBalance" ? "0x2a" : "0x7" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  return new Promise<{ url: string; calls: string[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    })));
}

const ADDR = "0x00000000000000000000000000000000000000a1";

test("WDK provider: a primary that times out fails over to the fallback RPC", { timeout: 30_000 }, async () => {
  const primary = await endpoint("hang");
  const fallback = await endpoint("ok");
  try {
    const p = createWdkProvider({ chainId: 31337, rpcUrl: primary.url, fallbackRpcUrl: fallback.url }, { timeoutMs: 500 });
    const started = Date.now();
    assert.equal(await p.getBalance(ADDR), 42n);
    assert.ok(Date.now() - started < 10_000, "failed over after the timeout, not after ethers' default 5 minutes");
    assert.ok(primary.calls.includes("eth_getBalance"), "the primary was asked first");
    assert.ok(fallback.calls.includes("eth_getBalance"), "the fallback answered");
    assert.ok(!primary.calls.includes("eth_chainId") && !fallback.calls.includes("eth_chainId"), "chain id is pinned, never asked");
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("WDK wallets: an account balance read falls over through WDK itself", { timeout: 30_000 }, async () => {
  const primary = await endpoint("hang");
  const fallback = await endpoint("ok");
  try {
    const chain = {
      key: "localhost", name: "localhost", testnet: true, chainId: 31337, confirmations: 1, rpcUrl: primary.url, fallbackRpcUrl: fallback.url,
      usdt: "0x00000000000000000000000000000000000000c1", escrow: "0x00000000000000000000000000000000000000e5",
    } as never;
    const seed = Mnemonic.fromEntropy(randomBytes(16)).phrase; // throwaway test seed
    const w = createWdkWallets({ chain, seed, maxTransfer: 1n, provider: createWdkProvider(chain, { timeoutMs: 500 }) });
    assert.equal(await (await w.account("client")).getBalance(), 42n);
    assert.ok(primary.calls.includes("eth_getBalance") && fallback.calls.includes("eth_getBalance"));
    w.dispose();
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("WDK provider: a contract error is not retried on the other RPC (it would fail the same way)", { timeout: 30_000 }, async () => {
  const primary = await endpoint("revert");
  const fallback = await endpoint("ok");
  try {
    const p = createWdkProvider({ chainId: 31337, rpcUrl: primary.url, fallbackRpcUrl: fallback.url }, { timeoutMs: 2_000 });
    await assert.rejects(p.call({ to: ADDR, data: "0x" }));
    assert.equal(fallback.calls.filter((m) => m === "eth_call").length, 0);
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("WDK provider: with no fallback configured there is one RPC; failover errors are only connection errors", () => {
  assert.ok(createWdkProvider({ chainId: 31337, rpcUrl: "http://127.0.0.1:1" }));
  assert.equal(isFailoverError(new Error("execution reverted")), false);
  assert.equal(isFailoverError(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), true);
});
