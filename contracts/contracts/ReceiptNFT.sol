// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title ReceiptNFT
/// @notice One non-transferable (soulbound) receipt per released milestone. See docs/INTERFACES.md section 3b.
///         Minted by the MINTER role (the treasury) after the vault payout of the milestone is confirmed.
///         Holder: the provider. Stores hashes and the amount only: no names, no personal data.
///         The receipt cannot be transferred, approved or burned. Token ids start at 1, so receiptOf() == 0
///         means "no receipt for this milestone".
contract ReceiptNFT is ERC721, AccessControl {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    struct Receipt {
        bytes32 milestoneId;
        bytes32 invoiceHash;
        bytes32 settlementHash;
        uint256 amount;   // USDT base units released for the milestone
        uint256 chainId;
        bytes32 releaseTx; // hash of the escrow release transaction
        uint64 mintedAt;
    }

    uint256 private _lastId;
    mapping(bytes32 => uint256) private _byMilestone;
    mapping(uint256 => Receipt) private _receipts;

    event ReceiptMinted(uint256 indexed tokenId, bytes32 indexed milestoneId, address indexed holder);

    error ZeroAddress();
    error AlreadyMinted(uint256 tokenId);
    error WrongChain(uint256 expected);
    error EmptyField();
    error Soulbound();

    constructor(address admin, address minter) ERC721("Tethran Settlement Receipt", "TRCPT") {
        if (admin == address(0) || minter == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
    }

    /// @notice MINTER only. One receipt per milestone; reverts if this milestone already has one.
    /// @param chainId must be this chain: a receipt always describes a release on the chain it lives on
    function mint(
        bytes32 milestoneId,
        address holder,
        bytes32 invoiceHash,
        bytes32 settlementHash,
        uint256 amount,
        uint256 chainId,
        bytes32 releaseTx
    ) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        if (holder == address(0)) revert ZeroAddress();
        uint256 existing = _byMilestone[milestoneId];
        if (existing != 0) revert AlreadyMinted(existing);
        if (chainId != block.chainid) revert WrongChain(block.chainid);
        if (milestoneId == bytes32(0) || invoiceHash == bytes32(0) || settlementHash == bytes32(0) || releaseTx == bytes32(0) || amount == 0) {
            revert EmptyField();
        }

        tokenId = ++_lastId;
        _byMilestone[milestoneId] = tokenId;
        _receipts[tokenId] = Receipt({
            milestoneId: milestoneId,
            invoiceHash: invoiceHash,
            settlementHash: settlementHash,
            amount: amount,
            chainId: chainId,
            releaseTx: releaseTx,
            mintedAt: uint64(block.timestamp)
        });
        _safeMint(holder, tokenId);
        emit ReceiptMinted(tokenId, milestoneId, holder);
    }

    function receiptOf(bytes32 milestoneId) external view returns (uint256 tokenId) {
        return _byMilestone[milestoneId];
    }

    /// @notice Everything stored for a receipt. Reverts for a token that does not exist.
    function receipt(uint256 tokenId) external view returns (Receipt memory) {
        _requireOwned(tokenId);
        return _receipts[tokenId];
    }

    /// @notice Self-contained JSON metadata (no off-chain server needed for verification).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Receipt memory r = _receipts[tokenId];
        bytes memory json = abi.encodePacked(
            '{"name":"Tethran receipt #', tokenId.toString(),
            '","description":"Settlement receipt. Hashes only; no personal data. Test network.",',
            '"attributes":[', _hashAttributes(r), _numberAttributes(r), "]}"
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    function _attr(string memory name, string memory value, bool last) private pure returns (bytes memory) {
        return abi.encodePacked('{"trait_type":"', name, '","value":"', value, last ? '"}' : '"},');
    }

    function _hashAttributes(Receipt memory r) private pure returns (bytes memory) {
        return abi.encodePacked(
            _attr("milestoneId", Strings.toHexString(uint256(r.milestoneId), 32), false),
            _attr("invoiceHash", Strings.toHexString(uint256(r.invoiceHash), 32), false),
            _attr("settlementHash", Strings.toHexString(uint256(r.settlementHash), 32), false)
        );
    }

    function _numberAttributes(Receipt memory r) private pure returns (bytes memory) {
        return abi.encodePacked(
            _attr("amount", r.amount.toString(), false),
            _attr("chainId", r.chainId.toString(), false),
            _attr("releaseTx", Strings.toHexString(uint256(r.releaseTx), 32), true)
        );
    }

    // ---- soulbound: no transfers, no approvals ----

    /// @dev Only minting (from == 0) is allowed. Every transfer path in ERC721 goes through _update.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
