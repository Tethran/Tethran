import { test } from "node:test";
import assert from "node:assert/strict";
import { Mnemonic, randomBytes, verifyTypedData } from "ethers";
import { createWdkWallets } from "../src/wdk";

const chain = {
  key: "localhost", name: "localhost", testnet: true, chainId: 31337, rpcUrl: "http://127.0.0.1:1", confirmations: 1,
  usdt: "0x00000000000000000000000000000000000000c1", escrow: "0x00000000000000000000000000000000000000e5",
} as never;

const TWA = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

test("WDK signing policy: small test-USDT x402 authorizations sign; larger ones, other tokens and unknown types are refused", async () => {
  const seed = Mnemonic.fromEntropy(randomBytes(16)).phrase; // throwaway test seed
  const w = createWdkWallets({ chain, seed, maxTransfer: 10_000_000n, maxAuthorization: 50_000n });
  const budget = await w.account("agent_budget");
  const from = await budget.getAddress();
  const domain = { name: "Tethran Test USDT", version: "1", chainId: 31337, verifyingContract: "0x00000000000000000000000000000000000000c1" };
  const msg = (value: string) => ({ from, to: "0x00000000000000000000000000000000000000a0", value, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) });

  const sig = await budget.signTypedData({ domain, types: TWA, message: msg("20000") });
  assert.equal(verifyTypedData(domain, TWA, msg("20000"), sig), from);

  await assert.rejects(budget.signTypedData({ domain, types: TWA, message: msg("50001") }));
  await assert.rejects(budget.signTypedData({ domain: { ...domain, verifyingContract: "0x00000000000000000000000000000000000000f0" }, types: TWA, message: msg("1") }));
  await assert.rejects(budget.signTypedData({ domain, types: { Permit: [{ name: "value", type: "uint256" }] }, message: { value: "1" } }));
});
