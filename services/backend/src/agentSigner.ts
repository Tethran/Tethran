// The agent signer module: holds the AGENT_SIGNER key, the first of the vault's two co-signers.
//
// This is NOT the LLM. The model never sees this key, these signatures or this code. The module signs a vault
// Transfer only when ALL of these hold:
//   1. the Policy Service has already signed exactly the same Transfer (its signature recovers to the vault's
//      policySigner, read from the chain, not from the caller);
//   2. the deadline is in the future and no further out than the Policy Service's window allows;
//   3. the transfer is for the chain and vault it is asked about.
// So the agent side can only ever add the second signature to a transfer the Policy Service approved.
import { getAddress, verifyTypedData, type Wallet } from "ethers";
import { VAULT_TYPES } from "../../chain/src/index";
import { ApiError } from "./errors";

export interface TransferToSign {
  vault: string;
  chainId: number;
  to: string;
  amount: string;
  proposalHash: string;
  actionId: string;
  deadline: number;
  policySig: string;
}

/** Longest deadline the Policy Service issues (15 minutes) plus a little clock skew. */
const MAX_DEADLINE_AHEAD_SECONDS = 15 * 60 + 60;

export function createAgentSigner(
  wallet: Pick<Wallet, "address" | "signTypedData">,
  vaultPolicySigner: (vault: string) => Promise<string>,
  now: () => Date,
) {
  return {
    address: wallet.address,

    async sign(t: TransferToSign): Promise<string> {
      const nowS = Math.floor(now().getTime() / 1000);
      if (!Number.isInteger(t.deadline) || t.deadline <= nowS) throw new ApiError(409, "co-signature has expired", "EXPIRED");
      if (t.deadline > nowS + MAX_DEADLINE_AHEAD_SECONDS) throw new ApiError(409, "deadline is further out than the Policy Service issues", "BAD_DEADLINE");

      const domain = { name: "TethranVault", version: "1", chainId: t.chainId, verifyingContract: getAddress(t.vault) };
      const types = { Transfer: [...VAULT_TYPES.Transfer] };
      const value = { to: getAddress(t.to), amount: BigInt(t.amount), proposalHash: t.proposalHash, actionId: t.actionId, deadline: t.deadline };

      const policySigner = getAddress(await vaultPolicySigner(t.vault));
      let recovered: string;
      try {
        recovered = getAddress(verifyTypedData(domain, types, value, t.policySig));
      } catch {
        throw new ApiError(409, "Policy Service signature is malformed", "BAD_POLICY_SIGNATURE");
      }
      if (recovered !== policySigner) {
        throw new ApiError(409, "transfer is not signed by the vault's Policy Service signer", "BAD_POLICY_SIGNATURE");
      }
      return wallet.signTypedData(domain, types, value);
    },
  };
}

export type AgentSigner = ReturnType<typeof createAgentSigner>;
