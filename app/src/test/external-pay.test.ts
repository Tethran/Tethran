// The connected-wallet review screen and send, with a mocked EIP-1193 provider.
import { afterEach, describe, expect, it } from "vitest";
import { reviewDeposit, sendDeposit, type DepositCall } from "@/wallet/pay";
import { SEPOLIA_ID } from "@/wallet/external";

const CLIENT = "0x00000000000000000000000000000000000000c1";
const call: DepositCall = {
  chain_id: SEPOLIA_ID, to: "0x00000000000000000000000000000000000000e1", data: "0xa9059cbb", value: "0x0", amount: "400000000",
  from: CLIENT, recipient: { address: "0x00000000000000000000000000000000000000a5", name: "Tethran treasury (escrow deposit)" }, token_symbol: "tUSDT",
};
function provider(receipt: Record<string, { status: string } | null> = {}) {
  const sent: unknown[] = [];
  return {
    sent,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_gasPrice") return "0x3b9aca00";
      if (method === "eth_getTransactionReceipt") return receipt[String(params?.[0])] ?? null;
      if (method === "eth_sendTransaction") { sent.push(params?.[0]); return "0xabc"; }
      throw new Error("unexpected " + method);
    },
  };
}
afterEach(() => localStorage.clear());

describe("connected wallet: review and send", () => {
  it("shows recipient by name, network, amount and the fee separately; can send", async () => {
    const r = await reviewDeposit(provider(), "M1", call, CLIENT, SEPOLIA_ID);
    expect([r.recipientName, r.network, r.amount, r.feeWei, r.canSend]).toEqual(["Tethran treasury (escrow deposit)", "Sepolia (test network)", "400000000", String(21000n * 1_000_000_000n), true]);
  });

  it("wrong network and the wrong account are blocked before anything is signed", async () => {
    const wrong = await reviewDeposit(provider(), "M1", call, CLIENT, 1);
    expect(wrong.blocked.map((b) => b.code)).toEqual(["WRONG_NETWORK"]);
    const other = await reviewDeposit(provider(), "M1", call, "0x00000000000000000000000000000000000000ff", SEPOLIA_ID);
    expect(other.blocked.map((b) => b.code)).toContain("NOT_THE_CLIENT");
  });

  it("sends once; a second try is blocked as pending, then as already sent (the same hash is rechecked)", async () => {
    const p = provider({ "0xabc": { status: "0x1" } });
    expect(await sendDeposit(p, "M1", call, CLIENT, { tries: 1, ms: 0 })).toBe("0xabc");
    expect(p.sent).toHaveLength(1);
    const again = await reviewDeposit(p, "M1", call, CLIENT, SEPOLIA_ID);
    expect(again.blocked.map((b) => b.code)).toEqual(["ALREADY_SENT"]);
    const pending = await reviewDeposit(provider({}), "M1", call, CLIENT, SEPOLIA_ID);
    expect(pending.blocked.map((b) => b.code)).toEqual(["DUPLICATE_PENDING"]);
  });

  it("a declined send keeps nothing; a failed transaction frees the payment", async () => {
    const declined = { request: async ({ method }: { method: string }) => { if (method === "eth_sendTransaction") throw Object.assign(new Error("User rejected"), { code: 4001 }); return null; } };
    await expect(sendDeposit(declined, "M2", call, CLIENT, { tries: 1, ms: 0 })).rejects.toThrow(/rejected/i);
    expect(localStorage.getItem("tethran.deposit.M2")).toBeNull();
    await expect(sendDeposit(provider({ "0xabc": { status: "0x0" } }), "M3", call, CLIENT, { tries: 1, ms: 0 })).rejects.toThrow(/failed on-chain/);
    expect(localStorage.getItem("tethran.deposit.M3")).toBeNull();
  });
});
