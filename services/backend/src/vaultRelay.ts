// Submits operator-signed vault actions (SetPolicy, SetPayees) on behalf of the Policy Service, using the
// treasury account for gas. Called only from the internal route. The treasury adds no authority here: the vault
// accepts an action only if the operator signed it and its version is the next one.
import { isAddress } from "ethers";
import { traceTool } from "../../llm/src/index";
import type { TreasuryChain } from "./chainPort";
import { ApiError } from "./errors";

export type RelayAction =
  | { type: "setPolicy"; version: number; perTxCap: string; dailyCap: string; minReserve: string; operator_signature: string }
  | { type: "setPayees"; version: number; payees: string[]; allowed: boolean; operator_signature: string };

export async function relayVaultActions(chain: TreasuryChain, vault: unknown, actions: unknown) {
  if (typeof vault !== "string" || !isAddress(vault)) throw new ApiError(400, "vault must be an address");
  if (!Array.isArray(actions) || actions.length === 0) throw new ApiError(400, "actions must be a non-empty array");
  const transactions: { type: string; version: number; tx: string }[] = [];
  for (const a of actions as RelayAction[]) {
    const key = `vault-action:${vault.toLowerCase()}:${a.version}`;
    const ref = await traceTool(`vault.${a.type}`, { input: { version: a.version } }, async () => {
      const r = a.type === "setPolicy"
        ? await chain.setPolicy({ vault, version: a.version, perTxCap: a.perTxCap, dailyCap: a.dailyCap, minReserve: a.minReserve, operatorSig: a.operator_signature }, key)
        : a.type === "setPayees"
          ? await chain.setPayees({ vault, version: a.version, payees: a.payees, allowed: a.allowed, operatorSig: a.operator_signature }, key)
          : (() => { throw new ApiError(400, "unknown action type"); })();
      await chain.waitConfirmed(r.txHash);
      return r;
    });
    transactions.push({ type: a.type, version: a.version, tx: ref.txHash });
  }
  return { transactions };
}
