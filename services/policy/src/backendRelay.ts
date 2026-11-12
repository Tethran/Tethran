// Relays checked, operator-signed vault actions through the backend, which submits them with the treasury
// account (it has gas; the Policy Service key does not, and it should not be sending transactions anyway).
// The backend adds no authority: the vault verifies the operator's signature on every action itself.
import type { ChainWriter } from "./service";

export function createBackendRelay(opts: { backendUrl: string; internalToken: string; fetch?: typeof fetch }): ChainWriter {
  const f = opts.fetch ?? fetch;
  return {
    async relayVaultActions(vault, actions) {
      const res = await f(new URL("/internal/vault-actions", opts.backendUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": opts.internalToken },
        body: JSON.stringify({ vault, actions }),
        signal: AbortSignal.timeout(300_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`backend relay failed with ${res.status}: ${String(json.error ?? "").slice(0, 200)}`);
      return json.transactions;
    },
  };
}
