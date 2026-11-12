// Scripted proof of the first slice, through ChainClient only:
//   mint test USDT -> createAndFund (treasury, FUNDER) -> verify the on-chain milestone
//   -> approve (client) -> release (treasury, RELEASER)
// Usage: CHAIN=localhost npm run prove      (chains: see config/chains.json)
// TEST NETWORKS ONLY. The "vault" here is the provider's own address: the vault contract is not built yet.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { config as loadEnv } from "dotenv";
import {
  EvmChainClient, IdempotencyKeyReuseError, InMemoryIdempotencyStore, assertMilestoneMatches, loadChain,
  newProvider, safeErrorMessage,
} from "../src";

loadEnv({ path: resolve(__dirname, "../../../.env"), quiet: true });

function key(role: string): string {
  const pk = process.env[`${role}_PRIVATE_KEY`];
  if (!pk) throw new Error(`${role}_PRIVATE_KEY is not set (run: cd contracts && npm run wallets)`);
  return pk;
}

async function main() {
  const chain = loadChain();
  const provider = newProvider(chain);
  const store = new InMemoryIdempotencyStore();
  const treasuryWallet = new Wallet(key("TREASURY"), provider);
  const clientWallet = new Wallet(key("CLIENT"), provider);
  const treasury = new EvmChainClient(chain, treasuryWallet, store, { provider });
  const client = new EvmChainClient(chain, clientWallet, store, { provider });

  const milestoneId = randomUUID();
  const providerAddr = new Wallet(key("PROVIDER")).address;
  const request = {
    milestoneId,
    client: clientWallet.address,
    provider: providerAddr,
    arbiter: new Wallet(key("ARBITER")).address,
    vault: providerAddr, // stand-in until the vault contract exists
    amount: "5000000", // 5 USDT
    timeout: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    cardFunded: false,
    holdSeconds: 0,
  };
  const run = `prove:${milestoneId}`;
  const step = async (label: string, tx: { txHash: string }) => {
    await treasury.waitConfirmed(tx.txHash);
    console.log(`${label.padEnd(14)} ${tx.txHash}  state=${(await treasury.milestone(milestoneId)).state}`);
  };

  console.log(`Chain: ${chain.name} (${chain.chainId})  milestone ${milestoneId}`);
  const vaultBefore = BigInt(await treasury.balance(request.vault));

  await step("mint (test)", await treasury.mintTestUsdt(treasuryWallet.address, request.amount, `${run}:mint`));
  const fundTx = await treasury.createAndFund(request, `${run}:fund`);
  await step("createAndFund", fundTx);

  // What the backend does after every funding: check the milestone on-chain is the one it asked for.
  assertMilestoneMatches(await treasury.milestone(milestoneId), { ...request, funder: treasuryWallet.address });
  console.log("verified       funder, parties, vault, amount, timeout and hold match the request");

  // Same key, same call: the first transaction comes back and nothing is sent.
  const again = await treasury.createAndFund(request, `${run}:fund`);
  if (again.txHash !== fundTx.txHash) throw new Error("idempotency check failed: a second transaction was sent");
  console.log("repeat key     returned the same transaction (no second send)");
  // Same key, different call: refused.
  const reused = await treasury.createAndFund({ ...request, amount: "1" }, `${run}:fund`).then(
    () => false, (e) => e instanceof IdempotencyKeyReuseError);
  if (!reused) throw new Error("idempotency check failed: a key was accepted for a different call");
  console.log("reused key     refused for a different call");

  await step("approve", await client.approve(milestoneId, `${run}:approve`));
  await step("release", await treasury.release(milestoneId, `${run}:release`));

  const received = BigInt(await treasury.balance(request.vault)) - vaultBefore;
  const { state } = await treasury.milestone(milestoneId);
  if (state !== "Released" || received !== BigInt(request.amount)) {
    throw new Error(`proof failed: state=${state}, vault received ${received}`);
  }
  console.log(`PASS: escrow Released, vault stand-in received ${received} base units (5 tUSDT, test token)`);
}

main().catch((e) => { console.error(`FAILED: ${safeErrorMessage(e)}`); process.exit(1); });
