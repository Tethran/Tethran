import { Wallet } from "ethers";
import { openAuditLog } from "../src/audit";
import { createService, recordingChainWriter, type ChainReader, type ServiceDeps } from "../src/service";
import { openApprovalStore, openDecisionStore, openPolicyStore } from "../src/stores";
import {
  approvalDecisionTypes,
  approvalDecisionValue,
  policyDocumentTypes,
  policyDocumentValue,
  policyDomain,
} from "../src/typed";
import type { MilestoneFacts, Policy } from "../src/index";
import { goodProposal, policy as basePolicy } from "./helpers";

export const CHAIN_ID = 31337;
export const VAULT = "0x00000000000000000000000000000000000000b1";
export const ESCROW = "0x00000000000000000000000000000000000000c1";

// Throwaway keys, generated fresh for every harness. No real key is ever used.
export function makeHarness(overrides: Partial<ServiceDeps> = {}) {
  const policySigner = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const audit = openAuditLog();
  const chainWriter = recordingChainWriter();

  const fake = {
    state: { spentToday: "0", balance: "10000000000" },
    facts: { cardFunded: false, releaseEligible: true, identityMatch: true, grossAmount: "500000000" } as MilestoneFacts,
    // The vault starts in agreement with the base policy: same limits, both payees allowed.
    vault: { policyVersion: 2, perTxCap: basePolicy.per_tx_cap, dailyCap: basePolicy.daily_cap, minReserve: basePolicy.vault_min_reserve, operator: operator.address },
    allowed: new Set(["0x00000000000000000000000000000000000000A1", "0x00000000000000000000000000000000000000A2"].map((a) => a.toLowerCase())),
  };
  const chain: ChainReader = {
    async vaultFor() {
      return { vault: VAULT, chainId: CHAIN_ID };
    },
    async vaultState() {
      return { ...fake.state };
    },
    async milestoneFacts() {
      return { ...fake.facts };
    },
    async vaultPolicy() {
      return { ...fake.vault };
    },
    async vaultPayeeAllowed(_v: string, a: string) {
      return fake.allowed.has(a.toLowerCase());
    },
    chainId: () => CHAIN_ID,
    async payees() {
      return {
        "payee-1": { address: "0x00000000000000000000000000000000000000a1", rail: "usdt", simulated: false },
        "payee-2": { address: "0x00000000000000000000000000000000000000a2", rail: "mpesa", simulated: true },
      };
    },
  };

  let clock = new Date("2026-11-12T10:00:00Z");
  const policyStore = openPolicyStore(":memory:", basePolicy);
  const approvals = openApprovalStore(":memory:");
  const decisions = openDecisionStore(":memory:");

  const service = createService({
    policyStore,
    audit,
    decisions,
    approvals,
    chain,
    chainWriter,
    signer: policySigner,
    operatorAddress: operator.address,
    escrow: { chainId: CHAIN_ID, address: ESCROW },
    now: () => clock,
    ...overrides,
  });

  return {
    service,
    policySigner,
    operator,
    audit,
    chainWriter,
    fake,
    policyStore,
    approvals,
    setClock(d: Date) {
      clock = d;
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;

export function submit(h: Harness, proposal: unknown = goodProposal(), trace_id = "trace-1") {
  return h.service.submitProposal({ proposal, trace_id });
}

export function signPolicy(wallet: { signTypedData: Wallet["signTypedData"] }, version: number, doc: Policy): Promise<string> {
  return wallet.signTypedData(policyDomain, policyDocumentTypes, policyDocumentValue(version, doc));
}

export function signApproval(wallet: { signTypedData: Wallet["signTypedData"] }, approvalId: string, decision: string, proposalHashHex: string): Promise<string> {
  return wallet.signTypedData(policyDomain, approvalDecisionTypes, approvalDecisionValue(approvalId, decision, proposalHashHex));
}

// A proposal that escalates (needs_human) but breaks no rejecting rule.
export function escalatingProposal(): Record<string, unknown> {
  return { ...goodProposal(), needs_human: true };
}
