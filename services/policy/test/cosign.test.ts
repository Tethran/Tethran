import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, keccak256, verifyTypedData, Wallet } from "ethers";
import { actionIdFor, cosignProposal, transferDomain, transferTypes } from "../src/cosign";
import { hashProposal } from "../src/index";
import type { SettlementProposal } from "../src/index";
import { goodProposal } from "./helpers";

const payees = {
  "payee-1": { address: "0x00000000000000000000000000000000000000a1", rail: "usdt", simulated: false },
  "payee-2": { address: "0x00000000000000000000000000000000000000a2", rail: "mpesa", simulated: true },
};
const vault = "0x00000000000000000000000000000000000000b1";

function proposalWithMobileMoney(): SettlementProposal {
  return {
    ...(goodProposal() as unknown as SettlementProposal),
    actions: [
      { type: "tax_reserve", amount: "10", reason: "tax" },
      { type: "payout", payee_id: "payee-1", amount: "100", asset: "USDT" },
      { type: "conversion", amount: "5", target: "NGN", condition: "rate ok" },
      { type: "mobile_money_payout", payee_id: "payee-2", amount: "200", provider: "mpesa" },
    ],
  };
}

test("action_id is keccak256(abi.encode(bytes32 proposalHash, uint256 index))", () => {
  const hash = "ab".repeat(32);
  // abi.encode of (bytes32, uint256) is the 32 hash bytes followed by the index as a 32-byte big-endian number
  const expected = keccak256("0x" + hash + (3).toString(16).padStart(64, "0"));
  assert.equal(actionIdFor(hash, 3), expected);
});

test("co-signature recovers to the Policy signer over the Transfer typed data", async () => {
  const signer = Wallet.createRandom();
  const proposal = proposalWithMobileMoney();
  const proposalHashHex = hashProposal(proposal);
  const sigs = await cosignProposal({ signer, proposal, proposalHashHex, chainId: 11155111, vault, payees });

  assert.equal(sigs.length, 2);
  assert.deepEqual(sigs.map((s) => s.action_index), [1, 3]); // tax_reserve (0) and conversion (2) get none
  assert.equal(sigs[0].amount, "100");
  assert.equal(sigs[0].to, getAddress(payees["payee-1"].address));

  for (const s of sigs) {
    assert.equal(s.action_id, actionIdFor(proposalHashHex, s.action_index));
    const domain = { name: "TethranVault", version: "1", chainId: 11155111, verifyingContract: vault };
    const value = { to: s.to, amount: s.amount, proposalHash: "0x" + proposalHashHex, actionId: s.action_id };
    assert.equal(verifyTypedData(domain, transferTypes, value, s.signature), signer.address);
  }
});

test("a signature does not verify against another vault or chain", async () => {
  const signer = Wallet.createRandom();
  const proposal = proposalWithMobileMoney();
  const proposalHashHex = hashProposal(proposal);
  const [s] = await cosignProposal({ signer, proposal, proposalHashHex, chainId: 1337, vault, payees });
  const value = { to: s.to, amount: s.amount, proposalHash: "0x" + proposalHashHex, actionId: s.action_id };
  const other = verifyTypedData(transferDomain(1337, "0x00000000000000000000000000000000000000b2"), transferTypes, value, s.signature);
  assert.notEqual(other, signer.address);
});

test("no co-signature for tax_reserve and conversion only", async () => {
  const proposal = {
    ...(goodProposal() as unknown as SettlementProposal),
    actions: [
      { type: "tax_reserve", amount: "10", reason: "tax" },
      { type: "conversion", amount: "5", target: "NGN", condition: "rate ok" },
    ],
  } as SettlementProposal;
  const sigs = await cosignProposal({ signer: Wallet.createRandom(), proposal, proposalHashHex: hashProposal(proposal), chainId: 1, vault, payees });
  assert.deepEqual(sigs, []);
});

test("an unknown payee throws instead of signing", async () => {
  const proposal = proposalWithMobileMoney();
  await assert.rejects(
    cosignProposal({ signer: Wallet.createRandom(), proposal, proposalHashHex: hashProposal(proposal), chainId: 1, vault, payees: {} }),
  );
});
