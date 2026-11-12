import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const USDT = (n: number) => BigInt(n) * 1_000_000n;
const DAY = 24 * 3600;
const PER_TX = USDT(500);
const DAILY = USDT(1200);
const RESERVE = USDT(100);
const reason = (s: string) => ethers.encodeBytes32String(s);
const FAR = 2n ** 40n; // a deadline far in the future, for tests that are not about expiry

const TYPES = {
  Transfer: [
    { name: "to", type: "address" }, { name: "amount", type: "uint256" },
    { name: "proposalHash", type: "bytes32" }, { name: "actionId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  SetPolicy: [
    { name: "version", type: "uint256" }, { name: "perTxCap", type: "uint256" },
    { name: "dailyCap", type: "uint256" }, { name: "minReserve", type: "uint256" },
  ],
  SetPayees: [
    { name: "version", type: "uint256" }, { name: "payees", type: "address[]" }, { name: "allowed", type: "bool" },
  ],
  RotateSigners: [
    { name: "version", type: "uint256" }, { name: "agentSigner", type: "address" }, { name: "policySigner", type: "address" },
  ],
  Withdraw: [{ name: "version", type: "uint256" }, { name: "amount", type: "uint256" }],
};
const only = (name: keyof typeof TYPES) => ({ [name]: TYPES[name] });

describe("ProviderVault (two-signature vault with built-in spending guard)", () => {
  /** A vault holding 2000 USDT. `configured` (default) also sets the limits and allows payee1 and payee2. */
  async function setup(configured = true) {
    const [deployer, operator, agent, policy, provider, payee1, payee2, stranger, relayer] = await ethers.getSigners();
    const usdt = await ethers.deployContract("TestUSDT");
    const vault = await ethers.deployContract("ProviderVault", [
      await usdt.getAddress(), operator.address, agent.address, policy.address, provider.address,
    ]);
    const vaultAddr = await vault.getAddress();
    await usdt.mint(vaultAddr, USDT(2000));
    const domain = {
      name: "TethranVault", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: vaultAddr,
    };
    const proposalHash = ethers.id("proposal-1");
    const actionId = (i: number, p = proposalHash) =>
      ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [p, i]));

    type T = { to: string; amount: bigint; proposalHash: string; actionId: string; deadline?: bigint };
    const signTransfer = (who: HardhatEthersSigner, t: T, d: object = domain) =>
      who.signTypedData(d, only("Transfer"), { ...t, deadline: t.deadline ?? FAR });
    /** Submits a transfer with both honest signatures unless `over` replaces something. */
    const pay = async (
      to: string, amount: bigint, index: number,
      over: { agentSig?: string; policySig?: string; deadline?: bigint } = {},
    ) => {
      const t = { to, amount, proposalHash, actionId: actionId(index), deadline: over.deadline ?? FAR };
      return vault.connect(relayer).execute(
        t.to, t.amount, t.proposalHash, t.actionId, t.deadline,
        over.agentSig ?? await signTransfer(agent, t), over.policySig ?? await signTransfer(policy, t));
    };

    const next = async () => (await vault.policyVersion()) + 1n;
    const setPolicy = async (perTxCap: bigint, dailyCap: bigint, minReserve: bigint, by = operator, version?: bigint) => {
      const v = version ?? await next();
      const sig = await by.signTypedData(domain, only("SetPolicy"), { version: v, perTxCap, dailyCap, minReserve });
      return vault.connect(relayer).setPolicy(v, perTxCap, dailyCap, minReserve, sig);
    };
    const setPayees = async (payees: string[], allowed: boolean, by = operator, version?: bigint) => {
      const v = version ?? await next();
      const sig = await by.signTypedData(domain, only("SetPayees"), { version: v, payees, allowed });
      return vault.connect(relayer).setPayees(v, payees, allowed, sig);
    };
    const rotate = async (agentSigner: string, policySigner: string, by = operator, version?: bigint) => {
      const v = version ?? await next();
      const sig = await by.signTypedData(domain, only("RotateSigners"), { version: v, agentSigner, policySigner });
      return vault.connect(relayer).rotateSigners(v, agentSigner, policySigner, sig);
    };
    const withdraw = async (amount: bigint, by = operator, version?: bigint) => {
      const v = version ?? await next();
      const sig = await by.signTypedData(domain, only("Withdraw"), { version: v, amount });
      return vault.connect(relayer).withdrawToProvider(v, amount, sig);
    };

    if (configured) {
      await setPolicy(PER_TX, DAILY, RESERVE);
      await setPayees([payee1.address, payee2.address], true);
    }
    return {
      deployer, operator, agent, policy, provider, payee1, payee2, stranger, relayer, usdt, vault, vaultAddr, domain,
      proposalHash, actionId, signTransfer, pay, setPolicy, setPayees, rotate, withdraw,
    };
  }

  describe("constructor", () => {
    it("stores the keys and the payout address; starts at version 0 with all limits 0", async () => {
      const { operator, agent, policy, provider, usdt, vault } = await setup(false);
      expect([await vault.usdt(), await vault.operator(), await vault.agentSigner(), await vault.policySigner(),
        await vault.providerPayout()]).to.deep.equal(
        [await usdt.getAddress(), operator.address, agent.address, policy.address, provider.address]);
      expect([await vault.policyVersion(), await vault.perTxCap(), await vault.dailyCap(), await vault.minReserve()])
        .to.deep.equal([0n, 0n, 0n, 0n]);
    });

    it("rejects zero addresses, overlapping keys and an unusable payout address", async () => {
      const [a, b, c, d] = await ethers.getSigners();
      const usdt = await ethers.deployContract("TestUSDT");
      const t = await usdt.getAddress();
      const f = await ethers.getContractFactory("ProviderVault");
      const Z = ethers.ZeroAddress;
      for (const args of [[Z, a.address, b.address, c.address, d.address], [t, Z, b.address, c.address, d.address],
        [t, a.address, Z, c.address, d.address], [t, a.address, b.address, Z, d.address],
        [t, a.address, b.address, c.address, Z]] as const) {
        await expect(f.deploy(...args)).to.be.revertedWithCustomError(f, "ZeroAddress");
      }
      // agent == policy, agent == operator, policy == operator
      for (const args of [[t, a.address, b.address, b.address, d.address], [t, a.address, a.address, c.address, d.address],
        [t, a.address, b.address, a.address, d.address]] as const) {
        await expect(f.deploy(...args)).to.be.revertedWithCustomError(f, "KeysNotDistinct");
      }
      await expect(f.deploy(t, a.address, b.address, c.address, t)).to.be.revertedWithCustomError(f, "InvalidAddress");
    });
  });

  describe("execute", () => {
    it("pays with two valid signatures; anyone can submit; the action id is consumed", async () => {
      const { payee1, usdt, vault, proposalHash, actionId, pay } = await setup();
      await expect(pay(payee1.address, USDT(300), 0))
        .to.emit(vault, "Executed").withArgs(actionId(0), proposalHash, payee1.address, USDT(300));
      expect(await usdt.balanceOf(payee1.address)).to.equal(USDT(300));
      expect(await vault.spentToday()).to.equal(USDT(300));
      expect(await vault.actionUsed(actionId(0))).to.equal(true);
    });

    it("a new vault pays nothing until the operator sets a policy and payees", async () => {
      const { payee1, vault, pay, setPolicy, setPayees } = await setup(false);
      await expect(pay(payee1.address, 1n, 0))
        .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("PAYEE_NOT_ALLOWED"));
      await setPayees([payee1.address], true);
      await expect(pay(payee1.address, 1n, 0))
        .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("OVER_PER_TX_CAP"));
      await setPolicy(USDT(10), USDT(10), 0n);
      await pay(payee1.address, 1n, 0);
    });

    it("the same action cannot be paid twice, even with fresh signatures", async () => {
      const { payee1, usdt, vault, pay } = await setup();
      await pay(payee1.address, USDT(100), 0);
      await expect(pay(payee1.address, USDT(100), 0)).to.be.revertedWithCustomError(vault, "ActionAlreadyUsed");
      expect(await usdt.balanceOf(payee1.address)).to.equal(USDT(100));
      await pay(payee1.address, USDT(100), 1); // a different action of the same proposal is fine
    });

    it("actions of one proposal can land in any order", async () => {
      const { payee1, payee2, usdt, pay } = await setup();
      await pay(payee2.address, USDT(50), 2);
      await pay(payee1.address, USDT(70), 0);
      await pay(payee1.address, USDT(30), 1);
      expect(await usdt.balanceOf(payee1.address)).to.equal(USDT(100));
      expect(await usdt.balanceOf(payee2.address)).to.equal(USDT(50));
    });

    it("rejects a zero amount", async () => {
      const { payee1, vault, pay } = await setup();
      await expect(pay(payee1.address, 0n, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    describe("deadline", () => {
      it("works up to and including the deadline second, and is refused one second later", async () => {
        const { payee1, usdt, vault, pay } = await setup();
        const deadline = BigInt(await time.latest()) + 900n; // 15 minutes, as the Policy Service sets it
        await time.setNextBlockTimestamp(deadline);
        await pay(payee1.address, USDT(10), 0, { deadline });
        await time.setNextBlockTimestamp(deadline + 1n);
        await expect(pay(payee1.address, USDT(10), 1, { deadline }))
          .to.be.revertedWithCustomError(vault, "Expired").withArgs(deadline);
        expect(await usdt.balanceOf(payee1.address)).to.equal(USDT(10));
      });

      it("the deadline is part of what is signed: it cannot be pushed out by the submitter", async () => {
        const { agent, policy, payee1, vault, relayer, proposalHash, actionId, signTransfer } = await setup();
        const deadline = BigInt(await time.latest()) + 900n;
        const t = { to: payee1.address, amount: USDT(10), proposalHash, actionId: actionId(0), deadline };
        const sigs = [await signTransfer(agent, t), await signTransfer(policy, t)];
        await time.increaseTo(deadline + 1n);
        await expect(vault.connect(relayer).execute(t.to, t.amount, t.proposalHash, t.actionId, deadline, sigs[0], sigs[1]))
          .to.be.revertedWithCustomError(vault, "Expired");
        await expect(vault.connect(relayer).execute(t.to, t.amount, t.proposalHash, t.actionId, deadline + 3600n, sigs[0], sigs[1]))
          .to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
      });

      it("an expired transfer does not consume its action id", async () => {
        const { payee1, vault, actionId, pay } = await setup();
        const deadline = BigInt(await time.latest()) - 1n;
        await expect(pay(payee1.address, USDT(10), 0, { deadline })).to.be.revertedWithCustomError(vault, "Expired");
        expect(await vault.actionUsed(actionId(0))).to.equal(false);
        await pay(payee1.address, USDT(10), 0); // a fresh approval for the same action still works
      });
    });

    describe("needs both co-signers", () => {
      it("one key signing both slots is not enough (agent twice, policy twice)", async () => {
        const { agent, policy, payee1, vault, proposalHash, actionId, signTransfer, pay } = await setup();
        const t = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
        await expect(pay(t.to, t.amount, 0, { policySig: await signTransfer(agent, t) }))
          .to.be.revertedWithCustomError(vault, "InvalidPolicySignature");
        await expect(pay(t.to, t.amount, 0, { agentSig: await signTransfer(policy, t) }))
          .to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
      });

      it("the two signatures in swapped slots are rejected", async () => {
        const { agent, policy, payee1, vault, proposalHash, actionId, signTransfer, pay } = await setup();
        const t = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
        await expect(pay(t.to, t.amount, 0, {
          agentSig: await signTransfer(policy, t), policySig: await signTransfer(agent, t),
        })).to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
      });

      it("the operator, a stranger or the provider cannot stand in for a co-signer", async () => {
        const { operator, stranger, provider, payee1, vault, proposalHash, actionId, signTransfer, pay } = await setup();
        const t = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
        for (const who of [operator, stranger, provider]) {
          await expect(pay(t.to, t.amount, 0, { agentSig: await signTransfer(who, t) }))
            .to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
          await expect(pay(t.to, t.amount, 0, { policySig: await signTransfer(who, t) }))
            .to.be.revertedWithCustomError(vault, "InvalidPolicySignature");
        }
      });

      it("a signature for a different recipient, amount, proposal or action is rejected", async () => {
        const { policy, payee1, payee2, vault, proposalHash, actionId, signTransfer, pay } = await setup();
        const honest = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
        // the Policy Service approved `honest`; someone submits something else with that signature
        for (const signed of [
          { ...honest, to: payee2.address },
          { ...honest, amount: USDT(2) },
          { ...honest, proposalHash: ethers.id("other proposal") },
          { ...honest, actionId: actionId(1) },
          { ...honest, deadline: FAR + 1n },
        ]) {
          await expect(pay(honest.to, honest.amount, 0, { policySig: await signTransfer(policy, signed) }))
            .to.be.revertedWithCustomError(vault, "InvalidPolicySignature");
        }
      });

      it("signatures made for another vault or another chain are rejected", async () => {
        const { agent, policy, payee1, usdt, operator, provider, vault, domain, proposalHash, actionId, signTransfer, pay } = await setup();
        const other = await ethers.deployContract("ProviderVault", [
          await usdt.getAddress(), operator.address, agent.address, policy.address, provider.address,
        ]);
        const t = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
        for (const d of [{ ...domain, verifyingContract: await other.getAddress() }, { ...domain, chainId: 84532 }]) {
          await expect(pay(t.to, t.amount, 0, {
            agentSig: await signTransfer(agent, t, d), policySig: await signTransfer(policy, t, d),
          })).to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
        }
      });

      it("a malformed signature reverts and moves nothing", async () => {
        const { payee1, usdt, vault, pay } = await setup();
        await expect(pay(payee1.address, USDT(1), 0, { agentSig: "0x1234" })).to.be.reverted;
        expect(await usdt.balanceOf(payee1.address)).to.equal(0n);
        expect(await vault.spentToday()).to.equal(0n);
      });
    });

    describe("guard: limits hold even with both signatures", () => {
      it("payee allowlist", async () => {
        const { stranger, vault, pay } = await setup();
        await expect(pay(stranger.address, USDT(1), 0))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("PAYEE_NOT_ALLOWED"));
        expect(await vault.check(stranger.address, USDT(1))).to.deep.equal([false, reason("PAYEE_NOT_ALLOWED")]);
      });

      it("per-transaction cap (exact boundary)", async () => {
        const { payee1, vault, pay } = await setup();
        await expect(pay(payee1.address, PER_TX + 1n, 0))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("OVER_PER_TX_CAP"));
        expect(await vault.check(payee1.address, PER_TX)).to.deep.equal([true, ethers.ZeroHash]);
        await pay(payee1.address, PER_TX, 0);
      });

      it("daily cap adds up across transfers and payees (exact boundary)", async () => {
        const { payee1, payee2, vault, pay } = await setup();
        await pay(payee1.address, USDT(500), 0);
        await pay(payee2.address, USDT(500), 1);
        expect(await vault.check(payee1.address, USDT(200))).to.deep.equal([true, ethers.ZeroHash]);
        await expect(pay(payee1.address, USDT(200) + 1n, 2))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("OVER_DAILY_CAP"));
        await pay(payee1.address, USDT(200), 2);
        expect(await vault.spentToday()).to.equal(DAILY);
        await expect(pay(payee1.address, 1n, 3))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("OVER_DAILY_CAP"));
      });

      it("the daily cap resets at UTC midnight, not 24 hours after a transfer", async () => {
        const { payee1, vault, pay, setPolicy } = await setup();
        await setPolicy(PER_TX, USDT(500), 0n);
        const midnight = (Math.floor((await time.latest()) / DAY) + 2) * DAY;
        await time.setNextBlockTimestamp(midnight - 1); // 23:59:59 UTC
        await pay(payee1.address, USDT(500), 0);
        expect(await vault.spentToday()).to.equal(USDT(500));
        await time.setNextBlockTimestamp(midnight); // 00:00:00 UTC, one second later
        await pay(payee1.address, USDT(500), 1);
        expect(await vault.spentToday()).to.equal(USDT(500));
        expect(await vault.spentOnDay(midnight / DAY - 1)).to.equal(USDT(500));
      });

      it("balance floor (exact boundary), and it follows the balance after a top-up", async () => {
        const { payee1, usdt, vault, vaultAddr, pay, setPolicy } = await setup();
        await setPolicy(USDT(5000), USDT(5000), RESERVE); // caps out of the way; vault holds 2000, floor 100
        await expect(pay(payee1.address, USDT(1900) + 1n, 0))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("BELOW_VAULT_RESERVE"));
        await pay(payee1.address, USDT(1900), 0);
        expect(await usdt.balanceOf(vaultAddr)).to.equal(RESERVE);
        await expect(pay(payee1.address, 1n, 1))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("BELOW_VAULT_RESERVE"));
        await usdt.mint(vaultAddr, USDT(50)); // another milestone is released into the vault
        await pay(payee1.address, USDT(50), 1);
      });

      it("more than the balance is blocked by the floor check, not by an underflow", async () => {
        const { payee1, vault, pay, setPolicy } = await setup();
        await setPolicy(USDT(5000), USDT(5000), 0n);
        await expect(pay(payee1.address, USDT(2000) + 1n, 0))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("BELOW_VAULT_RESERVE"));
        expect(await vault.check(payee1.address, USDT(2000) + 1n)).to.deep.equal([false, reason("BELOW_VAULT_RESERVE")]);
      });

      it("check() gives exactly the verdict execute() enforces, for every guard case", async () => {
        const { payee1, payee2, stranger, vault, pay, setPolicy } = await setup();
        await setPolicy(PER_TX, DAILY, USDT(1500)); // vault holds 2000, so only 500 may leave
        await pay(payee2.address, USDT(100), 99); // some spend today, so the daily sum is not trivial
        const cases: [string, string, bigint][] = [
          ["allowed, small", payee1.address, USDT(1)],
          ["not on the allowlist", stranger.address, USDT(1)],
          ["at the per-tx cap but over the reserve", payee1.address, PER_TX],
          ["over the per-tx cap", payee1.address, PER_TX + 1n],
          ["exactly what the reserve allows", payee1.address, USDT(400)],
          ["one unit over the reserve", payee1.address, USDT(400) + 1n],
          ["more than the balance", payee1.address, USDT(5000)],
        ];
        let index = 0;
        for (const [label, to, amount] of cases) {
          const snapshot = await ethers.provider.send("evm_snapshot", []);
          const [ok, why] = await vault.check(to, amount);
          if (ok) {
            await pay(to, amount, index);
          } else {
            await expect(pay(to, amount, index), label)
              .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(why);
          }
          await ethers.provider.send("evm_revert", [snapshot]);
          index++;
        }
        // and the daily cap case, which needs more balance than the reserve case allows
        await setPolicy(PER_TX, USDT(300), 0n);
        expect(await vault.check(payee1.address, USDT(200))).to.deep.equal([true, ethers.ZeroHash]);
        expect(await vault.check(payee1.address, USDT(200) + 1n)).to.deep.equal([false, reason("OVER_DAILY_CAP")]);
        await expect(pay(payee1.address, USDT(200) + 1n, 50))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("OVER_DAILY_CAP"));
        await pay(payee1.address, USDT(200), 50);
      });

      it("a blocked transfer does not consume its action id or count towards the day", async () => {
        const { payee1, vault, actionId, pay } = await setup();
        await expect(pay(payee1.address, PER_TX + 1n, 0)).to.be.revertedWithCustomError(vault, "GuardBlocked");
        expect(await vault.actionUsed(actionId(0))).to.equal(false);
        expect(await vault.spentToday()).to.equal(0n);
      });

      it("a payee removed after the co-signatures were made can no longer be paid", async () => {
        const { agent, policy, payee1, vault, proposalHash, actionId, signTransfer, pay, setPayees } = await setup();
        const t = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
        const sigs = { agentSig: await signTransfer(agent, t), policySig: await signTransfer(policy, t) };
        await setPayees([payee1.address], false);
        await expect(pay(t.to, t.amount, 0, sigs))
          .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("PAYEE_NOT_ALLOWED"));
      });
    });
  });

  describe("operator: policy and payees", () => {
    it("an operator-signed policy takes effect at once; anyone can submit it", async () => {
      const { vault, setPolicy } = await setup(false);
      await expect(setPolicy(1n, 2n, 3n)).to.emit(vault, "PolicyUpdated").withArgs(1n, 1n, 2n, 3n);
      expect([await vault.policyVersion(), await vault.perTxCap(), await vault.dailyCap(), await vault.minReserve()])
        .to.deep.equal([1n, 1n, 2n, 3n]);
    });

    it("payees can be added and removed in batches", async () => {
      const { payee1, payee2, stranger, vault, setPayees } = await setup(false);
      await expect(setPayees([payee1.address, payee2.address], true))
        .to.emit(vault, "PayeesSet").withArgs(1n, [payee1.address, payee2.address], true);
      expect([await vault.allowedPayee(payee1.address), await vault.allowedPayee(payee2.address),
        await vault.allowedPayee(stranger.address)]).to.deep.equal([true, true, false]);
      await setPayees([payee1.address], false);
      expect(await vault.allowedPayee(payee1.address)).to.equal(false);
      expect(await vault.allowedPayee(payee2.address)).to.equal(true);
    });

    it("setPayees rejects the zero address, the vault itself and the token, and changes nothing", async () => {
      const { payee1, usdt, vault, vaultAddr, setPayees } = await setup();
      for (const bad of [ethers.ZeroAddress, vaultAddr, await usdt.getAddress()]) {
        await expect(setPayees([payee1.address, bad], true)).to.be.revertedWithCustomError(vault, "InvalidAddress");
        await expect(setPayees([bad], false)).to.be.revertedWithCustomError(vault, "InvalidAddress");
        expect(await vault.allowedPayee(bad)).to.equal(false);
      }
      expect(await vault.policyVersion()).to.equal(2n); // no version consumed by a rejected update
    });

    it("the payee list is hashed exactly as ethers encodes address[] typed data (0, 1 and 3 payees)", async () => {
      const { operator, relayer, payee1, payee2, stranger, vault, domain } = await setup(false);
      let version = 1n;
      for (const payees of [[], [payee1.address], [payee1.address, payee2.address, stranger.address]]) {
        const value = { version, payees, allowed: true };
        const sig = await operator.signTypedData(domain, only("SetPayees"), value);
        // the digest ethers signed, recovered independently, must be the operator: then the contract must agree
        const digest = ethers.TypedDataEncoder.hash(domain, only("SetPayees"), value);
        expect(ethers.recoverAddress(digest, sig)).to.equal(operator.address);
        await vault.connect(relayer).setPayees(version, payees, true, sig);
        version++;
      }
      expect(await vault.policyVersion()).to.equal(3n);
      expect(await vault.allowedPayee(stranger.address)).to.equal(true);
    });

    it("an operator signature made for another chain is rejected", async () => {
      const { operator, relayer, vault, domain } = await setup(false);
      const sig = await operator.signTypedData({ ...domain, chainId: 84532 }, only("SetPolicy"),
        { version: 1n, perTxCap: 1n, dailyCap: 1n, minReserve: 0n });
      await expect(vault.connect(relayer).setPolicy(1n, 1n, 1n, 0n, sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
    });

    it("the operator is effectively the owner: it can rotate signers, allow a payee, raise caps and pay anyone", async () => {
      // This is by design and is documented. The limits protect against the co-signers, not the operator.
      const { stranger, usdt, vault, relayer, proposalHash, actionId, signTransfer, setPolicy, setPayees, rotate } = await setup();
      const [, , , , , , , , , , , mine1, mine2] = await ethers.getSigners(); // two keys the operator controls
      await rotate(mine1.address, mine2.address);
      await setPayees([stranger.address], true);
      await setPolicy(USDT(2000), USDT(2000), 0n);
      const t = { to: stranger.address, amount: USDT(2000), proposalHash, actionId: actionId(0) };
      await vault.connect(relayer).execute(
        t.to, t.amount, t.proposalHash, t.actionId, FAR, await signTransfer(mine1, t), await signTransfer(mine2, t));
      expect(await usdt.balanceOf(stranger.address)).to.equal(USDT(2000));
    });

    it("pause: setPolicy with zero caps stops every payout until the operator sets limits again", async () => {
      const { payee1, vault, pay, setPolicy } = await setup();
      await setPolicy(0n, 0n, 0n);
      await expect(pay(payee1.address, 1n, 0))
        .to.be.revertedWithCustomError(vault, "GuardBlocked").withArgs(reason("OVER_PER_TX_CAP"));
      await setPolicy(PER_TX, DAILY, 0n);
      await pay(payee1.address, 1n, 0);
    });

    it("nobody but the operator can sign: agent, policy signer, provider, stranger, or both co-signers", async () => {
      const { agent, policy, provider, stranger, vault, setPolicy, setPayees, rotate, withdraw } = await setup();
      for (const who of [agent, policy, provider, stranger]) {
        await expect(setPolicy(USDT(9999), USDT(9999), 0n, who))
          .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
        await expect(setPayees([stranger.address], true, who))
          .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
        await expect(rotate(stranger.address, provider.address, who))
          .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
        await expect(withdraw(USDT(1), who)).to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      }
      expect(await vault.perTxCap()).to.equal(PER_TX);
    });

    it("the version must be exactly the next one: a replayed, skipped or old version is rejected", async () => {
      const { vault, setPolicy } = await setup(); // version is 2 after setup
      await expect(setPolicy(1n, 1n, 1n, undefined, 2n)).to.be.revertedWithCustomError(vault, "WrongVersion").withArgs(3n);
      await expect(setPolicy(1n, 1n, 1n, undefined, 4n)).to.be.revertedWithCustomError(vault, "WrongVersion").withArgs(3n);
      await expect(setPolicy(1n, 1n, 1n, undefined, 0n)).to.be.revertedWithCustomError(vault, "WrongVersion").withArgs(3n);
      await setPolicy(1n, 1n, 1n, undefined, 3n);
    });

    it("an operator signature cannot be replayed, or reused for different values or another action", async () => {
      const { operator, relayer, stranger, vault, domain } = await setup();
      const v = 3n;
      const sig = await operator.signTypedData(domain, only("SetPolicy"),
        { version: v, perTxCap: USDT(900), dailyCap: USDT(900), minReserve: 0n });
      // different values than signed
      await expect(vault.connect(relayer).setPolicy(v, USDT(9999), USDT(900), 0n, sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      // a SetPolicy signature used as SetPayees or Withdraw
      await expect(vault.connect(relayer).setPayees(v, [stranger.address], true, sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      await expect(vault.connect(relayer).withdrawToProvider(v, USDT(900), sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      await vault.connect(relayer).setPolicy(v, USDT(900), USDT(900), 0n, sig);
      await expect(vault.connect(relayer).setPolicy(v, USDT(900), USDT(900), 0n, sig))
        .to.be.revertedWithCustomError(vault, "WrongVersion");
    });

    it("a payee list that differs from the signed one is rejected (order and content)", async () => {
      const { operator, relayer, payee1, payee2, stranger, vault, domain } = await setup();
      const sig = await operator.signTypedData(domain, only("SetPayees"),
        { version: 3n, payees: [payee1.address, payee2.address], allowed: false });
      for (const list of [[payee2.address, payee1.address], [payee1.address], [payee1.address, stranger.address]]) {
        await expect(vault.connect(relayer).setPayees(3n, list, false, sig))
          .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      }
      await expect(vault.connect(relayer).setPayees(3n, [payee1.address, payee2.address], true, sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature"); // allowed flipped
    });

    it("an operator signature for another vault is rejected", async () => {
      const { operator, agent, policy, provider, relayer, usdt, vault, domain } = await setup(false);
      const other = await ethers.deployContract("ProviderVault", [
        await usdt.getAddress(), operator.address, agent.address, policy.address, provider.address,
      ]);
      const sig = await operator.signTypedData({ ...domain, verifyingContract: await other.getAddress() },
        only("SetPolicy"), { version: 1n, perTxCap: 1n, dailyCap: 1n, minReserve: 0n });
      await expect(vault.connect(relayer).setPolicy(1n, 1n, 1n, 0n, sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      await other.connect(relayer).setPolicy(1n, 1n, 1n, 0n, sig);
    });

    it("the operator cannot move funds to anyone through execute", async () => {
      const { operator, payee1, vault, proposalHash, actionId, signTransfer, pay } = await setup();
      const t = { to: payee1.address, amount: USDT(1), proposalHash, actionId: actionId(0) };
      const sig = await signTransfer(operator, t);
      await expect(pay(t.to, t.amount, 0, { agentSig: sig, policySig: sig }))
        .to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
    });
  });

  describe("signer rotation", () => {
    it("after rotation the new pair can pay and the old pair cannot", async () => {
      const { agent, policy, payee1, stranger, relayer, usdt, vault, proposalHash, actionId, signTransfer, rotate } = await setup();
      const [, , , , , , , , , newAgent, newPolicy] = await ethers.getSigners();
      const t = { to: payee1.address, amount: USDT(10), proposalHash, actionId: actionId(0) };
      const oldSigs = [await signTransfer(agent, t), await signTransfer(policy, t)];

      await expect(rotate(newAgent.address, newPolicy.address))
        .to.emit(vault, "SignersRotated").withArgs(3n, newAgent.address, newPolicy.address);
      await expect(vault.connect(relayer).execute(t.to, t.amount, t.proposalHash, t.actionId, FAR, oldSigs[0], oldSigs[1]))
        .to.be.revertedWithCustomError(vault, "InvalidAgentSignature");
      await vault.connect(stranger).execute(
        t.to, t.amount, t.proposalHash, t.actionId, FAR, await signTransfer(newAgent, t), await signTransfer(newPolicy, t));
      expect(await usdt.balanceOf(payee1.address)).to.equal(USDT(10));
    });

    it("one signer can be replaced while the other is kept", async () => {
      const { agent, policy, vault, rotate } = await setup();
      const [, , , , , , , , , newAgent] = await ethers.getSigners();
      await rotate(newAgent.address, policy.address);
      expect([await vault.agentSigner(), await vault.policySigner()]).to.deep.equal([newAgent.address, policy.address]);
      expect(await vault.agentSigner()).to.not.equal(agent.address);
    });

    it("rotation cannot collapse the keys: no zero, no shared signer, no operator as signer", async () => {
      const { operator, agent, policy, vault, rotate } = await setup();
      await expect(rotate(ethers.ZeroAddress, policy.address)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(rotate(agent.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(rotate(agent.address, agent.address)).to.be.revertedWithCustomError(vault, "KeysNotDistinct");
      await expect(rotate(operator.address, policy.address)).to.be.revertedWithCustomError(vault, "KeysNotDistinct");
      await expect(rotate(agent.address, operator.address)).to.be.revertedWithCustomError(vault, "KeysNotDistinct");
      expect(await vault.policyVersion()).to.equal(2n); // a failed rotation consumes no version
    });
  });

  describe("withdrawToProvider (escape hatch)", () => {
    it("pays only the fixed provider address, ignoring caps, allowlist and reserve", async () => {
      const { provider, usdt, vault, vaultAddr, withdraw } = await setup(); // provider is not on the allowlist
      await expect(withdraw(USDT(2000))).to.emit(vault, "Withdrawn").withArgs(3n, provider.address, USDT(2000));
      expect(await usdt.balanceOf(provider.address)).to.equal(USDT(2000));
      expect(await usdt.balanceOf(vaultAddr)).to.equal(0n);
      expect(await vault.spentToday()).to.equal(0n); // does not use up the day's cap
    });

    it("works even when both co-signer keys are lost (nothing else is needed)", async () => {
      const { provider, usdt, withdraw } = await setup(false); // no policy, no payees
      await withdraw(USDT(500));
      expect(await usdt.balanceOf(provider.address)).to.equal(USDT(500));
    });

    it("rejects a zero amount, more than the balance, a changed amount and a replay", async () => {
      const { operator, relayer, vault, domain, withdraw } = await setup();
      await expect(withdraw(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(withdraw(USDT(2000) + 1n)).to.be.reverted;
      expect(await vault.policyVersion()).to.equal(2n);
      const sig = await operator.signTypedData(domain, only("Withdraw"), { version: 3n, amount: USDT(1) });
      await expect(vault.connect(relayer).withdrawToProvider(3n, USDT(2), sig))
        .to.be.revertedWithCustomError(vault, "InvalidOperatorSignature");
      await vault.connect(relayer).withdrawToProvider(3n, USDT(1), sig);
      await expect(vault.connect(relayer).withdrawToProvider(3n, USDT(1), sig))
        .to.be.revertedWithCustomError(vault, "WrongVersion");
    });
  });

  it("escrow to vault to payees: balances add up across two milestones", async () => {
    const [admin, treasury, client, arbiter] = (await ethers.getSigners()).slice(12, 16); // not used by setup()
    const { provider, payee1, payee2, usdt, vault, vaultAddr, pay, setPolicy } = await setup();
    await setPolicy(USDT(5000), USDT(5000), 0n);
    const escrow = await ethers.deployContract("MilestoneEscrow", [
      await usdt.getAddress(), admin.address, treasury.address, treasury.address, DAY,
    ]);
    await usdt.mint(treasury.address, USDT(1000));
    await usdt.connect(treasury).approve(await escrow.getAddress(), ethers.MaxUint256);
    const timeout = (await time.latest()) + 7 * DAY;
    for (const [name, amount] of [["m1", USDT(600)], ["m2", USDT(400)]] as const) {
      const id = ethers.id(name);
      await escrow.connect(treasury).createAndFund(
        id, client.address, provider.address, arbiter.address, vaultAddr, amount, timeout, false, 0);
      await escrow.connect(client).approve(id);
      await escrow.connect(treasury).release(id);
    }
    expect(await usdt.balanceOf(vaultAddr)).to.equal(USDT(3000)); // 2000 already there + 1000 released
    await pay(payee1.address, USDT(700), 0);
    await pay(payee2.address, USDT(250), 1);
    expect(await usdt.balanceOf(vaultAddr)).to.equal(USDT(2050));
    expect((await usdt.balanceOf(payee1.address)) + (await usdt.balanceOf(payee2.address))).to.equal(USDT(950));
    expect(await vault.spentToday()).to.equal(USDT(950));
  });
});
