import { resolve } from "node:path";
import { Wallet, isAddress } from "ethers";
import { config as loadEnv } from "dotenv";
import { EvmChainClient, InMemoryIdempotencyStore, loadChain, newProvider } from "../../chain/src/index";
import { createChainReader } from "./chainReader";
import { openAuditLog } from "./audit";
import { createHttpServer, listen } from "./http";
import { createService, stubChainWriter } from "./service";
import { openApprovalStore, openDecisionStore, openPolicyStore } from "./stores";
import type { Policy } from "./types";

// Starts the Policy Service. Config comes from environment variables only.
//   POLICY_SIGNER_PRIVATE_KEY  the Policy Service signer (test key). Read once, never printed.
//   OPERATOR_ADDRESS           the operator's ADDRESS (never the operator's key)
//   CHAIN                      which entry of config/chains.json (escrow address and chain id come from there)
//   BACKEND_URL, INTERNAL_TOKEN where payees and identity results are read from
//   POLICY_DATA_DIR (default "."), PORT (default 8787), HOST (default 127.0.0.1)

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error("missing environment variable " + name);
  return v;
}

loadEnv({ path: resolve(__dirname, "../../../.env"), quiet: true });

// Read-only chain access through ChainClient. The Policy Service sends no transactions: its sender refuses.
const chainCfg = loadChain();
const provider = newProvider(chainCfg);
const readOnlySender = {
  getAddress: async () => "0x0000000000000000000000000000000000000000",
  sendTransaction: async () => { throw new Error("the Policy Service does not send transactions"); },
};
const chainClient = new EvmChainClient(chainCfg, readOnlySender, new InMemoryIdempotencyStore(), { provider });
const chainReader = createChainReader({ chain: chainClient, backendUrl: need("BACKEND_URL"), internalToken: need("INTERNAL_TOKEN") });

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
const escrowAddress = chainCfg.escrow;
if (!isAddress(operatorAddress) || !isAddress(escrowAddress)) throw new Error("OPERATOR_ADDRESS and ESCROW_ADDRESS must be addresses");
const dir = process.env.POLICY_DATA_DIR ?? ".";

const service = createService({
  policyStore: openPolicyStore(`${dir}/policy.sqlite`, initialPolicy),
  audit: openAuditLog(`${dir}/audit.sqlite`),
  decisions: openDecisionStore(`${dir}/decisions.sqlite`),
  approvals: openApprovalStore(`${dir}/approvals.sqlite`),
  chain: chainReader,
  // NOT WIRED YET: relaying vault-format operator signatures for on-chain limits (INTERFACES 2b) comes with the
  // operator console block. Until then on-chain limits are set by the seed script with operator signatures.
  chainWriter: stubChainWriter(),
  signer: new Wallet(need("POLICY_SIGNER_PRIVATE_KEY")),
  operatorAddress,
  escrow: { chainId: chainCfg.chainId, address: escrowAddress },
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
