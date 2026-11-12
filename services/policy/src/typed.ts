import { createHash } from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { canonicalise } from "./engine";
import type { Policy } from "./types";

// EIP-712 definitions that are only VERIFIED here (operator signatures, attestations).
// Nothing in this file touches a private key.

export type TypedField = { name: string; type: string };
export type TypedTypes = Record<string, TypedField[]>;
export type TypedDomain = { name: string; version: string; chainId?: number; verifyingContract?: string };

// --- Operator policy updates and approval decisions ---
// INTERFACES.md does not define what the operator signs for these endpoints; this is our choice (see the report).
export const policyDomain: TypedDomain = { name: "TethranPolicy", version: "1" };

export const policyDocumentTypes: TypedTypes = {
  PolicyDocument: [
    { name: "version", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
  ],
};

export const approvalDecisionTypes: TypedTypes = {
  ApprovalDecision: [
    { name: "approvalId", type: "string" },
    { name: "decision", type: "string" },
    { name: "proposalHash", type: "bytes32" },
  ],
};

// sha256 of the canonical JSON of the policy document, 0x-prefixed.
export function policyHash(policy: Policy): string {
  return "0x" + createHash("sha256").update(canonicalise(policy)).digest("hex");
}

export function policyDocumentValue(version: number, policy: Policy) {
  return { version, policyHash: policyHash(policy) };
}

export function approvalDecisionValue(approvalId: string, decision: string, proposalHashHex: string) {
  return { approvalId, decision, proposalHash: "0x" + proposalHashHex };
}

// --- Escrow attestation (INTERFACES.md section 3) ---
export const attestationTypes: TypedTypes = {
  Attestation: [
    { name: "milestoneId", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "releaseToProvider", type: "bool" },
  ],
};

export function attestationDomain(chainId: number, escrow: string): TypedDomain {
  return { name: "TethranEscrow", version: "1", chainId, verifyingContract: escrow };
}

export const ATTESTATION_KIND = { client: 0, provider: 1, arbiter: 2 } as const;
export type AttestationType = keyof typeof ATTESTATION_KIND;

// On-chain milestone id: keccak256 of the UTF-8 milestone UUID.
export function onChainMilestoneId(milestoneUuid: string): string {
  return keccak256(toUtf8Bytes(milestoneUuid));
}

// True only if the signature is well formed and recovers exactly to `expected`.
export function signatureMatches(
  domain: TypedDomain,
  types: TypedTypes,
  value: Record<string, unknown>,
  signature: string,
  expected: string,
): boolean {
  try {
    const recovered = verifyTypedData(domain, types, value, signature);
    return getAddress(recovered) === getAddress(expected);
  } catch {
    return false; // malformed signature or address
  }
}
