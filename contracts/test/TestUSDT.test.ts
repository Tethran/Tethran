import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("TestUSDT (test token)", () => {
  async function setup() {
    const [alice, bob, relayer] = await ethers.getSigners();
    const usdt = await ethers.deployContract("TestUSDT");
    await usdt.mint(alice.address, 100_000_000n);
    const domain = {
      name: "Tethran Test USDT",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await usdt.getAddress(),
    };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    return { alice, bob, relayer, usdt, domain, types };
  }

  it("has six decimals and open minting", async () => {
    const { alice, usdt } = await setup();
    expect(await usdt.decimals()).to.equal(6);
    expect(await usdt.balanceOf(alice.address)).to.equal(100_000_000n);
  });

  it("transferWithAuthorization moves funds once, submitted by a relayer", async () => {
    const { alice, bob, relayer, usdt, domain, types } = await setup();
    const msg = {
      from: alice.address, to: bob.address, value: 5_000_000n,
      validAfter: 0n, validBefore: BigInt(await time.latest()) + 3600n, nonce: ethers.id("n1"),
    };
    const sig = ethers.Signature.from(await alice.signTypedData(domain, types, msg));
    const call = () => usdt.connect(relayer).transferWithAuthorization(
      msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, sig.v, sig.r, sig.s);

    await expect(call()).to.emit(usdt, "AuthorizationUsed").withArgs(alice.address, msg.nonce);
    expect(await usdt.balanceOf(bob.address)).to.equal(5_000_000n);
    expect(await usdt.authorizationState(alice.address, msg.nonce)).to.equal(true);
    await expect(call()).to.be.revertedWithCustomError(usdt, "AuthorizationAlreadyUsed");
  });

  it("validity window: strictly after validAfter and strictly before validBefore (exact boundaries)", async () => {
    const { alice, bob, usdt, domain, types } = await setup();
    const now = await time.latest();
    const msg = {
      from: alice.address, to: bob.address, value: 1_000_000n,
      validAfter: BigInt(now + 100), validBefore: BigInt(now + 200), nonce: ethers.id("window"),
    };
    const sig = ethers.Signature.from(await alice.signTypedData(domain, types, msg));
    const call = () => usdt.transferWithAuthorization(
      msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, sig.v, sig.r, sig.s);

    await time.setNextBlockTimestamp(now + 100);
    await expect(call()).to.be.revertedWithCustomError(usdt, "AuthorizationNotYetValid");
    await time.setNextBlockTimestamp(now + 200);
    await expect(call()).to.be.revertedWithCustomError(usdt, "AuthorizationExpired");

    const msg2 = { ...msg, validAfter: BigInt(now + 300), validBefore: BigInt(now + 400), nonce: ethers.id("window2") };
    const sig2 = ethers.Signature.from(await alice.signTypedData(domain, types, msg2));
    await time.setNextBlockTimestamp(now + 301);
    await usdt.transferWithAuthorization(
      msg2.from, msg2.to, msg2.value, msg2.validAfter, msg2.validBefore, msg2.nonce, sig2.v, sig2.r, sig2.s);
    expect(await usdt.balanceOf(bob.address)).to.equal(1_000_000n);
  });

  it("nonces are per authorizer; a signature for another token contract is rejected", async () => {
    const { alice, bob, relayer, usdt, domain, types } = await setup();
    await usdt.mint(bob.address, 10_000_000n);
    const nonce = ethers.id("shared");
    const validBefore = BigInt(await time.latest()) + 3600n;
    for (const from of [alice, bob]) {
      const msg = { from: from.address, to: relayer.address, value: 1_000_000n, validAfter: 0n, validBefore, nonce };
      const sig = ethers.Signature.from(await from.signTypedData(domain, types, msg));
      await usdt.transferWithAuthorization(
        msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, sig.v, sig.r, sig.s);
    }
    expect(await usdt.balanceOf(relayer.address)).to.equal(2_000_000n);

    const msg = { from: alice.address, to: bob.address, value: 1n, validAfter: 0n, validBefore, nonce: ethers.id("x") };
    const wrong = ethers.Signature.from(
      await alice.signTypedData({ ...domain, verifyingContract: bob.address }, types, msg));
    await expect(usdt.transferWithAuthorization(
      msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, wrong.v, wrong.r, wrong.s))
      .to.be.revertedWithCustomError(usdt, "InvalidSignature");
  });

  it("rejects a wrong signer, a changed amount and an expired authorization", async () => {
    const { alice, bob, usdt, domain, types } = await setup();
    const now = BigInt(await time.latest());
    const msg = {
      from: alice.address, to: bob.address, value: 5_000_000n,
      validAfter: 0n, validBefore: now + 3600n, nonce: ethers.id("n2"),
    };
    const bySomeoneElse = ethers.Signature.from(await bob.signTypedData(domain, types, msg));
    await expect(usdt.transferWithAuthorization(
      msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce,
      bySomeoneElse.v, bySomeoneElse.r, bySomeoneElse.s)).to.be.revertedWithCustomError(usdt, "InvalidSignature");

    const good = ethers.Signature.from(await alice.signTypedData(domain, types, msg));
    await expect(usdt.transferWithAuthorization(
      msg.from, msg.to, msg.value + 1n, msg.validAfter, msg.validBefore, msg.nonce,
      good.v, good.r, good.s)).to.be.revertedWithCustomError(usdt, "InvalidSignature");

    await time.increaseTo(now + 3600n);
    await expect(usdt.transferWithAuthorization(
      msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce,
      good.v, good.r, good.s)).to.be.revertedWithCustomError(usdt, "AuthorizationExpired");
  });
});
