import { Wallet, isAddress } from "ethers";
import { openAuditLog } from "./audit";
import { createHttpServer, listen } from "./http";
import { createService, stubChainWriter, type ChainReader } from "./service";
import { openApprovalStore, openDecisionStore, openPolicyStore } from "./stores";
import type { Policy } from "./types";

// Starts the Policy Service. Config comes from environment variables only.
//   POLICY_SIGNER_PRIVATE_KEY  the Policy Service signer (test key). Read once, never printed.
//   OPERATOR_ADDRESS           the operator's ADDRESS (never the operator's key)
//   ESCROW_ADDRESS, CHAIN_ID   for attestation verification
//   POLICY_DATA_DIR (default "."), PORT (default 8787), HOST (default 127.0.0.1)

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error("missing environment variable " + name);
  return v;
}

// NOT WIRED YET: no chain access in this build. Every read fails, so proposals error out instead of being guessed.
const chainReaderStub: ChainReader = {
  async vaultFor() {
    throw new Error("chain reader not wired yet");
  },
  async vaultState() {
    throw new Error("chain reader not wired yet");
  },
  async milestoneFacts() {
    throw new Error("chain reader not wired yet");
  },
  async payees() {
    throw new Error("chain reader not wired yet");
  },
};

// Nothing can be paid until the operator signs a real policy: all limits 0, empty allowlist.
const initialPolicy: Policy = {
  version: 1,
  per_tx_cap: "0",
  per_tx_soft_limit: "0",
  daily_cap: "0",
  vault_min_reserve: "0",
  payee_allowlist: [],
  min_tax_reserve_bps: 0,
  confidence_threshold: 0.7,
  chargeback_hold_seconds: 0,
};

const operatorAddress = need("OPERATOR_ADDRESS");
const escrowAddress = need("ESCROW_ADDRESS");
if (!isAddress(operatorAddress) || !isAddress(escrowAddress)) throw new Error("OPERATOR_ADDRESS and ESCROW_ADDRESS must be addresses");
const dir = process.env.POLICY_DATA_DIR ?? ".";

const service = createService({
  policyStore: openPolicyStore(`${dir}/policy.sqlite`, initialPolicy),
  audit: openAuditLog(`${dir}/audit.sqlite`),
  decisions: openDecisionStore(`${dir}/decisions.sqlite`),
  approvals: openApprovalStore(`${dir}/approvals.sqlite`),
  chain: chainReaderStub,
  chainWriter: stubChainWriter(), // NOT WIRED YET: the on-chain limits are not written
  signer: new Wallet(need("POLICY_SIGNER_PRIVATE_KEY")),
  operatorAddress,
  escrow: { chainId: Number(need("CHAIN_ID")), address: escrowAddress },
  now: () => new Date(),
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
listen(createHttpServer(service), port, host).then(
  () => console.log(`policy service listening on ${host}:${port}`),
  (e) => {
    console.error("could not start:", (e as Error).message);
    process.exit(1);
  },
);
