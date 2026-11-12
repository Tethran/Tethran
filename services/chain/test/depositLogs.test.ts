// Review finding 5: deposits count only Transfer logs from our token, in a successful transaction on our chain,
// with the block time attached so the backend can refuse a transfer made before the milestone existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, id, zeroPadValue } from "ethers";
import { EvmChainClient, InMemoryIdempotencyStore } from "../src";
import type { ChainConfig, ChainReader } from "../src";

const USDT = "0x0000000000000000000000000000000000000001";
const FAKE_TOKEN = "0x00000000000000000000000000000000000000f0";
const CLIENT = "0x00000000000000000000000000000000000000c1";
const TREASURY = "0x00000000000000000000000000000000000000a0";
const CONFIG: ChainConfig = {
  key: "test", name: "Test", chainId: 31337, rpcUrl: "http://127.0.0.1:1", testnet: true, confirmations: 1,
  usdt: USDT, escrow: "0x0000000000000000000000000000000000000002", receiptNft: "",
} as ChainConfig;

const TRANSFER = id("Transfer(address,address,uint256)");
const log = (address: string, value: bigint) => ({
  address, topics: [TRANSFER, zeroPadValue(CLIENT, 32), zeroPadValue(TREASURY, 32)], data: AbiCoder.defaultAbiCoder().encode(["uint256"], [value]),
});

function client(receipts: Record<string, unknown>, chainId = 31337) {
  const reader = {
    send: async (m: string) => { if (m === "eth_chainId") return "0x" + chainId.toString(16); throw new Error("unexpected " + m); },
    getTransactionReceipt: async (h: string) => (receipts[h] as never) ?? null,
    getBlock: async (n: number) => ({ number: n, timestamp: 1_800_000_000 + n }),
    getBlockNumber: async () => 100,
  } as unknown as ChainReader;
  const sender = { getAddress: async () => TREASURY, sendTransaction: async () => ({ hash: "0x" }) };
  return new EvmChainClient(CONFIG, sender, new InMemoryIdempotencyStore(), { provider: reader });
}

test("only Transfer logs from our token count; a fake token's identical Transfer event is ignored", async () => {
  const c = client({
    "0xaa": { status: 1, blockNumber: 7, logs: [log(FAKE_TOKEN, 999_000_000n), log(USDT, 100_000_000n)] },
    "0xbb": { status: 1, blockNumber: 8, logs: [log(FAKE_TOKEN, 100_000_000n)] },
  });
  const ours = await c.usdtTransfersInTx("0xaa");
  assert.equal(ours.length, 1);
  assert.equal(ours[0]!.value, "100000000");
  assert.equal(ours[0]!.blockTime, 1_800_000_007);
  assert.deepEqual(await c.usdtTransfersInTx("0xbb"), []); // only a fake token: nothing
});

test("a failed or unknown transaction counts for nothing", async () => {
  const c = client({ "0xcc": { status: 0, blockNumber: 9, logs: [log(USDT, 100_000_000n)] } });
  assert.deepEqual(await c.usdtTransfersInTx("0xcc"), []);
  assert.deepEqual(await c.usdtTransfersInTx("0xdd"), []);
});

test("an RPC on another chain is refused before anything is read", async () => {
  const c = client({ "0xaa": { status: 1, blockNumber: 7, logs: [log(USDT, 100_000_000n)] } }, 1);
  await assert.rejects(c.usdtTransfersInTx("0xaa"));
});
