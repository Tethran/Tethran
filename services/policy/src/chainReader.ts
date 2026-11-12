// The Policy Service's view of the world, read from the chain wherever possible.
//   vault, gross amount, card funding, release state  -> the escrow milestone, on-chain
//   spent today, vault balance                        -> the provider's vault, on-chain
//   payee addresses, identity match                   -> the backend's internal API (trusted service)
// Payee addresses come from the backend, but a wrong address still cannot be paid: the vault only pays
// addresses on its operator-signed allowlist.
import type { MilestoneFacts, ResolvedPayee } from "./types";
import type { ChainReader } from "./service";

/** The read-only part of ChainClient this file needs. */
export interface ChainReads {
  chainId: number;
  milestone(milestoneId: string): Promise<{ vault: string; amount: string; cardFunded: boolean; state: string }>;
  vaultState(vault: string): Promise<{ spentToday: string; balance: string }>;
}

export function createChainReader(opts: {
  chain: ChainReads;
  backendUrl: string;
  internalToken: string;
  fetch?: typeof fetch;
}): ChainReader {
  const f = opts.fetch ?? fetch;
  async function backend(path: string) {
    const res = await f(new URL(path, opts.backendUrl), {
      headers: { "x-internal-token": opts.internalToken },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`backend ${path.split("/")[2]} lookup failed with ${res.status}`);
    return res.json();
  }

  return {
    async vaultFor(milestoneId) {
      const m = await opts.chain.milestone(milestoneId);
      if (m.state === "None") throw new Error("milestone is not on-chain");
      return { vault: m.vault, chainId: opts.chain.chainId };
    },
    async vaultState(vault) {
      const s = await opts.chain.vaultState(vault);
      return { spentToday: s.spentToday, balance: s.balance };
    },
    async milestoneFacts(milestoneId): Promise<MilestoneFacts> {
      const m = await opts.chain.milestone(milestoneId);
      const identity = (await backend(`/internal/milestones/${encodeURIComponent(milestoneId)}/identity`)) as { match: boolean };
      return {
        cardFunded: m.cardFunded,
        // Released means the escrow already paid the vault, so any card hold has passed.
        releaseEligible: m.state === "Released",
        identityMatch: identity.match === true,
        grossAmount: m.amount,
      };
    },
    async payees(): Promise<Record<string, ResolvedPayee>> {
      return (await backend("/internal/payees")) as Record<string, ResolvedPayee>;
    },
  };
}
