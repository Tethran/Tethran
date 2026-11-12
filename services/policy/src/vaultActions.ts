// Checks operator-signed vault actions before they are relayed to the provider's vault (INTERFACES.md 2b).
//
// The operator signs each on-chain change in the vault's own EIP-712 format (SetPolicy, SetPayees). The Policy
// Service checks, before anything is sent:
//   - every signature recovers to the vault's operator as read from the chain, which must also be the operator
//     this Policy Service trusts for the policy document;
//   - the versions continue exactly from the vault's on-chain policyVersion, one by one;
//   - after the actions, the vault's limits equal the document's on-chain fields (per_tx_cap, daily_cap,
//     vault_min_reserve), and every payee on the document's allowlist is allowed on the vault.
// So the Policy Service and the on-chain guard can never disagree about the limits. The vault verifies the
// operator signatures again itself, so the relayer (the backend) cannot change anything.
import { getAddress, isAddress, verifyTypedData } from "ethers";
import type { Policy, ResolvedPayee } from "./types";

export const VAULT_POLICY_TYPES = {
  SetPolicy: [
    { name: "version", type: "uint256" }, { name: "perTxCap", type: "uint256" },
    { name: "dailyCap", type: "uint256" }, { name: "minReserve", type: "uint256" },
  ],
};
export const VAULT_PAYEES_TYPES = {
  SetPayees: [{ name: "version", type: "uint256" }, { name: "payees", type: "address[]" }, { name: "allowed", type: "bool" }],
};

export type VaultAction =
  | { type: "setPolicy"; version: number; perTxCap: string; dailyCap: string; minReserve: string; operator_signature: string }
  | { type: "setPayees"; version: number; payees: string[]; allowed: boolean; operator_signature: string };

export interface VaultOnChain {
  policyVersion: number;
  perTxCap: string;
  dailyCap: string;
  minReserve: string;
  operator: string;
}

export class VaultActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const NUM = /^[0-9]+$/;

/** Validates the shape of the request's vault_actions. Throws VaultActionError(400). */
/** Request size limits (each action is one on-chain transaction; each payee one storage write). */
export const MAX_VAULT_ACTIONS = 10;
export const MAX_PAYEES_PER_ACTION = 50;

export function parseVaultActions(raw: unknown): VaultAction[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new VaultActionError(400, "vault_actions must be an array");
  if (raw.length > MAX_VAULT_ACTIONS) throw new VaultActionError(400, `at most ${MAX_VAULT_ACTIONS} vault actions per request`);
  return raw.map((a, i) => {
    const bad = (m: string): never => { throw new VaultActionError(400, `vault_actions[${i}]: ${m}`); };
    if (typeof a !== "object" || a === null) bad("must be an object");
    if (!Number.isInteger(a.version) || a.version < 1) bad("version must be a positive integer");
    if (typeof a.operator_signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(a.operator_signature)) bad("operator_signature must be a 65-byte hex signature");
    if (a.type === "setPolicy") {
      for (const k of ["perTxCap", "dailyCap", "minReserve"]) if (typeof a[k] !== "string" || !NUM.test(a[k])) bad(`${k} must be a numeric string`);
      return { type: "setPolicy", version: a.version, perTxCap: a.perTxCap, dailyCap: a.dailyCap, minReserve: a.minReserve, operator_signature: a.operator_signature };
    }
    if (a.type === "setPayees") {
      if (Array.isArray(a.payees) && a.payees.length > MAX_PAYEES_PER_ACTION) bad(`at most ${MAX_PAYEES_PER_ACTION} payees per action`);
      if (!Array.isArray(a.payees) || a.payees.length === 0 || !a.payees.every((p: unknown) => typeof p === "string" && isAddress(p))) bad("payees must be a non-empty array of addresses");
      if (typeof a.allowed !== "boolean") bad("allowed must be a boolean");
      return { type: "setPayees", version: a.version, payees: a.payees.map((p: string) => getAddress(p)), allowed: a.allowed, operator_signature: a.operator_signature };
    }
    return bad('type must be "setPolicy" or "setPayees"');
  });
}

/**
 * Checks the actions against the chain and the policy document. `allowedOnChain` answers whether an address is
 * on the vault's allowlist right now. Throws VaultActionError (403 signature, 409 state or consistency).
 */
export async function checkVaultActions(args: {
  vault: string;
  chainId: number;
  actions: VaultAction[];
  doc: Policy;
  onChain: VaultOnChain;
  trustedOperator: string;
  payees: Record<string, ResolvedPayee>;
  allowedOnChain: (address: string) => Promise<boolean>;
}): Promise<void> {
  const { vault, chainId, actions, doc, onChain } = args;
  const operator = getAddress(onChain.operator);
  if (operator !== getAddress(args.trustedOperator)) {
    throw new VaultActionError(403, "the vault's on-chain operator is not the operator this Policy Service trusts");
  }
  const domain = { name: "TethranVault", version: "1", chainId, verifyingContract: getAddress(vault) };

  let version = onChain.policyVersion;
  let limits = { perTxCap: onChain.perTxCap, dailyCap: onChain.dailyCap, minReserve: onChain.minReserve };
  const changed = new Map<string, boolean>(); // address -> allowed, as set by this request
  for (const [i, a] of actions.entries()) {
    if (a.version !== version + 1) throw new VaultActionError(409, `vault_actions[${i}]: version must be ${version + 1} (vault is at ${version})`);
    version = a.version;
    let recovered: string;
    try {
      recovered = a.type === "setPolicy"
        ? verifyTypedData(domain, VAULT_POLICY_TYPES, { version: a.version, perTxCap: a.perTxCap, dailyCap: a.dailyCap, minReserve: a.minReserve }, a.operator_signature)
        : verifyTypedData(domain, VAULT_PAYEES_TYPES, { version: a.version, payees: a.payees, allowed: a.allowed }, a.operator_signature);
    } catch {
      throw new VaultActionError(403, `vault_actions[${i}]: signature is malformed`);
    }
    if (getAddress(recovered) !== operator) throw new VaultActionError(403, `vault_actions[${i}]: not signed by the vault's operator`);
    if (a.type === "setPolicy") limits = { perTxCap: a.perTxCap, dailyCap: a.dailyCap, minReserve: a.minReserve };
    else for (const p of a.payees) changed.set(p, a.allowed);
  }

  const mismatch: string[] = [];
  if (BigInt(limits.perTxCap) !== BigInt(doc.per_tx_cap)) mismatch.push(`per_tx_cap (vault ${limits.perTxCap}, policy ${doc.per_tx_cap})`);
  if (BigInt(limits.dailyCap) !== BigInt(doc.daily_cap)) mismatch.push(`daily_cap (vault ${limits.dailyCap}, policy ${doc.daily_cap})`);
  if (BigInt(limits.minReserve) !== BigInt(doc.vault_min_reserve)) mismatch.push(`vault_min_reserve (vault ${limits.minReserve}, policy ${doc.vault_min_reserve})`);
  for (const id of doc.payee_allowlist) {
    const p = args.payees[id];
    if (!p || !isAddress(p.address)) { mismatch.push(`payee ${id} has no address`); continue; }
    const addr = getAddress(p.address);
    const allowed = changed.has(addr) ? changed.get(addr)! : await args.allowedOnChain(addr);
    if (!allowed) mismatch.push(`payee ${id} is not allowed on the vault`);
  }
  if (mismatch.length > 0) {
    throw new VaultActionError(409, `the policy and the vault would disagree: ${mismatch.join("; ")}. Include operator-signed vault actions for these.`);
  }
}
