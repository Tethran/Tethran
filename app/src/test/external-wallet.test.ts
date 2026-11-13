// External wallet core with a mocked AppKit client and provider: connect state, account changes, wrong network,
// a declined request, and a missing project id.
import { describe, expect, it } from "vitest";
import { classifyWalletError, createExternalWallet, shortAddress, SEPOLIA_ID, type KitLike } from "@/wallet/external";

function fakeKit(reply: (method: string) => unknown = () => "0xsig") {
  let account: (s: { address?: string; isConnected?: boolean }) => void = () => {};
  let network: (s: { chainId?: string | number }) => void = () => {};
  const calls: string[] = [];
  const kit: KitLike = {
    open: async () => { account({ address: "0x1111111111111111111111111111111111111111", isConnected: true }); network({ chainId: `eip155:${SEPOLIA_ID}` }); },
    disconnect: async () => account({ isConnected: false }),
    switchNetwork: async () => network({ chainId: SEPOLIA_ID }),
    getWalletProvider: () => ({ request: async ({ method }: { method: string }) => { calls.push(method); const r = reply(method); if (r instanceof Error) throw r; return r; } }),
    subscribeAccount: (cb) => { account = cb; return () => {}; },
    subscribeNetwork: (cb) => { network = cb; return () => {}; },
  };
  return { kit, calls, setAccount: (s: { address?: string; isConnected?: boolean }) => account(s), setChain: (c: number) => network({ chainId: c }) };
}

describe("external wallet", () => {
  it("connects, shows the short address, follows account changes and disconnects", async () => {
    const f = fakeKit();
    const w = createExternalWallet(async () => ({ kit: f.kit, sepolia: {} }));
    expect(w.state.connected).toBe(false);
    await w.connect();
    expect([w.state.status, w.state.connected, w.state.chainId]).toEqual(["ready", true, SEPOLIA_ID]);
    expect(shortAddress(w.state.address)).toBe("0x1111…1111");
    f.setAccount({ address: "0x2222222222222222222222222222222222222222", isConnected: true });
    expect(w.state.address).toBe("0x2222222222222222222222222222222222222222");
    await w.disconnect();
    expect([w.state.connected, w.state.address]).toEqual([false, null]);
  });

  it("refuses requests on the wrong network until the wallet switches to Sepolia", async () => {
    const f = fakeKit();
    const w = createExternalWallet(async () => ({ kit: f.kit, sepolia: {} }));
    await w.connect();
    f.setChain(1);
    expect(w.wrongNetwork()).toBe(true);
    await expect(w.request("eth_signTypedData_v4", [])).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(f.calls).toEqual([]);
    await w.switchToSepolia();
    expect(w.wrongNetwork()).toBe(false);
    await expect(w.request("eth_signTypedData_v4", [])).resolves.toBe("0xsig");
  });

  it("a declined request says so plainly; nothing else is assumed", async () => {
    const f = fakeKit(() => Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const w = createExternalWallet(async () => ({ kit: f.kit, sepolia: {} }));
    await w.connect();
    await expect(w.request("eth_sendTransaction", [{}])).rejects.toMatchObject({ code: "REJECTED" });
    expect(classifyWalletError({ code: "ACTION_REJECTED" }).code).toBe("REJECTED");
    expect(classifyWalletError(new Error("boom")).code).toBe("WALLET_ERROR");
  });

  it("without a project id it says so instead of loading; requests need a connection", async () => {
    const w = createExternalWallet(async () => null);
    await w.connect();
    expect(w.state.status).toBe("missing-project-id");
    await expect(w.request("eth_accounts")).rejects.toMatchObject({ code: "WALLET_NOT_CONNECTED" });
  });
});
