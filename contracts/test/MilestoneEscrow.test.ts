import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const AMOUNT = 5_000_000n; // 5 USDT
const HOLD = 3600;
const WINDOW = 7 * 24 * 3600; // DISPUTE_WINDOW
const State = { None: 0n, Funded: 1n, Approved: 2n, Disputed: 3n, Released: 4n, Refunded: 5n };

describe("MilestoneEscrow", () => {
  async function setup() {
    const [admin, treasury, client, provider, arbiter, vault, stranger] = await ethers.getSigners();
    const usdt = await ethers.deployContract("TestUSDT");
    const escrow = await ethers.deployContract("MilestoneEscrow", [
      await usdt.getAddress(), admin.address, treasury.address,
    ]);
    await usdt.mint(treasury.address, 100_000_000n);
    await usdt.connect(treasury).approve(await escrow.getAddress(), ethers.MaxUint256);
    const id = ethers.id("milestone-1");
    const timeout = (await time.latest()) + 7 * 24 * 3600;

    const fund = (over: { id?: string; cardFunded?: boolean; amount?: bigint; timeout?: number } = {}) =>
      escrow.connect(treasury).createAndFund(
        over.id ?? id, client.address, provider.address, arbiter.address, vault.address,
        over.amount ?? AMOUNT, over.timeout ?? timeout, over.cardFunded ?? false, HOLD);

    return { admin, treasury, client, provider, arbiter, vault, stranger, usdt, escrow, id, timeout, fund };
  }

  describe("createAndFund", () => {
    it("pulls the amount from the funder and stores the milestone", async () => {
      const { treasury, client, provider, arbiter, vault, usdt, escrow, id, timeout, fund } = await setup();
      await expect(fund({ cardFunded: true }))
        .to.emit(escrow, "Funded").withArgs(id, treasury.address, AMOUNT, timeout, true);

      expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
      expect(await escrow.state(id)).to.equal(State.Funded);
      const m = await escrow.milestone(id);
      expect([m.funder, m.client, m.provider, m.arbiter, m.vault])
        .to.deep.equal([treasury.address, client.address, provider.address, arbiter.address, vault.address]);
      expect([m.amount, m.timeout, m.approvedAt, m.holdSeconds, m.cardFunded])
        .to.deep.equal([AMOUNT, BigInt(timeout), 0n, BigInt(HOLD), true]);
    });

    it("rejects a duplicate id, zero amount, past timeout, zero address and overlapping parties", async () => {
      const { treasury, client, provider, arbiter, vault, escrow, timeout, fund } = await setup();
      await fund();
      await expect(fund()).to.be.revertedWithCustomError(escrow, "MilestoneExists");

      const other = ethers.id("milestone-2");
      await expect(fund({ id: other, amount: 0n })).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(fund({ id: other, timeout: await time.latest() }))
        .to.be.revertedWithCustomError(escrow, "TimeoutInPast");
      await expect(escrow.connect(treasury).createAndFund(
        other, client.address, provider.address, arbiter.address, ethers.ZeroAddress, AMOUNT, timeout, false, 0))
        .to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(escrow.connect(treasury).createAndFund(
        other, client.address, client.address, arbiter.address, vault.address, AMOUNT, timeout, false, 0))
        .to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
      expect(await escrow.state(other)).to.equal(State.None);
    });

    it("reverts when the funder has not approved enough USDT", async () => {
      const { client, provider, arbiter, vault, stranger, escrow, id, timeout } = await setup();
      await expect(escrow.connect(stranger).createAndFund(
        id, client.address, provider.address, arbiter.address, vault.address, AMOUNT, timeout, false, 0))
        .to.be.reverted;
      expect(await escrow.state(id)).to.equal(State.None);
    });
  });

  describe("approve", () => {
    it("only the client can approve, and only once", async () => {
      const { client, provider, treasury, escrow, id, fund } = await setup();
      await fund();
      await expect(escrow.connect(provider).approve(id)).to.be.revertedWithCustomError(escrow, "NotClient");
      await expect(escrow.connect(treasury).approve(id)).to.be.revertedWithCustomError(escrow, "NotClient");
      await expect(escrow.connect(client).approve(id)).to.emit(escrow, "Approved").withArgs(id);
      expect(await escrow.state(id)).to.equal(State.Approved);
      expect((await escrow.milestone(id)).approvedAt).to.equal(BigInt(await time.latest()));
      await expect(escrow.connect(client).approve(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("cannot approve a milestone that does not exist", async () => {
      const { client, escrow, id } = await setup();
      await expect(escrow.connect(client).approve(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });
  });

  describe("release", () => {
    it("releaser pays the vault after approval (stablecoin-funded: no hold)", async () => {
      const { treasury, client, vault, usdt, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      await expect(escrow.connect(treasury).release(id))
        .to.emit(escrow, "Released").withArgs(id, vault.address, AMOUNT);
      expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
      expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect(await escrow.state(id)).to.equal(State.Released);
      await expect(escrow.connect(treasury).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("only the RELEASER role can release", async () => {
      const { client, provider, admin, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      for (const who of [client, provider, admin]) {
        await expect(escrow.connect(who).release(id))
          .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      }
    });

    it("cannot release before approval", async () => {
      const { treasury, escrow, id, fund } = await setup();
      await fund();
      await expect(escrow.connect(treasury).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("card-funded: blocked during the hold, allowed once it has passed", async () => {
      const { treasury, client, vault, usdt, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      const approvedAt = await time.latest();

      await expect(escrow.connect(treasury).release(id)).to.be.revertedWithCustomError(escrow, "HoldActive");
      await time.setNextBlockTimestamp(approvedAt + HOLD - 1);
      await expect(escrow.connect(treasury).release(id)).to.be.revertedWithCustomError(escrow, "HoldActive");
      await time.setNextBlockTimestamp(approvedAt + HOLD);
      await escrow.connect(treasury).release(id);
      expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
    });
  });

  describe("dispute", () => {
    it("client or provider can dispute while Funded; release and approve are then blocked", async () => {
      const { treasury, client, provider, arbiter, stranger, escrow, id, fund } = await setup();
      await fund();
      await expect(escrow.connect(arbiter).dispute(id)).to.be.revertedWithCustomError(escrow, "NotParty");
      await expect(escrow.connect(stranger).dispute(id)).to.be.revertedWithCustomError(escrow, "NotParty");
      const at = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(at);
      await expect(escrow.connect(provider).dispute(id))
        .to.emit(escrow, "Disputed").withArgs(id, provider.address, at + WINDOW);
      expect(await escrow.state(id)).to.equal(State.Disputed);
      await expect(escrow.connect(client).approve(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await expect(escrow.connect(treasury).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("approval is final: nobody can dispute once Approved, even during the card hold", async () => {
      const { treasury, client, provider, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await expect(escrow.connect(provider).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await time.increase(HOLD);
      await escrow.connect(treasury).release(id);
    });

    it("a dispute pushes a near timeout out to now + 7 days", async () => {
      const { client, escrow, id, timeout, fund } = await setup();
      await fund();
      const at = timeout - 60; // one minute before the original timeout
      await time.setNextBlockTimestamp(at);
      await escrow.connect(client).dispute(id);
      expect((await escrow.milestone(id)).timeout).to.equal(BigInt(at + WINDOW));

      await time.increaseTo(timeout);
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "TimeoutNotReached");
      await time.increaseTo(at + WINDOW);
      await escrow.refund(id);
      expect(await escrow.state(id)).to.equal(State.Refunded);
    });

    it("a dispute never shortens a later timeout", async () => {
      const { provider, escrow, id, fund } = await setup();
      const far = (await time.latest()) + 30 * 24 * 3600;
      await fund({ timeout: far });
      await escrow.connect(provider).dispute(id);
      expect((await escrow.milestone(id)).timeout).to.equal(BigInt(far));
    });

    it("cannot dispute after release", async () => {
      const { treasury, client, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      await escrow.connect(treasury).release(id);
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });
  });

  describe("refund", () => {
    it("blocked before the timeout; anyone can trigger it after; funds go to the funder", async () => {
      const { treasury, stranger, usdt, escrow, id, timeout, fund } = await setup();
      await fund();
      const before = await usdt.balanceOf(treasury.address);
      await expect(escrow.connect(stranger).refund(id)).to.be.revertedWithCustomError(escrow, "TimeoutNotReached");
      await time.setNextBlockTimestamp(timeout);
      await expect(escrow.connect(stranger).refund(id))
        .to.emit(escrow, "Refunded").withArgs(id, treasury.address, AMOUNT);
      expect(await usdt.balanceOf(treasury.address)).to.equal(before + AMOUNT);
      expect(await escrow.state(id)).to.equal(State.Refunded);
      await expect(escrow.connect(stranger).refund(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("an undecided dispute refunds at the (extended) timeout", async () => {
      const { treasury, client, usdt, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).dispute(id);
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "TimeoutNotReached");
      await time.increaseTo((await escrow.milestone(id)).timeout);
      await escrow.refund(id);
      expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n);
    });

    it("an approved or released milestone cannot be refunded, even after the timeout", async () => {
      const { treasury, client, escrow, id, timeout, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      await time.increaseTo(timeout);
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await escrow.connect(treasury).release(id);
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });
  });

  it("milestones are independent: two escrows, one released and one refunded", async () => {
    const { treasury, client, vault, usdt, escrow, id, timeout, fund } = await setup();
    const id2 = ethers.id("milestone-2");
    await fund();
    await fund({ id: id2, amount: 7_000_000n });
    await escrow.connect(client).approve(id);
    await escrow.connect(treasury).release(id);
    expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(7_000_000n);
    await time.increaseTo(timeout);
    await escrow.refund(id2);
    expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
    expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(0n);
  });
});
