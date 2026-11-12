// Shared fixtures for the contract and invoice tests: in-memory db with the existing tables plus ours, a
// movable clock, and a call() that runs the route handlers directly (no server).
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { CONTRACT_DOMAIN, CONTRACT_TYPES, migrateContracts } from "../src/contracts";
import { contractRoutes } from "../src/contractRoutes";
import { openDb } from "../src/db";
import { ApiError } from "../src/errors";

export const providerWallet = Wallet.createRandom();
export const clientWallet = Wallet.createRandom();

export function setup(start = "2026-03-01T09:00:00Z") {
  const db = openDb(":memory:");
  migrateContracts(db);
  const clock = { t: new Date(start) };
  const env = { db, now: () => clock.t, publicBaseUrl: "https://pay.example.test" };
  const routes = contractRoutes(env);
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const url = new URL(path, "http://localhost");
    for (const [m, re, h] of routes) {
      if (m === method && re.test(url.pathname)) {
        const params = re.exec(url.pathname)!.map((p) => decodeURIComponent(p));
        return h({ params: params as never, body, raw: "", req: {} as never, url });
      }
    }
    throw new Error(`no route ${method} ${path}`);
  };
  return { db, env, clock, call, routes };
}

export const contractBody = (over: Record<string, unknown> = {}) => ({
  provider_id: "prov-1", provider_name: "Amara Design Studio", provider_address: providerWallet.address,
  client_name: "Kofi Traders Ltd", client_email: "kofi@example.test", client_address: clientWallet.address,
  currency: "USD", country: "NG",
  milestones: [
    { title: "Brand identity pack", amount_usd_cents: 10_000, acceptance_criteria: "Logo, palette and guide delivered as PDF", due_date: "2026-03-15" },
    { title: "Website design", amount_usd_cents: 25_050, acceptance_criteria: "Five page Figma file", due_date: "2026-04-15" },
  ],
  ...over,
});

export async function expectApi(p: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.status === status && (code === undefined || e.code === code));
}

export const sign = (w: Pick<Wallet, "signTypedData">,contractHash: string, party: string, domain: object = CONTRACT_DOMAIN) =>
  w.signTypedData(domain, CONTRACT_TYPES as any, { contractHash, party });

export async function signBoth(call: ReturnType<typeof setup>["call"], c: { id: string; contract_hash: string }) {
  await call("POST", `/contracts/${c.id}/sign`, { party: "provider", signer: providerWallet.address, signature: await sign(providerWallet, c.contract_hash, "provider") });
  return call("POST", `/contracts/${c.id}/sign`, { party: "client", signer: clientWallet.address, signature: await sign(clientWallet, c.contract_hash, "client") });
}

/** A signed contract, ready for invoices. */
export async function signedContract(s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  const c = await s.call("POST", "/contracts", contractBody(over));
  return signBoth(s.call, c);
}

/** Insert an escrow milestone row the way the existing treasury would (only the columns that matter here). */
export function insertEscrowRow(db: ReturnType<typeof setup>["db"], id: string, state: string) {
  db.prepare(`INSERT INTO milestones (id, provider_id, title, client_address, provider_address, arbiter_address, vault, amount, amount_usd_cents,
    timeout, chain_id, state, invoice_ref, created_at) VALUES (?, 'prov-1', 't', ?, ?, ?, ?, '1', 1, 0, 31337, ?, 'x', '2026-03-01T00:00:00Z')`)
    .run(id, clientWallet.address, providerWallet.address, providerWallet.address, providerWallet.address, state);
}
