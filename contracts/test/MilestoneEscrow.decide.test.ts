import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const AMOUNT = 5_000_000n;
const HOLD = 3600;
const State = { None: 0n, Funded: 1n, Approved: 2n, Disputed: 3n, Released: 4n, Refunded: 5n };
const KIND = { client: 0, provider: 1, arbiter: 2 };
const TYPES = {
  Attestation: [
    { name: "milestoneId", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "releaseToProvider", type: "bool" },
  ],
};

describe("MilestoneEscrow.decide (two of three EIP-712 attestations)", () => {
  async function setup(cardFunded = false) {
    const [admin, treasury, client, provider, arbiter, vault, stranger] = await ethers.getSigners();
    const usdt = await ethers.deployContract("TestUSDT");
    const escrow = await ethers.deployContract("MilestoneEscrow", [
      await usdt.getAddress(), admin.address, treasury.address,
    ]);
    await usdt.mint(treasury.address, 100_000_000n);
    await usdt.connect(treasury).approve(await escrow.getAddress(), ethers.MaxUint256);
    const id = ethers.id("milestone-1");
    const fund = async (milestoneId: string) => escrow.connect(treasury).createAndFund(
      milestoneId, client.address, provider.address, arbiter.address, vault.address,
      AMOUNT, (await time.latest()) + 30 * 24 * 3600, cardFunded, HOLD);
    await fund(id);
    await escrow.connect(client).dispute(id);

    const domain = {
      name: "TethranEscrow",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrow.getAddress(),
    };
    /** Signs an attestation. `over` lets a test sign something other than the honest message. */
    const attest = (
      signer: HardhatEthersSigner, kind: number, releaseToProvider: boolean,
      over: { milestoneId?: string; domain?: object } = {},
    ) => signer.signTypedData(over.domain ?? domain, TYPES, {
      milestoneId: over.milestoneId ?? id, kind, releaseToProvider,
    });

    return { admin, treasury, client, provider, arbiter, vault, stranger, usdt, escrow, id, fund, domain, attest };
  }

  it("provider + arbiter decide for the provider: Approved, then the releaser can release", async () => {
    const { treasury, provider, arbiter, vault, stranger, usdt, escrow, id, attest } = await setup();
    const sigs = [await attest(provider, KIND.provider, true), await attest(arbiter, KIND.arbiter, true)];
    // anyone can submit: the signatures are the authority
    await expect(escrow.connect(stranger).decide(id, true, sigs, [provider.address, arbiter.address]))
      .to.emit(escrow, "Approved").withArgs(id);
    expect(await escrow.state(id)).to.equal(State.Approved);
    expect((await escrow.milestone(id)).approvedAt).to.equal(BigInt(await time.latest()));

    await escrow.connect(treasury).release(id);
    expect(await usdt.balanceOf(vault.address)).to.equal(AMOUNT);
  });

  it("client + arbiter decide for the client: refunded to the funder in the same transaction", async () => {
    const { treasury, client, arbiter, usdt, escrow, id, attest } = await setup();
    const sigs = [await attest(client, KIND.client, false), await attest(arbiter, KIND.arbiter, false)];
    await expect(escrow.decide(id, false, sigs, [client.address, arbiter.address]))
      .to.emit(escrow, "Refunded").withArgs(id, treasury.address, AMOUNT);
    expect(await escrow.state(id)).to.equal(State.Refunded);
    expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n);
    expect(await usdt.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it("client + provider can settle between themselves, in either signer order", async () => {
    const { client, provider, escrow, id, attest } = await setup();
    const sigs = [await attest(provider, KIND.provider, true), await attest(client, KIND.client, true)];
    await escrow.decide(id, true, sigs, [provider.address, client.address]);
    expect(await escrow.state(id)).to.equal(State.Approved);
  });

  it("card-funded: the hold starts at the decision", async () => {
    const { treasury, provider, arbiter, escrow, id, attest } = await setup(true);
    const sigs = [await attest(provider, KIND.provider, true), await attest(arbiter, KIND.arbiter, true)];
    await escrow.decide(id, true, sigs, [provider.address, arbiter.address]);
    await expect(escrow.connect(treasury).release(id)).to.be.revertedWithCustomError(escrow, "HoldActive");
    await time.increase(HOLD);
    await escrow.connect(treasury).release(id);
  });

  it("a decided milestone cannot be decided or disputed again", async () => {
    const { client, provider, arbiter, escrow, id, attest } = await setup();
    const forProvider = [await attest(provider, KIND.provider, true), await attest(arbiter, KIND.arbiter, true)];
    await escrow.decide(id, true, forProvider, [provider.address, arbiter.address]);

    const forClient = [await attest(client, KIND.client, false), await attest(arbiter, KIND.arbiter, false)];
    await expect(escrow.decide(id, false, forClient, [client.address, arbiter.address]))
      .to.be.revertedWithCustomError(escrow, "WrongState");
    await expect(escrow.decide(id, true, forProvider, [provider.address, arbiter.address]))
      .to.be.revertedWithCustomError(escrow, "WrongState");
    await expect(escrow.connect(client).dispute(id)).to.be.revertedWithCustomError(escrow, "WrongState");
  });

  it("only works while Disputed", async () => {
    const { provider, arbiter, escrow, fund, attest } = await setup();
    const id2 = ethers.id("milestone-2");
    await fund(id2); // Funded, not disputed
    const sigs = [
      await attest(provider, KIND.provider, true, { milestoneId: id2 }),
      await attest(arbiter, KIND.arbiter, true, { milestoneId: id2 }),
    ];
    await expect(escrow.decide(id2, true, sigs, [provider.address, arbiter.address]))
      .to.be.revertedWithCustomError(escrow, "WrongState");
  });

  it("is closed once the timeout has passed; the default refund applies instead", async () => {
    const { treasury, provider, arbiter, usdt, escrow, id, attest } = await setup();
    const sigs = [await attest(provider, KIND.provider, true), await attest(arbiter, KIND.arbiter, true)];
    await time.increaseTo((await escrow.milestone(id)).timeout);
    await expect(escrow.decide(id, true, sigs, [provider.address, arbiter.address]))
      .to.be.revertedWithCustomError(escrow, "DisputeWindowOver");
    await escrow.refund(id);
    expect(await usdt.balanceOf(treasury.address)).to.equal(100_000_000n);
  });

  describe("rejects", () => {
    it("one attestation, three attestations, or mismatched array lengths", async () => {
      const { client, provider, arbiter, escrow, id, attest } = await setup();
      const p = await attest(provider, KIND.provider, true);
      const a = await attest(arbiter, KIND.arbiter, true);
      const c = await attest(client, KIND.client, true);
      await expect(escrow.decide(id, true, [p], [provider.address]))
        .to.be.revertedWithCustomError(escrow, "NeedTwoAttestations");
      await expect(escrow.decide(id, true, [p, a, c], [provider.address, arbiter.address, client.address]))
        .to.be.revertedWithCustomError(escrow, "NeedTwoAttestations");
      await expect(escrow.decide(id, true, [p, a], [provider.address]))
        .to.be.revertedWithCustomError(escrow, "NeedTwoAttestations");
      await expect(escrow.decide(id, true, [], [])).to.be.revertedWithCustomError(escrow, "NeedTwoAttestations");
    });

    it("the same party twice", async () => {
      const { provider, escrow, id, attest } = await setup();
      const p = await attest(provider, KIND.provider, true);
      await expect(escrow.decide(id, true, [p, p], [provider.address, provider.address]))
        .to.be.revertedWithCustomError(escrow, "DuplicateSigner");
    });

    it("a signer who is not a party (treasury, admin, stranger)", async () => {
      const { admin, treasury, stranger, arbiter, escrow, id, attest } = await setup();
      const a = await attest(arbiter, KIND.arbiter, true);
      for (const outsider of [treasury, admin, stranger]) {
        const s = await attest(outsider, KIND.provider, true);
        await expect(escrow.decide(id, true, [s, a], [outsider.address, arbiter.address]))
          .to.be.revertedWithCustomError(escrow, "NotParty");
      }
    });

    it("a signature made by someone other than the named signer", async () => {
      const { provider, arbiter, stranger, escrow, id, attest } = await setup();
      const forged = await attest(stranger, KIND.provider, true); // stranger signs "as the provider"
      const a = await attest(arbiter, KIND.arbiter, true);
      await expect(escrow.decide(id, true, [forged, a], [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation").withArgs(provider.address);
    });

    it("attestations for the opposite outcome", async () => {
      const { client, provider, arbiter, escrow, id, attest } = await setup();
      // both signed "release to provider"; someone submits them as a refund
      const sigs = [await attest(provider, KIND.provider, true), await attest(arbiter, KIND.arbiter, true)];
      await expect(escrow.decide(id, false, sigs, [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation");
      // the two parties disagree
      const split = [await attest(client, KIND.client, false), await attest(arbiter, KIND.arbiter, true)];
      await expect(escrow.decide(id, false, split, [client.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation").withArgs(arbiter.address);
      await expect(escrow.decide(id, true, split, [client.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation").withArgs(client.address);
    });

    it("an attestation signed with the wrong kind for that party", async () => {
      const { provider, arbiter, escrow, id, attest } = await setup();
      const wrongKind = await attest(provider, KIND.arbiter, true);
      const a = await attest(arbiter, KIND.arbiter, true);
      await expect(escrow.decide(id, true, [wrongKind, a], [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation").withArgs(provider.address);
    });

    it("signatures swapped against their signers", async () => {
      const { provider, arbiter, escrow, id, attest } = await setup();
      const p = await attest(provider, KIND.provider, true);
      const a = await attest(arbiter, KIND.arbiter, true);
      await expect(escrow.decide(id, true, [a, p], [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation");
    });

    it("attestations replayed from another milestone", async () => {
      const { client, provider, arbiter, escrow, id, fund, attest } = await setup();
      const id2 = ethers.id("milestone-2");
      await fund(id2);
      await escrow.connect(client).dispute(id2);
      // valid for milestone-1, submitted for milestone-2
      const sigs = [await attest(provider, KIND.provider, true), await attest(arbiter, KIND.arbiter, true)];
      await expect(escrow.decide(id2, true, sigs, [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation");
      expect(await escrow.state(id2)).to.equal(State.Disputed);
      expect(await escrow.state(id)).to.equal(State.Disputed);
    });

    it("attestations signed for another chain or another escrow contract", async () => {
      const { provider, arbiter, escrow, id, domain, attest } = await setup();
      const a = await attest(arbiter, KIND.arbiter, true);
      const otherChain = await attest(provider, KIND.provider, true, { domain: { ...domain, chainId: 84532 } });
      await expect(escrow.decide(id, true, [otherChain, a], [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation");
      const otherEscrow = await attest(provider, KIND.provider, true, {
        domain: { ...domain, verifyingContract: arbiter.address },
      });
      await expect(escrow.decide(id, true, [otherEscrow, a], [provider.address, arbiter.address]))
        .to.be.revertedWithCustomError(escrow, "InvalidAttestation");
    });

    it("a malformed signature", async () => {
      const { provider, arbiter, escrow, id, attest } = await setup();
      const a = await attest(arbiter, KIND.arbiter, true);
      await expect(escrow.decide(id, true, ["0x1234", a], [provider.address, arbiter.address])).to.be.reverted;
      expect(await escrow.state(id)).to.equal(State.Disputed);
    });
  });
});
