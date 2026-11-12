// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MilestoneEscrow
/// @notice Holds USDT per milestone, keyed by milestoneId. See docs/INTERFACES.md section 3.
///         Clean path:  createAndFund (FUNDER) -> approve (client) -> release (RELEASER) -> the vault of the provider.
///         Timeout:     refund to the funder once `timeout` has passed, while Funded or Disputed.
///         Dispute:     dispute (client or provider, only while Funded) -> decide with two of three
///                      EIP-712 attestations -> Approved or refunded. Undecided at the timeout: refund.
///         Rescue:      refundApproved returns an Approved milestone to the funder if it was never
///                      released (see that function), so funds cannot be stranded in Approved.
///         The identity-match hold is enforced by the backend before it calls `release`; it is
///         simulated and is NOT enforced on-chain.
contract MilestoneEscrow is AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    enum State { None, Funded, Approved, Disputed, Released, Refunded }

    struct Milestone {
        address funder;     // paid the escrow; receives any refund
        address client;     // approves, may dispute
        address provider;   // may dispute
        address arbiter;    // third attestation signer in a dispute
        address vault;      // vault of the provider; receives the release
        uint256 amount;     // USDT base units (6 decimals)
        uint64 timeout;     // unix time after which a refund is allowed; a dispute may push it out
        uint64 approvedAt;  // unix time of approval; start of the card hold
        uint32 holdSeconds; // chargeback hold, applied only when cardFunded
        bool cardFunded;
        State state;
    }

    /// @dev May create milestones. Held by the treasury: milestone ids, vaults and arbiters are chosen
    ///      by the backend, and nobody else can occupy a milestone id.
    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");
    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");
    /// @dev EIP-712 type signed by a party to settle a dispute. kind: 0 = client, 1 = provider, 2 = arbiter.
    ///      No nonce: the domain binds chain and contract, and a milestone is decided at most once.
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(bytes32 milestoneId,uint8 kind,bool releaseToProvider)");
    /// @dev A dispute leaves at least this long before the refund-by-timeout applies.
    uint64 public constant DISPUTE_WINDOW = 7 days;
    /// @dev A new milestone's timeout must be at least this far in the future.
    uint64 public constant MIN_TIMEOUT = 1 days;
    /// @dev Upper bound for the chargeback hold.
    uint32 public constant MAX_HOLD = 30 days;
    /// @dev After the hold, the releaser has this long to release before the funder may take the funds back.
    uint64 public constant RELEASE_GRACE = 3 days;

    IERC20 public immutable usdt;

    mapping(bytes32 => Milestone) private _milestones;

    event Funded(bytes32 indexed milestoneId, address indexed funder, uint256 amount, uint64 timeout, bool cardFunded);
    event Approved(bytes32 indexed milestoneId);
    event Disputed(bytes32 indexed milestoneId, address indexed by, uint64 timeout);
    event Released(bytes32 indexed milestoneId, address indexed vault, uint256 amount);
    event Refunded(bytes32 indexed milestoneId, address indexed to, uint256 amount);

    error MilestoneExists();
    error ZeroAddress();
    error InvalidAddress();
    error ZeroAmount();
    error PartiesNotDistinct();
    error TimeoutTooSoon(uint256 earliest);
    error HoldTooLong();
    error WrongState(State current);
    error NotClient();
    error NotParty();
    error HoldActive(uint256 releasableAt);
    error TimeoutNotReached(uint256 timeout);
    error TimeoutReached(uint256 timeout);
    error DisputeWindowOver(uint256 timeout);
    error NeedTwoAttestations();
    error DuplicateSigner();
    error InvalidAttestation(address signer);
    error RefundNotAllowed();

    constructor(IERC20 usdt_, address admin, address releaser, address funder) EIP712("TethranEscrow", "1") {
        if (address(usdt_) == address(0) || admin == address(0) || releaser == address(0) || funder == address(0)) {
            revert ZeroAddress();
        }
        usdt = usdt_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELEASER_ROLE, releaser);
        _grantRole(FUNDER_ROLE, funder);
    }

    /// @notice FUNDER only. Create a milestone and pull `amount` USDT from msg.sender (the funder).
    ///         The funder must have approved this contract for `amount` first.
    function createAndFund(
        bytes32 milestoneId,
        address client,
        address provider,
        address arbiter,
        address vault,
        uint256 amount,
        uint64 timeout,
        bool cardFunded,
        uint32 holdSeconds
    ) external onlyRole(FUNDER_ROLE) {
        if (_milestones[milestoneId].state != State.None) revert MilestoneExists();
        if (client == address(0) || provider == address(0) || arbiter == address(0) || vault == address(0)) {
            revert ZeroAddress();
        }
        // Funds or roles pointed at this contract or at the token could never be used.
        if (_isReserved(client) || _isReserved(provider) || _isReserved(arbiter) || _isReserved(vault)) {
            revert InvalidAddress();
        }
        if (client == provider || client == arbiter || provider == arbiter) revert PartiesNotDistinct();
        if (amount == 0) revert ZeroAmount();
        if (timeout < block.timestamp + MIN_TIMEOUT) revert TimeoutTooSoon(block.timestamp + MIN_TIMEOUT);
        if (holdSeconds > MAX_HOLD) revert HoldTooLong();

        _milestones[milestoneId] = Milestone({
            funder: msg.sender,
            client: client,
            provider: provider,
            arbiter: arbiter,
            vault: vault,
            amount: amount,
            timeout: timeout,
            approvedAt: 0,
            holdSeconds: holdSeconds,
            cardFunded: cardFunded,
            state: State.Funded
        });

        usdt.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(milestoneId, msg.sender, amount, timeout, cardFunded);
    }

    /// @notice Clean path. Only the client, before the timeout; Funded -> Approved.
    function approve(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Funded) revert WrongState(m.state);
        if (msg.sender != m.client) revert NotClient();
        if (block.timestamp >= m.timeout) revert TimeoutReached(m.timeout);

        m.state = State.Approved;
        m.approvedAt = uint64(block.timestamp);
        emit Approved(milestoneId);
    }

    /// @notice Client or provider, before the timeout; Funded -> Disputed. Not possible after approval:
    ///         the client's approval is final. The timeout is pushed out to at least
    ///         now + DISPUTE_WINDOW so the parties have time to decide; it is never shortened.
    function dispute(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Funded) revert WrongState(m.state);
        if (msg.sender != m.client && msg.sender != m.provider) revert NotParty();
        if (block.timestamp >= m.timeout) revert TimeoutReached(m.timeout);

        m.state = State.Disputed;
        uint64 windowEnd = uint64(block.timestamp) + DISPUTE_WINDOW;
        if (m.timeout < windowEnd) m.timeout = windowEnd;
        emit Disputed(milestoneId, msg.sender, m.timeout);
    }

    /// @notice Settle a dispute with two of three EIP-712 attestations (client, provider, arbiter).
    ///         Anyone may submit them; the signatures are the authority. Only while Disputed and
    ///         before the timeout (after it, the default refund applies).
    ///         releaseToProvider = true  -> Approved (the card hold, if any, starts now).
    ///         releaseToProvider = false -> refund to the funder in this transaction.
    /// @param sigs    exactly two signatures; sigs[i] was made by signers[i]
    /// @param signers exactly two different parties of this milestone
    function decide(
        bytes32 milestoneId,
        bool releaseToProvider,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Disputed) revert WrongState(m.state);
        if (block.timestamp >= m.timeout) revert DisputeWindowOver(m.timeout);
        if (sigs.length != 2 || signers.length != 2) revert NeedTwoAttestations();
        // Parties are distinct (checked at creation), so two different signers are two different parties.
        if (signers[0] == signers[1]) revert DuplicateSigner();

        for (uint256 i = 0; i < 2; i++) {
            uint8 kind = _kindOf(m, signers[i]);
            bytes32 digest = _hashTypedDataV4(
                keccak256(abi.encode(ATTESTATION_TYPEHASH, milestoneId, kind, releaseToProvider))
            );
            if (ECDSA.recover(digest, sigs[i]) != signers[i]) revert InvalidAttestation(signers[i]);
        }

        if (releaseToProvider) {
            m.state = State.Approved;
            m.approvedAt = uint64(block.timestamp);
            emit Approved(milestoneId);
        } else {
            _refund(milestoneId, m);
        }
    }

    /// @notice RELEASER only (treasury/backend, after its identity check). Approved -> Released.
    ///         A card-funded milestone must also have passed its chargeback hold.
    function release(bytes32 milestoneId) external onlyRole(RELEASER_ROLE) {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Approved) revert WrongState(m.state);
        uint256 holdEnd = _holdEnd(m);
        if (block.timestamp < holdEnd) revert HoldActive(holdEnd);

        m.state = State.Released;
        usdt.safeTransfer(m.vault, m.amount);
        emit Released(milestoneId, m.vault, m.amount);
    }

    /// @notice Anyone, once the timeout has passed, while Funded or Disputed. Pays the funder.
    function refund(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Funded && m.state != State.Disputed) revert WrongState(m.state);
        if (block.timestamp < m.timeout) revert TimeoutNotReached(m.timeout);

        _refund(milestoneId, m);
    }

    /// @notice Return an Approved milestone to the funder. Two cases, nothing else:
    ///         1. Chargeback: the RELEASER, only while the card hold is still running.
    ///         2. Rescue: the funder, once the hold plus RELEASE_GRACE has passed without a release
    ///            (for example the releaser key was lost, or the identity hold never cleared).
    ///         Between the end of the hold and the end of the grace period only `release` is possible.
    function refundApproved(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Approved) revert WrongState(m.state);
        uint256 holdEnd = _holdEnd(m);
        bool chargeback = hasRole(RELEASER_ROLE, msg.sender) && block.timestamp < holdEnd;
        bool rescue = msg.sender == m.funder && block.timestamp >= holdEnd + RELEASE_GRACE;
        if (!chargeback && !rescue) revert RefundNotAllowed();

        _refund(milestoneId, m);
    }

    function state(bytes32 milestoneId) external view returns (State) {
        return _milestones[milestoneId].state;
    }

    function milestone(bytes32 milestoneId) external view returns (Milestone memory) {
        return _milestones[milestoneId];
    }

    /// @dev Marks the milestone Refunded and pays the funder. Callers have checked the state.
    function _refund(bytes32 milestoneId, Milestone storage m) private {
        m.state = State.Refunded;
        usdt.safeTransfer(m.funder, m.amount);
        emit Refunded(milestoneId, m.funder, m.amount);
    }

    /// @dev End of the chargeback hold of an Approved milestone. No hold unless card-funded.
    function _holdEnd(Milestone storage m) private view returns (uint256) {
        return uint256(m.approvedAt) + (m.cardFunded ? m.holdSeconds : 0);
    }

    function _isReserved(address a) private view returns (bool) {
        return a == address(this) || a == address(usdt);
    }

    /// @dev Attestation kind of a party: 0 = client, 1 = provider, 2 = arbiter. Reverts for anyone else.
    function _kindOf(Milestone storage m, address signer) private view returns (uint8) {
        if (signer == m.client) return 0;
        if (signer == m.provider) return 1;
        if (signer == m.arbiter) return 2;
        revert NotParty();
    }
}
