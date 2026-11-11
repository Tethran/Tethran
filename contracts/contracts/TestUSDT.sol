// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title TestUSDT
/// @notice TEST TOKEN ONLY. This is not Tether USDT and has no value. It stands in for USDT on
///         test networks: six decimals, open minting (it is its own faucet) and EIP-3009
///         `transferWithAuthorization`, so x402 payments can be settled by our own facilitator.
contract TestUSDT is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev authorizer => nonce => used
    mapping(address => mapping(bytes32 => bool)) private _authorizationUsed;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();

    constructor() ERC20("Tethran Test USDT", "tUSDT") EIP712("Tethran Test USDT", "1") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Faucet. Anyone can mint any amount: this token is for test networks only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationUsed[authorizer][nonce];
    }

    /// @notice EIP-3009: move `value` from `from` to `to` using a signature by `from`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationUsed[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        if (ECDSA.recover(digest, v, r, s) != from) revert InvalidSignature();

        _authorizationUsed[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
