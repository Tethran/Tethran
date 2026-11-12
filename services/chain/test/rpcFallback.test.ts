import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RPC_FALLBACK_ATTEMPTS, RPC_READ_ATTEMPTS, newProvider } from "../src/evmChainClient";

/** A tiny JSON-RPC endpoint: "fail" answers 503 to everything; "ok" answers chain id 31337 and block 7. */
function endpoint(mode: "fail" | "ok") {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msgs = [JSON.parse(body)].flat();
      for (const m of msgs) calls.push(m.method);
      if (mode === "fail") { res.writeHead(503); return res.end("unavailable"); }
      const out = msgs.map((m) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "eth_chainId" ? "0x7a69" : "0x7" }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  return new Promise<{ url: string; calls: string[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls,
      close: () => new Promise((r) => server.close(() => r())),
    })));
}

const cfg = (rpcUrl: string, fallbackRpcUrl?: string) =>
  ({ key: "localhost", name: "t", chainId: 31337, rpcUrl, fallbackRpcUrl, testnet: true, confirmations: 1, usdt: "0x", escrow: "0x" }) as never;

test("reads: the primary is retried, then the read goes to the public fallback", { timeout: 60_000 }, async () => {
  const primary = await endpoint("fail");
  const fallback = await endpoint("ok");
  try {
    const p = newProvider(cfg(primary.url, fallback.url));
    assert.equal(await p.getBlockNumber(), 7);
    assert.equal(primary.calls.filter((m) => m === "eth_blockNumber").length, RPC_READ_ATTEMPTS);
    assert.equal(fallback.calls.filter((m) => m === "eth_blockNumber").length, 1);
    p.destroy();
  } finally { await primary.close(); await fallback.close(); }
});

test("sends: eth_sendRawTransaction goes to the primary once and never to the fallback", { timeout: 60_000 }, async () => {
  const primary = await endpoint("fail");
  const fallback = await endpoint("ok");
  try {
    const p = newProvider(cfg(primary.url, fallback.url));
    await assert.rejects(p.send("eth_sendRawTransaction", ["0x00"]));
    assert.equal(primary.calls.filter((m) => m === "eth_sendRawTransaction").length, 1);
    assert.equal(fallback.calls.includes("eth_sendRawTransaction"), false);
    p.destroy();
  } finally { await primary.close(); await fallback.close(); }
});

test("no fallback configured: reads give up after the primary's attempts", { timeout: 60_000 }, async () => {
  const primary = await endpoint("fail");
  try {
    const p = newProvider(cfg(primary.url));
    await assert.rejects(p.getBlockNumber());
    assert.equal(primary.calls.filter((m) => m === "eth_blockNumber").length, RPC_READ_ATTEMPTS);
    assert.ok(RPC_FALLBACK_ATTEMPTS >= 1);
    p.destroy();
  } finally { await primary.close(); }
});
