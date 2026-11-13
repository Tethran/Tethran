// The demo wallet in the API module: who pays (the WDK wallet that is the milestone's client), top-ups sent with the
// caller's idempotency key, and the activity mapping. fetch is stubbed; no backend.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, WALLET_USERS } from "@/api";

type Call = { url: string; method: string; body: any };
function stub(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ url: path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(routes).find(([p]) => path === p);
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const WALLETS = { wallets: [{ role: "client", address: "0xC1" }, { role: "payee_amara", address: "0xA1" }] };

describe("demo wallet", () => {
  it("has two people: the client and the freelancer", () => {
    expect(WALLET_USERS.map((u) => [u.role, u.as])).toEqual([["client", "client"], ["payee_amara", "freelancer"]]);
  });

  it("approves with the wallet that is the milestone's client (the freelancer paying as a client)", async () => {
    const calls = stub({ "/milestones/M1": { client_address: "0xa1" }, "/wallets": WALLETS, "/wallets/payee_amara/escrow/M1/approve": { tx_hash: "0x1" } });
    await api.setMilestoneStatus("M1", "Approved");
    expect(calls.at(-1)).toMatchObject({ url: "/wallets/payee_amara/escrow/M1/approve", method: "POST" });
  });

  it("adds funds in cents with the caller's idempotency key", async () => {
    const calls = stub({ "/wallets/client/fund": { amount_usd_cents: 25000, tx_hash: "0x2", repeated: false } });
    await api.addFunds("client", 250, "topup-abc12345");
    expect(calls[0]).toMatchObject({ url: "/wallets/client/fund", method: "POST", body: { amount_usd_cents: 25000, idempotency_key: "topup-abc12345" } });
  });

  it("maps activity to dollars, with direction and the simulated label", async () => {
    stub({ "/wallets/payee_amara/activity": { items: [
      { kind: "payout", direction: "in", amount: "360000000", at: "2026-11-13T09:00:00Z", tx_hash: "0x3", detail: "Milestone payout from the vault" },
      { kind: "top_up", direction: "in", amount: "5000000", at: "2026-11-13T08:00:00Z", tx_hash: "0x4", detail: "Added by card (simulated)", simulated: true },
    ] } });
    const a = await api.walletActivity("payee_amara");
    expect(a.map((i) => [i.kind, i.direction, i.amount, i.simulated])).toEqual([["payout", "in", 360, false], ["top_up", "in", 5, true]]);
  });
});
