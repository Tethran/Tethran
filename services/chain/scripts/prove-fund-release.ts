// Scripted proof of the first slice, through ChainClient only:
//   mint test USDT -> createAndFund -> approve (client) -> release (treasury as RELEASER)
// Usage: CHAIN=localhost npm run prove      (chains: see config/chains.json)
// TEST NETWORKS ONLY. The "vault" here is the provider's own address: the vault contract is not built yet.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { config as loadEnv } from "dotenv";
import { EvmChainClient, InMemoryIdempotencyStore, loadChain } from "../src";

loadEnv({ path: resolve(__dirname, "../../../.env"), quiet: true });

function key(role: string): string {
  const pk = process.env[`${role}_PRIVATE_KEY`];
  if (!pk) throw new Error(`${role}_PRIVATE_KEY is not set (run: cd contracts && npm run wallets)`);
  return pk;
}

async function main() {
  const chain = loadChain();
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  const store = new InMemoryIdempotencyStore();
  const treasuryWallet = new Wallet(key("TREASURY"), provider);
  const clientWallet = new Wallet(key("CLIENT"), provider);
  const treasury = new EvmChainClient(chain, new NonceManager(treasuryWallet), store, provider);
  const client = new EvmChainClient(chain, new NonceManager(clientWallet), store, provider);

  const providerAddr = new Wallet(key("PROVIDER")).address;
  const arbiterAddr = new Wallet(key("ARBITER")).address;
  const vault = providerAddr; // stand-in until the vault contract exists
  const milestoneId = randomUUID();
  const amount = "5000000"; // 5 USDT
  const run = `prove:${milestoneId}`;
  const step = async (label: string, tx: { txHash: string }) => {
    await treasury.waitConfirmed(tx.txHash);
    console.log(`${label.padEnd(14)} ${tx.txHash}  state=${await treasury.escrowState(milestoneId)}`);
  };

  console.log(`Chain: ${chain.name} (${chain.chainId})  milestone ${milestoneId}`);
  const vaultBefore = BigInt(await treasury.balance(vault));

  await step("mint (test)", await treasury.mintTestUsdt(treasuryWallet.address, amount, `${run}:mint`));
  const fundTx = await treasury.createAndFund(
    {
      milestoneId, client: clientWallet.address, provider: providerAddr, arbiter: arbiterAddr, vault,
      amount, timeout: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, cardFunded: false, holdSeconds: 0,
    },
    `${run}:fund`,
  );
  await step("createAndFund", fundTx);

  // Same idempotency key again: must return the same transaction and send nothing.
  const again = await treasury.createAndFund(
    {
      milestoneId, client: clientWallet.address, provider: providerAddr, arbiter: arbiterAddr, vault,
      amount, timeout: 0, cardFunded: false, holdSeconds: 0,
    },
    `${run}:fund`,
  );
  if (again.txHash !== fundTx.txHash) throw new Error("idempotency check failed: a second transaction was sent");
  console.log("repeat key     returned the same transaction (no second send)");

  await step("approve", await client.approve(milestoneId, `${run}:approve`));
  await step("release", await treasury.release(milestoneId, `${run}:release`));

  const received = BigInt(await treasury.balance(vault)) - vaultBefore;
  const state = await treasury.escrowState(milestoneId);
  if (state !== "Released" || received !== BigInt(amount)) {
    throw new Error(`proof failed: state=${state}, vault received ${received}`);
  }
  console.log(`PASS: escrow Released, vault stand-in received ${received} base units (5 tUSDT, test token)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
