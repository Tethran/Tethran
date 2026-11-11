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
