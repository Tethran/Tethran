import { expect } from "chai";
import { ethers } from "hardhat";

describe("ReceiptNFT (soulbound, hashes only)", () => {
  async function setup() {
    const [admin, minter, provider, other, stranger] = await ethers.getSigners();
    const nft = await ethers.deployContract("ReceiptNFT", [admin.address, minter.address]);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const m = {
      milestoneId: ethers.id("milestone-1"),
      invoiceHash: ethers.id("invoice INV-001"),
      settlementHash: ethers.id("settlement plan"),
      amount: 100_000_000n,
      releaseTx: ethers.id("release tx"),
    };
    const mint = (over: Partial<typeof m & { holder: string; chainId: bigint }> = {}, by = minter) => {
      const x = { ...m, holder: provider.address, chainId, ...over };
      return nft.connect(by).mint(x.milestoneId, x.holder, x.invoiceHash, x.settlementHash, x.amount, x.chainId, x.releaseTx);
    };
    return { admin, minter, provider, other, stranger, nft, chainId, m, mint };
  }

  it("mints one receipt to the provider and stores exactly the hashes and amount", async () => {
    const { provider, nft, chainId, m, mint } = await setup();
    await expect(mint()).to.emit(nft, "ReceiptMinted").withArgs(1n, m.milestoneId, provider.address);
    expect(await nft.ownerOf(1)).to.equal(provider.address);
    expect(await nft.receiptOf(m.milestoneId)).to.equal(1n);
    const r = await nft.receipt(1);
    expect([r.milestoneId, r.invoiceHash, r.settlementHash, r.amount, r.chainId, r.releaseTx])
      .to.deep.equal([m.milestoneId, m.invoiceHash, m.settlementHash, m.amount, chainId, m.releaseTx]);
  });

  it("one receipt per milestone: a second mint reverts (idempotency is enforced on-chain)", async () => {
    const { other, nft, mint } = await setup();
    await mint();
    await expect(mint()).to.be.revertedWithCustomError(nft, "AlreadyMinted").withArgs(1n);
    await expect(mint({ holder: other.address, invoiceHash: ethers.id("different") }))
      .to.be.revertedWithCustomError(nft, "AlreadyMinted");
    await mint({ milestoneId: ethers.id("milestone-2") });
    expect(await nft.receiptOf(ethers.id("milestone-2"))).to.equal(2n);
  });

  it("an unknown milestone has receiptOf 0", async () => {
    const { nft } = await setup();
    expect(await nft.receiptOf(ethers.id("nope"))).to.equal(0n);
  });

  it("only the MINTER role can mint", async () => {
    const { admin, provider, stranger, nft, mint } = await setup();
    for (const who of [admin, provider, stranger]) {
      await expect(mint({}, who)).to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount");
    }
  });

  it("rejects a wrong chain id, a zero holder and empty fields", async () => {
    const { nft, chainId, mint } = await setup();
    await expect(mint({ chainId: chainId + 1n })).to.be.revertedWithCustomError(nft, "WrongChain").withArgs(chainId);
    await expect(mint({ holder: ethers.ZeroAddress })).to.be.revertedWithCustomError(nft, "ZeroAddress");
    for (const over of [{ milestoneId: ethers.ZeroHash }, { invoiceHash: ethers.ZeroHash }, { settlementHash: ethers.ZeroHash },
      { releaseTx: ethers.ZeroHash }, { amount: 0n }]) {
      await expect(mint(over)).to.be.revertedWithCustomError(nft, "EmptyField");
    }
  });

  it("is soulbound: no transfer, no safe transfer, no approval, even by the holder", async () => {
    const { provider, other, nft, mint } = await setup();
    await mint();
    await expect(nft.connect(provider).transferFrom(provider.address, other.address, 1))
      .to.be.revertedWithCustomError(nft, "Soulbound");
    await expect(nft.connect(provider)["safeTransferFrom(address,address,uint256)"](provider.address, other.address, 1))
      .to.be.revertedWithCustomError(nft, "Soulbound");
    await expect(nft.connect(provider).approve(other.address, 1)).to.be.revertedWithCustomError(nft, "Soulbound");
    await expect(nft.connect(provider).setApprovalForAll(other.address, true)).to.be.revertedWithCustomError(nft, "Soulbound");
    expect(await nft.ownerOf(1)).to.equal(provider.address);
  });

  it("tokenURI is self-contained JSON with the hashes and no personal data", async () => {
    const { nft, chainId, m, mint } = await setup();
    await mint();
    const uri = await nft.tokenURI(1);
    expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    const attrs = Object.fromEntries(json.attributes.map((a: { trait_type: string; value: string }) => [a.trait_type, a.value]));
    expect(attrs).to.deep.equal({
      milestoneId: m.milestoneId, invoiceHash: m.invoiceHash, settlementHash: m.settlementHash,
      amount: m.amount.toString(), chainId: chainId.toString(), releaseTx: m.releaseTx,
    });
    await expect(nft.tokenURI(2)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
  });

  it("constructor rejects zero addresses; supports ERC-721 and AccessControl interfaces", async () => {
    const [a] = await ethers.getSigners();
    const f = await ethers.getContractFactory("ReceiptNFT");
    await expect(f.deploy(ethers.ZeroAddress, a.address)).to.be.revertedWithCustomError(f, "ZeroAddress");
    await expect(f.deploy(a.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(f, "ZeroAddress");
    const { nft } = await setup();
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
    expect(await nft.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
  });
});
