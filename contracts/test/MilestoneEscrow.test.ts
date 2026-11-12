import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const AMOUNT = 5_000_000n; // 5 USDT
const HOLD = 3600;
const DAY = 24 * 3600;
const WINDOW = 7 * DAY; // DISPUTE_WINDOW
const MIN_TIMEOUT = DAY;
const MAX_HOLD = 30 * DAY;
const GRACE = 3 * DAY; // RELEASE_GRACE
const State = { None: 0n, Funded: 1n, Approved: 2n, Disputed: 3n, Released: 4n, Refunded: 5n };

describe("MilestoneEscrow", () => {
  async function setup() {
    const [admin, treasury, client, provider, arbiter, vault, stranger, releaser] = await ethers.getSigners();
    const usdt = await ethers.deployContract("TestUSDT");
    // treasury is FUNDER; a separate account is RELEASER so the tests can tell the two roles apart
    const escrow = await ethers.deployContract("MilestoneEscrow", [
      await usdt.getAddress(), admin.address, releaser.address, treasury.address,
    ]);
    await usdt.mint(treasury.address, 100_000_000n);
    await usdt.connect(treasury).approve(await escrow.getAddress(), ethers.MaxUint256);
    const id = ethers.id("milestone-1");
    const timeout = (await time.latest()) + 7 * DAY;

    type Over = {
      id?: string; cardFunded?: boolean; amount?: bigint; timeout?: number; hold?: number;
      client?: string; provider?: string; arbiter?: string; vault?: string;
    };
    const fund = (over: Over = {}) =>
      escrow.connect(treasury).createAndFund(
        over.id ?? id, over.client ?? client.address, over.provider ?? provider.address,
        over.arbiter ?? arbiter.address, over.vault ?? vault.address,
        over.amount ?? AMOUNT, over.timeout ?? timeout, over.cardFunded ?? false, over.hold ?? HOLD);

    return { admin, treasury, client, provider, arbiter, vault, stranger, releaser, usdt, escrow, id, timeout, fund };
  }

  describe("constructor", () => {
    it("rejects a zero token, admin, releaser or funder", async () => {
      const [a] = await ethers.getSigners();
      const usdt = await ethers.deployContract("TestUSDT");
      const factory = await ethers.getContractFactory("MilestoneEscrow");
      const t = await usdt.getAddress();
      const Z = ethers.ZeroAddress;
      for (const args of [[Z, a.address, a.address, a.address], [t, Z, a.address, a.address],
        [t, a.address, Z, a.address], [t, a.address, a.address, Z]] as const) {
        await expect(factory.deploy(...args)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      }
    });

    it("grants admin, RELEASER and FUNDER to the given accounts only", async () => {
      const { admin, treasury, releaser, escrow } = await setup();
      expect(await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await escrow.hasRole(await escrow.RELEASER_ROLE(), releaser.address)).to.equal(true);
      expect(await escrow.hasRole(await escrow.FUNDER_ROLE(), treasury.address)).to.equal(true);
      expect(await escrow.hasRole(await escrow.RELEASER_ROLE(), treasury.address)).to.equal(false);
      expect(await escrow.hasRole(await escrow.FUNDER_ROLE(), admin.address)).to.equal(false);
    });
  });

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

    it("only the FUNDER role can create a milestone (no front-running of an id)", async () => {
      const { admin, client, provider, arbiter, vault, stranger, releaser, usdt, escrow, id, timeout } = await setup();
      for (const who of [stranger, client, admin, releaser]) {
        await usdt.mint(who.address, AMOUNT);
        await usdt.connect(who).approve(await escrow.getAddress(), AMOUNT);
        await expect(escrow.connect(who).createAndFund(
          id, client.address, provider.address, arbiter.address, vault.address, 1n, timeout, false, 0))
          .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      }
      expect(await escrow.state(id)).to.equal(State.None);
    });

    it("rejects a duplicate id and a zero amount", async () => {
      const { escrow, fund } = await setup();
      await fund();
      await expect(fund()).to.be.revertedWithCustomError(escrow, "MilestoneExists");
      await expect(fund({ id: ethers.id("m2"), amount: 0n })).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("rejects each zero address", async () => {
      const { escrow, fund } = await setup();
      const Z = ethers.ZeroAddress;
      for (const over of [{ client: Z }, { provider: Z }, { arbiter: Z }, { vault: Z }]) {
        await expect(fund(over)).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      }
    });

    it("rejects the escrow or the token as vault or party", async () => {
      const { usdt, escrow, fund } = await setup();
      for (const bad of [await escrow.getAddress(), await usdt.getAddress()]) {
        for (const over of [{ client: bad }, { provider: bad }, { arbiter: bad }, { vault: bad }]) {
          await expect(fund(over)).to.be.revertedWithCustomError(escrow, "InvalidAddress");
        }
      }
    });

    it("rejects any two parties being the same address", async () => {
      const { client, provider, escrow, fund } = await setup();
      await expect(fund({ provider: client.address })).to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
      await expect(fund({ arbiter: client.address })).to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
      await expect(fund({ arbiter: provider.address })).to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
    });

    it("the timeout must be at least MIN_TIMEOUT ahead (exact boundary)", async () => {
      const { escrow, id, fund } = await setup();
      const at = (await time.latest()) + 100;
      await time.setNextBlockTimestamp(at);
      await expect(fund({ timeout: at + MIN_TIMEOUT - 1 })).to.be.revertedWithCustomError(escrow, "TimeoutTooSoon");
      await time.setNextBlockTimestamp(at + 1);
      await fund({ timeout: at + 1 + MIN_TIMEOUT });
      expect(await escrow.state(id)).to.equal(State.Funded);
    });

    it("the hold is capped at MAX_HOLD (exact boundary)", async () => {
      const { escrow, fund } = await setup();
      await expect(fund({ cardFunded: true, hold: MAX_HOLD + 1 })).to.be.revertedWithCustomError(escrow, "HoldTooLong");
      await fund({ cardFunded: true, hold: MAX_HOLD });
    });

    it("reverts when the funder has no allowance or no balance, and stores nothing", async () => {
      const { treasury, stranger, usdt, escrow, id, fund } = await setup();
      await usdt.connect(treasury).approve(await escrow.getAddress(), AMOUNT - 1n);
      await expect(fund()).to.be.reverted;
      await usdt.connect(treasury).approve(await escrow.getAddress(), ethers.MaxUint256);
      await usdt.connect(treasury).transfer(stranger.address, await usdt.balanceOf(treasury.address));
      await expect(fund()).to.be.reverted;
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

    it("closes at the timeout (exact boundary): the refund is due instead", async () => {
      const { client, escrow, id, timeout, fund } = await setup();
      await fund();
      await time.setNextBlockTimestamp(timeout);
      await expect(escrow.connect(client).approve(id)).to.be.revertedWithCustomError(escrow, "TimeoutReached");
      await escrow.refund(id);
    });

    it("still works one second before the timeout", async () => {
      const { client, escrow, id, timeout, fund } = await setup();
      await fund();
      await time.setNextBlockTimestamp(timeout - 1);
      await escrow.connect(client).approve(id);
      expect(await escrow.state(id)).to.equal(State.Approved);
    });
  });

  describe("release", () => {
    it("releaser pays the vault after approval (stablecoin-funded: no hold)", async () => {
      const { releaser, client, vault, usdt, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      await expect(escrow.connect(releaser).release(id))
        .to.emit(escrow, "Released").withArgs(id, vault.address, AMOUNT);
      expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
      expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect(await escrow.state(id)).to.equal(State.Released);
      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("only the RELEASER role can release (not the funder, client, provider or admin)", async () => {
      const { treasury, client, provider, admin, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      for (const who of [treasury, client, provider, admin]) {
        await expect(escrow.connect(who).release(id))
          .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      }
    });

    it("cannot release before approval, or an id that does not exist", async () => {
      const { releaser, escrow, id, fund } = await setup();
      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await fund();
      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("card-funded: blocked during the hold, allowed once it has passed (exact boundary)", async () => {
      const { releaser, client, vault, usdt, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      const approvedAt = await time.latest();

      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "HoldActive");
      await time.setNextBlockTimestamp(approvedAt + HOLD - 1);
      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "HoldActive");
      await time.setNextBlockTimestamp(approvedAt + HOLD);
      await escrow.connect(releaser).release(id);
      expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
    });

    it("card-funded with a zero hold releases at once; a stablecoin milestone ignores holdSeconds", async () => {
      const { releaser, client, escrow, id, fund } = await setup();
      await fund({ cardFunded: true, hold: 0 });
      await escrow.connect(client).approve(id);
      await escrow.connect(releaser).release(id);

      const id2 = ethers.id("m2");
      await fund({ id: id2, cardFunded: false, hold: MAX_HOLD });
      await escrow.connect(client).approve(id2);
      await escrow.connect(releaser).release(id2);
      expect(await escrow.state(id2)).to.equal(State.Released);
    });

    it("the admin can replace the releaser; a revoked releaser can no longer release", async () => {
      const { admin, releaser, stranger, client, escrow, id, fund } = await setup();
      const role = await escrow.RELEASER_ROLE();
      await fund();
      await escrow.connect(client).approve(id);
      await expect(escrow.connect(stranger).grantRole(role, stranger.address))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      await escrow.connect(admin).revokeRole(role, releaser.address);
      await expect(escrow.connect(releaser).release(id))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      await escrow.connect(admin).grantRole(role, stranger.address);
      await escrow.connect(stranger).release(id);
      expect(await escrow.state(id)).to.equal(State.Released);
    });
  });

  describe("dispute", () => {
    it("client or provider can dispute while Funded; release and approve are then blocked", async () => {
      const { treasury, releaser, client, provider, arbiter, stranger, escrow, id, fund } = await setup();
      await fund();
      for (const who of [arbiter, stranger, treasury]) {
        await expect(escrow.connect(who).dispute(id)).to.be.revertedWithCustomError(escrow, "NotParty");
      }
      const at = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(at);
      await expect(escrow.connect(provider).dispute(id))
        .to.emit(escrow, "Disputed").withArgs(id, provider.address, at + WINDOW);
      expect(await escrow.state(id)).to.equal(State.Disputed);
      await expect(escrow.connect(client).approve(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("approval is final: nobody can dispute once Approved, even during the card hold", async () => {
      const { releaser, client, provider, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await expect(escrow.connect(provider).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await time.increase(HOLD);
      await escrow.connect(releaser).release(id);
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
      const far = (await time.latest()) + 30 * DAY;
      await fund({ timeout: far });
      await escrow.connect(provider).dispute(id);
      expect((await escrow.milestone(id)).timeout).to.equal(BigInt(far));
    });

    it("closes at the timeout (exact boundary): a due refund cannot be delayed by disputing", async () => {
      const { treasury, client, provider, usdt, escrow, id, timeout, fund } = await setup();
      await fund();
      await time.setNextBlockTimestamp(timeout);
      await expect(escrow.connect(provider).dispute(id)).to.be.revertedWithCustomError(escrow, "TimeoutReached");
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "TimeoutReached");
      await escrow.refund(id);
      expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n);
    });

    it("cannot dispute after release", async () => {
      const { releaser, client, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      await escrow.connect(releaser).release(id);
      await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });
  });

  describe("refund", () => {
    it("blocked before the timeout; anyone can trigger it after; funds go to the funder", async () => {
      const { treasury, stranger, usdt, escrow, id, timeout, fund } = await setup();
      await fund();
      const before = await usdt.balanceOf(treasury.address);
      await time.setNextBlockTimestamp(timeout - 1);
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

    it("refund() never touches an Approved, Released or missing milestone", async () => {
      const { releaser, client, escrow, id, timeout, fund } = await setup();
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await fund();
      await escrow.connect(client).approve(id);
      await time.increaseTo(timeout);
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await escrow.connect(releaser).release(id);
      await expect(escrow.refund(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });
  });

  describe("refundApproved (rescue and chargeback)", () => {
    it("chargeback: the releaser can refund to the funder only while the card hold runs", async () => {
      const { treasury, releaser, client, usdt, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      const approvedAt = await time.latest();
      await time.setNextBlockTimestamp(approvedAt + HOLD - 1);
      await expect(escrow.connect(releaser).refundApproved(id))
        .to.emit(escrow, "Refunded").withArgs(id, treasury.address, AMOUNT);
      expect(await escrow.state(id)).to.equal(State.Refunded);
      expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n);
      await expect(escrow.connect(releaser).release(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });

    it("chargeback path closes when the hold ends (exact boundary)", async () => {
      const { releaser, client, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      await time.setNextBlockTimestamp((await time.latest()) + HOLD);
      await expect(escrow.connect(releaser).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
    });

    it("the releaser has no refund path on a stablecoin-funded milestone", async () => {
      const { releaser, client, escrow, id, fund } = await setup();
      await fund({ cardFunded: false });
      await escrow.connect(client).approve(id);
      await expect(escrow.connect(releaser).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
    });

    it("rescue: the funder can take back an unreleased milestone after hold + grace (exact boundary)", async () => {
      const { treasury, client, usdt, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      const approvedAt = await time.latest();
      await time.setNextBlockTimestamp(approvedAt + HOLD + GRACE - 1);
      await expect(escrow.connect(treasury).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
      await time.setNextBlockTimestamp(approvedAt + HOLD + GRACE);
      await expect(escrow.connect(treasury).refundApproved(id))
        .to.emit(escrow, "Refunded").withArgs(id, treasury.address, AMOUNT);
      expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n);
    });

    it("rescue on a stablecoin-funded milestone counts the grace from approval, ignoring holdSeconds", async () => {
      const { treasury, client, escrow, id, fund } = await setup();
      await fund({ cardFunded: false, hold: MAX_HOLD });
      await escrow.connect(client).approve(id);
      const approvedAt = await time.latest();
      await time.setNextBlockTimestamp(approvedAt + GRACE);
      await escrow.connect(treasury).refundApproved(id);
      expect(await escrow.state(id)).to.equal(State.Refunded);
    });

    it("rescue works when every releaser has been revoked (funds are not stranded)", async () => {
      const { admin, treasury, releaser, client, escrow, id, fund } = await setup();
      await fund();
      await escrow.connect(client).approve(id);
      await escrow.connect(admin).revokeRole(await escrow.RELEASER_ROLE(), releaser.address);
      await time.increase(GRACE);
      await escrow.connect(treasury).refundApproved(id);
      expect(await escrow.state(id)).to.equal(State.Refunded);
    });

    it("between the hold and the grace end only release is possible", async () => {
      const { treasury, releaser, client, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      await time.increase(HOLD + 10);
      await expect(escrow.connect(releaser).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
      await expect(escrow.connect(treasury).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
      await escrow.connect(releaser).release(id);
    });

    it("nobody else can use it: client, provider, admin, stranger", async () => {
      const { admin, client, provider, stranger, escrow, id, fund } = await setup();
      await fund({ cardFunded: true });
      await escrow.connect(client).approve(id);
      for (const who of [client, provider, admin, stranger]) {
        await expect(escrow.connect(who).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
      }
      await time.increase(HOLD + GRACE);
      for (const who of [client, provider, admin, stranger]) {
        await expect(escrow.connect(who).refundApproved(id)).to.be.revertedWithCustomError(escrow, "RefundNotAllowed");
      }
    });

    it("only for Approved milestones", async () => {
      const { treasury, releaser, client, escrow, id, fund } = await setup();
      await expect(escrow.connect(treasury).refundApproved(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await fund();
      await expect(escrow.connect(treasury).refundApproved(id)).to.be.revertedWithCustomError(escrow, "WrongState");
      await escrow.connect(client).approve(id);
      await escrow.connect(releaser).release(id);
      await time.increase(GRACE);
      await expect(escrow.connect(treasury).refundApproved(id)).to.be.revertedWithCustomError(escrow, "WrongState");
    });
  });

  it("milestones are independent and the escrow balance always equals the open amounts", async () => {
    const { treasury, releaser, client, vault, usdt, escrow, id, timeout, fund } = await setup();
    const id2 = ethers.id("milestone-2");
    const id3 = ethers.id("milestone-3");
    const held = async () => usdt.balanceOf(await escrow.getAddress());
    await fund();
    await fund({ id: id2, amount: 7_000_000n });
    await fund({ id: id3, amount: 11_000_000n, cardFunded: true });
    expect(await held()).to.equal(23_000_000n);

    await escrow.connect(client).approve(id);
    await escrow.connect(releaser).release(id);
    expect(await held()).to.equal(18_000_000n);

    await escrow.connect(client).approve(id3);
    await escrow.connect(releaser).refundApproved(id3); // chargeback during the hold
    expect(await held()).to.equal(7_000_000n);

    await time.increaseTo(timeout);
    await escrow.refund(id2);
    expect(await held()).to.equal(0n);
    expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
    expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n - AMOUNT);
  });
});
