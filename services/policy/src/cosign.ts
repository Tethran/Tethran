import { AbiCoder, getAddress, keccak256 } from "ethers";
import type { ResolvedPayee, SettlementProposal } from "./types";

// The ONLY file that touches the Policy Service signing key object.
// It receives a signer (anything with signTypedData, e.g. an ethers Wallet), calls it, and keeps nothing.

export interface TypedDataSigner {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

// INTERFACES.md section 3: Transfer(address to,uint256 amount,bytes32 proposalHash,bytes32 actionId,uint256 deadline)
export const transferTypes = {
  Transfer: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "proposalHash", type: "bytes32" },
    { name: "actionId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export function transferDomain(chainId: number, vault: string) {
  return { name: "TethranVault", version: "1", chainId, verifyingContract: getAddress(vault) };
}

// action_id = keccak256(abi.encode(bytes32 proposalHash, uint256 action_index))
export function actionIdFor(proposalHashHex: string, actionIndex: number): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], ["0x" + proposalHashHex, actionIndex]);
  return keccak256(encoded);
}

export interface Cosignature {
  action_index: number;
  action_id: string;
  to: string;
  amount: string;
  deadline: number; // unix seconds; the vault refuses the transfer after this
  signature: string;
}

// One signature per payout and mobile_money_payout action. tax_reserve and conversion stay in the vault: none.
export async function cosignProposal(args: {
  signer: TypedDataSigner;
  proposal: SettlementProposal;
  proposalHashHex: string; // sha256 hex without 0x, as returned by the engine
  chainId: number;
  vault: string;
  payees: Record<string, ResolvedPayee>;
  deadline: number; // unix seconds, the same for every action of this proposal
}): Promise<Cosignature[]> {
  const { signer, proposal, proposalHashHex, chainId, vault, payees, deadline } = args;
  if (!Number.isInteger(deadline) || deadline <= 0) throw new Error("deadline must be a unix time in seconds");
  const domain = transferDomain(chainId, vault);
  const out: Cosignature[] = [];
  for (let i = 0; i < proposal.actions.length; i++) {
    const action = proposal.actions[i];
    if (action.type !== "payout" && action.type !== "mobile_money_payout") continue;
    if (!Object.hasOwn(payees, action.payee_id)) throw new Error("payee not found for action " + i);
    const to = getAddress(payees[action.payee_id].address);
    const actionId = actionIdFor(proposalHashHex, i);
    const signature = await signer.signTypedData(domain, transferTypes, {
      to,
      amount: action.amount,
      proposalHash: "0x" + proposalHashHex,
      actionId,
      deadline,
    });
    out.push({ action_index: i, action_id: actionId, to, amount: action.amount, deadline, signature });
  }
  return out;
}
