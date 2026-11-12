import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { MAX_PAYEES_PER_ACTION, MAX_VAULT_ACTIONS, parseVaultActions } from "../src/vaultActions";

const sig = "0x" + "11".repeat(65);
const policyAction = (version: number) => ({ type: "setPolicy", version, perTxCap: "1", dailyCap: "1", minReserve: "0", operator_signature: sig });
const addrs = (n: number) => Array.from({ length: n }, () => Wallet.createRandom().address);

test("vault actions: at most 10 per request", () => {
  assert.equal(parseVaultActions(Array.from({ length: MAX_VAULT_ACTIONS }, (_, i) => policyAction(i + 1))).length, MAX_VAULT_ACTIONS);
  assert.throws(() => parseVaultActions(Array.from({ length: MAX_VAULT_ACTIONS + 1 }, (_, i) => policyAction(i + 1))), /at most 10 vault actions/);
});

test("vault actions: at most 50 payees per setPayees action", () => {
  const ok = parseVaultActions([{ type: "setPayees", version: 1, payees: addrs(MAX_PAYEES_PER_ACTION), allowed: true, operator_signature: sig }]);
  assert.equal((ok[0] as { payees: string[] }).payees.length, 50);
  assert.throws(() => parseVaultActions([{ type: "setPayees", version: 1, payees: addrs(MAX_PAYEES_PER_ACTION + 1), allowed: true, operator_signature: sig }]), /at most 50 payees/);
});
