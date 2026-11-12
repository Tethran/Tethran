// Scripted proof of the chain part of the slice, through ChainClient only:
//   fund escrow -> client approves -> release to the provider's vault -> operator sets limits and a payee
//   -> agent signer and Policy signer co-sign one payout -> vault pays -> an over-limit payout is blocked.
// Usage: CHAIN=localhost npm run prove:slice
// TEST NETWORKS ONLY. What is simulated here, and why:
//   - The payee is the ARBITER test address standing in for a simulated rail wallet.
//   - The two co-signatures are made in this script with the AGENT_SIGNER and POLICY_SIGNER test keys.
//     In the product the Policy Service signs only after its rule engine approves a proposal, and the agent
//     signer module signs separately. No rule engine and no agent run here.
//   - The operator signature is made with the OPERATOR test key, standing in for the provider's wallet.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { config as loadEnv } from "dotenv";
import {
  EvmChainClient, InMemoryIdempotencyStore, VAULT_TYPES, assertMilestoneMatches, loadChain, newProvider,
  safeErrorMessage, vaultActionId,
} from "../src";

loadEnv({ path: resolve(__dirname, "../../../.env"), quiet: true });

function wallet(role: string): Wallet {
  const pk = process.env[`${role}_PRIVATE_KEY`];
  if (!pk) throw new Error(`${role}_PRIVATE_KEY is not set (run: cd contracts && npm run wallets)`);
  return new Wallet(pk);
}
const usdt = (n: number) => (BigInt(n) * 1_000_000n).toString();

async function main() {
  const chain = loadChain();
  const chainsFile = JSON.parse(readFileSync(resolve(__dirname, "../../../config/chains.json"), "utf8"));
  const vault: string | undefined = chainsFile.chains[chain.key].demoVault;
  if (!vault) throw new Error(`no demoVault for "${chain.key}": run contracts/scripts/deploy-vault.ts first`);

  const provider = newProvider(chain);
  const store = new InMemoryIdempotencyStore();
  const treasuryWallet = wallet("TREASURY").connect(provider);
  const clientWallet = wallet("CLIENT").connect(provider);
  const treasury = new EvmChainClient(chain, treasuryWallet, store, { provider });
  const client = new EvmChainClient(chain, clientWallet, store, { provider });
  const operator = wallet("OPERATOR");
  const agentSigner = wallet("AGENT_SIGNER");
  const policySigner = wallet("POLICY_SIGNER");
  const payee = wallet("ARBITER").address; // stand-in for a simulated rail wallet

  const milestoneId = randomUUID();
  const run = `slice:${milestoneId}`;
  const say = (label: string, text: string) => console.log(`${label.padEnd(16)} ${text}`);
  const done = async (label: string, tx: { txHash: string }) => {
    await treasury.waitConfirmed(tx.txHash);
    say(label, tx.txHash);
  };

  console.log(`Chain: ${chain.name} (${chain.chainId})  milestone ${milestoneId}  vault ${vault}`);
  const before = await treasury.vaultState(vault);
  const payeeBefore = BigInt(await treasury.balance(payee));

  // 1. escrow: fund, verify, approve, release into the vault
  const request = {
    milestoneId, client: clientWallet.address, provider: wallet("PROVIDER").address, arbiter: wallet("ARBITER").address,
    vault, amount: usdt(100), timeout: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, cardFunded: false, holdSeconds: 0,
  };
  await done("mint (test)", await treasury.mintTestUsdt(treasuryWallet.address, request.amount, `${run}:mint`));
  await done("createAndFund", await treasury.createAndFund(request, `${run}:fund`));
  assertMilestoneMatches(await treasury.milestone(milestoneId), { ...request, funder: treasuryWallet.address });
  say("verified", "on-chain milestone matches the request");
  await done("approve", await client.approve(milestoneId, `${run}:approve`));
  await done("release", await treasury.release(milestoneId, `${run}:release`));

  // 2. operator: limits and one payee (two signatures, relayed by the treasury)
  const domain = treasury.vaultDomain(vault);
  let version = before.policyVersion + 1;
  const policy = { version, perTxCap: usdt(60), dailyCap: (BigInt(before.spentToday) + BigInt(usdt(60))).toString(), minReserve: "0" };
  await done("setPolicy", await treasury.setPolicy({
    vault, ...policy, operatorSig: await operator.signTypedData(domain, { SetPolicy: [...VAULT_TYPES.SetPolicy] }, policy),
  }, `${run}:policy`));
  version++;
  const payees = { version, payees: [payee], allowed: true };
  await done("setPayees", await treasury.setPayees({
    vault, ...payees, operatorSig: await operator.signTypedData(domain, { SetPayees: [...VAULT_TYPES.SetPayees] }, payees),
  }, `${run}:payees`));

  // 3. one payout of 40, co-signed by both signers, valid for 15 minutes
  const proposalHash = keccak256(toUtf8Bytes(`demo proposal for ${milestoneId}`)); // stand-in for a real proposal hash
  const cosign = async (index: number, amount: string) => {
    const t = { to: payee, amount, proposalHash, actionId: vaultActionId(proposalHash, index), deadline: Math.floor(Date.now() / 1000) + 900 };
    const types = { Transfer: [...VAULT_TYPES.Transfer] };
    return { vault, ...t, agentSig: await agentSigner.signTypedData(domain, types, t), policySig: await policySigner.signTypedData(domain, types, t) };
  };
  const check = await treasury.vaultCheck(vault, payee, usdt(40));
  if (!check.ok) throw new Error(`the vault would block the payout: ${check.reason}`);
  await done("vaultExecute", await treasury.vaultExecute(await cosign(0, usdt(40)), `${run}:pay:0`));

  // 4. an over-limit payout: both signatures are valid, the vault still refuses it
  const over = await treasury.vaultCheck(vault, payee, usdt(61));
  const blocked = await treasury.vaultExecute(await cosign(1, usdt(61)), `${run}:pay:1`).then(() => false, () => true);
  if (over.ok || !blocked) throw new Error("the over-limit payout was not blocked");
  say("over the limit", `blocked by the vault: ${over.reason}`);

  const after = await treasury.vaultState(vault);
  const paid = BigInt(await treasury.balance(payee)) - payeeBefore;
  const vaultGain = BigInt(after.balance) - BigInt(before.balance);
  if (paid !== BigInt(usdt(40)) || vaultGain !== BigInt(usdt(60))) {
    throw new Error(`proof failed: payee received ${paid}, vault balance changed by ${vaultGain}`);
  }
  console.log("PASS: 100 tUSDT released into the vault, 40 paid to the payee, 60 left in the vault, 61 refused (test token)");
}

main().catch((e) => { console.error(`FAILED: ${safeErrorMessage(e)}`); process.exit(1); });
