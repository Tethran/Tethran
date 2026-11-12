// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ProviderVault
/// @notice One per provider. Receives escrow releases and pays USDT out. See docs/INTERFACES.md section 3.
///
///         Three keys, three different jobs. None of them is msg.sender: every action is authorised by
///         EIP-712 signatures, and anyone may submit the transaction.
///           agentSigner + policySigner  together co-sign each transfer (two of two)
///           operator                    signs limits, payees, signer rotation and the escape withdrawal
///
///         The spending guard is built in. Every transfer must pass the operator's limits, so a transfer
///         signed by both co-signers still fails if it breaks a limit:
///           payee allowlist, per-transaction cap, daily cap (UTC day), vault balance floor.
///
///         A new vault has policy version 0 and all limits 0: nothing can be paid until the operator
///         signs a policy. Only USDT moves. There are no arbitrary calls.
contract ProviderVault is EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address to,uint256 amount,bytes32 proposalHash,bytes32 actionId)");
    bytes32 public constant SET_POLICY_TYPEHASH =
        keccak256("SetPolicy(uint256 version,uint256 perTxCap,uint256 dailyCap,uint256 minReserve)");
    bytes32 public constant SET_PAYEES_TYPEHASH =
        keccak256("SetPayees(uint256 version,address[] payees,bool allowed)");
    bytes32 public constant ROTATE_SIGNERS_TYPEHASH =
        keccak256("RotateSigners(uint256 version,address agentSigner,address policySigner)");
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("Withdraw(uint256 version,uint256 amount)");

    /// @dev Guard reasons, as returned by `check` and carried by `GuardBlocked`.
    ///      The names match the Policy Service reason codes.
    bytes32 public constant PAYEE_NOT_ALLOWED = "PAYEE_NOT_ALLOWED";
    bytes32 public constant OVER_PER_TX_CAP = "OVER_PER_TX_CAP";
    bytes32 public constant OVER_DAILY_CAP = "OVER_DAILY_CAP";
    bytes32 public constant BELOW_VAULT_RESERVE = "BELOW_VAULT_RESERVE";

    IERC20 public immutable usdt;
    /// @dev The provider or agency admin. Signs policy; can never be a co-signer.
    address public immutable operator;
    /// @dev The only address the operator's escape withdrawal can pay.
    address public immutable providerPayout;

    address public agentSigner;
    address public policySigner;

    /// @dev Counts every operator action. Each one must carry policyVersion + 1, so an old or
    ///      out-of-order operator signature is useless.
    uint256 public policyVersion;
    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public minReserve;
    mapping(address => bool) public allowedPayee;
    /// @dev UTC day number (block.timestamp / 1 days) => USDT paid out that day through `execute`.
    mapping(uint256 => uint256) public spentOnDay;
    /// @dev A transfer's action id can be used once.
    mapping(bytes32 => bool) public actionUsed;

    event Executed(bytes32 indexed actionId, bytes32 indexed proposalHash, address indexed to, uint256 amount);
    event PolicyUpdated(uint256 version, uint256 perTxCap, uint256 dailyCap, uint256 minReserve);
    event PayeesSet(uint256 version, address[] payees, bool allowed);
    event SignersRotated(uint256 version, address agentSigner, address policySigner);
    event Withdrawn(uint256 version, address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidAddress();
    error KeysNotDistinct();
    error ZeroAmount();
    error ActionAlreadyUsed();
    error InvalidAgentSignature();
    error InvalidPolicySignature();
    error InvalidOperatorSignature();
    error WrongVersion(uint256 expected);
    error GuardBlocked(bytes32 reason);

    constructor(
        IERC20 usdt_,
        address operator_,
        address agentSigner_,
        address policySigner_,
        address providerPayout_
    ) EIP712("TethranVault", "1") {
        if (address(usdt_) == address(0) || operator_ == address(0) || providerPayout_ == address(0)) {
            revert ZeroAddress();
        }
        // Paying out to the vault itself or to the token contract would lose the funds.
        if (providerPayout_ == address(this) || providerPayout_ == address(usdt_)) revert InvalidAddress();
        usdt = usdt_;
        operator = operator_;
        providerPayout = providerPayout_;
        _setSigners(agentSigner_, policySigner_);
    }

    // ---------------------------------------------------------------- transfers

    /// @notice Pay `amount` USDT to `to`. Needs both co-signatures over the same Transfer typed data
    ///         and must pass every guard limit. `actionId` can be used once.
    /// @param proposalHash hash of the settlement proposal the Policy Service approved (for the audit trail)
    /// @param actionId     keccak256(abi.encode(proposalHash, index of the action in the proposal))
    function execute(
        address to,
        uint256 amount,
        bytes32 proposalHash,
        bytes32 actionId,
        bytes calldata agentSig,
        bytes calldata policySig
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (actionUsed[actionId]) revert ActionAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TRANSFER_TYPEHASH, to, amount, proposalHash, actionId)));
        if (ECDSA.recover(digest, agentSig) != agentSigner) revert InvalidAgentSignature();
        if (ECDSA.recover(digest, policySig) != policySigner) revert InvalidPolicySignature();

        bytes32 reason = _guardReason(to, amount);
        if (reason != bytes32(0)) revert GuardBlocked(reason);

        actionUsed[actionId] = true;
        spentOnDay[_today()] += amount;
        usdt.safeTransfer(to, amount);
        emit Executed(actionId, proposalHash, to, amount);
    }

    /// @notice Would a transfer of `amount` to `to` pass the limits right now? Same logic as `execute`.
    /// @return ok     true if it would pass
    /// @return reason bytes32(0) if ok, otherwise the first limit it breaks
    function check(address to, uint256 amount) external view returns (bool ok, bytes32 reason) {
        reason = _guardReason(to, amount);
        ok = reason == bytes32(0);
    }

    function spentToday() external view returns (uint256) {
        return spentOnDay[_today()];
    }

    // ---------------------------------------------------------------- operator actions

    /// @notice Set the limits. Takes effect at once.
    function setPolicy(
        uint256 version,
        uint256 perTxCap_,
        uint256 dailyCap_,
        uint256 minReserve_,
        bytes calldata operatorSig
    ) external {
        _useOperatorSignature(
            version,
            keccak256(abi.encode(SET_POLICY_TYPEHASH, version, perTxCap_, dailyCap_, minReserve_)),
            operatorSig
        );
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        minReserve = minReserve_;
        emit PolicyUpdated(version, perTxCap_, dailyCap_, minReserve_);
    }

    /// @notice Add (`allowed` true) or remove (`allowed` false) payees.
    function setPayees(uint256 version, address[] calldata payees, bool allowed, bytes calldata operatorSig) external {
        _useOperatorSignature(
            version,
            // EIP-712 encodes an address[] as the hash of its elements, each padded to 32 bytes.
            keccak256(abi.encode(SET_PAYEES_TYPEHASH, version, keccak256(abi.encodePacked(payees)), allowed)),
            operatorSig
        );
        for (uint256 i = 0; i < payees.length; i++) {
            allowedPayee[payees[i]] = allowed;
        }
        emit PayeesSet(version, payees, allowed);
    }

    /// @notice Replace both co-signers (pass the current address to keep one). For a lost or leaked key.
    function rotateSigners(
        uint256 version,
        address agentSigner_,
        address policySigner_,
        bytes calldata operatorSig
    ) external {
        _useOperatorSignature(
            version,
            keccak256(abi.encode(ROTATE_SIGNERS_TYPEHASH, version, agentSigner_, policySigner_)),
            operatorSig
        );
        _setSigners(agentSigner_, policySigner_);
        emit SignersRotated(version, agentSigner_, policySigner_);
    }

    /// @notice Escape hatch: send `amount` to the provider's payout address fixed at deployment.
    ///         Not subject to the limits and does not count towards the daily cap. It can pay no
    ///         other address, so the operator key alone can never send funds to a third party.
    function withdrawToProvider(uint256 version, uint256 amount, bytes calldata operatorSig) external {
        if (amount == 0) revert ZeroAmount();
        _useOperatorSignature(version, keccak256(abi.encode(WITHDRAW_TYPEHASH, version, amount)), operatorSig);
        usdt.safeTransfer(providerPayout, amount);
        emit Withdrawn(version, providerPayout, amount);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Checks that `version` is the next one and that the operator signed `structHash`, then
    ///      consumes the version. Reverts otherwise.
    function _useOperatorSignature(uint256 version, bytes32 structHash, bytes calldata operatorSig) private {
        if (version != policyVersion + 1) revert WrongVersion(policyVersion + 1);
        if (ECDSA.recover(_hashTypedDataV4(structHash), operatorSig) != operator) revert InvalidOperatorSignature();
        policyVersion = version;
    }

    /// @dev The first limit a transfer breaks, or bytes32(0) if it breaks none.
    function _guardReason(address to, uint256 amount) private view returns (bytes32) {
        if (!allowedPayee[to]) return PAYEE_NOT_ALLOWED;
        if (amount > perTxCap) return OVER_PER_TX_CAP;
        if (spentOnDay[_today()] + amount > dailyCap) return OVER_DAILY_CAP;
        uint256 balance = usdt.balanceOf(address(this));
        if (amount > balance || balance - amount < minReserve) return BELOW_VAULT_RESERVE;
        return bytes32(0);
    }

    function _setSigners(address agentSigner_, address policySigner_) private {
        if (agentSigner_ == address(0) || policySigner_ == address(0)) revert ZeroAddress();
        if (agentSigner_ == policySigner_ || agentSigner_ == operator || policySigner_ == operator) {
            revert KeysNotDistinct();
        }
        agentSigner = agentSigner_;
        policySigner = policySigner_;
    }

    /// @dev UTC calendar day number.
    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }
}
