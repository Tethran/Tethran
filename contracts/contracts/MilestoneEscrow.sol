// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MilestoneEscrow
/// @notice Holds USDT per milestone, keyed by milestoneId. See docs/INTERFACES.md section 3.
///         Clean path:  createAndFund -> approve (client) -> release (RELEASER) -> the vault of the provider.
///         Timeout:     refund to the funder once `timeout` has passed, while Funded or Disputed.
///         The identity-match hold is enforced by the backend before it calls `release`; it is
///         simulated and is NOT enforced on-chain.
///         `decide` (two of three EIP-712 attestations) is added in the next commit.
contract MilestoneEscrow is AccessControl {
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

    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");
    /// @dev A dispute leaves at least this long before the refund-by-timeout applies.
    uint64 public constant DISPUTE_WINDOW = 7 days;

    IERC20 public immutable usdt;

    mapping(bytes32 => Milestone) private _milestones;

    event Funded(bytes32 indexed milestoneId, address indexed funder, uint256 amount, uint64 timeout, bool cardFunded);
    event Approved(bytes32 indexed milestoneId);
    event Disputed(bytes32 indexed milestoneId, address indexed by, uint64 timeout);
    event Released(bytes32 indexed milestoneId, address indexed vault, uint256 amount);
    event Refunded(bytes32 indexed milestoneId, address indexed to, uint256 amount);

    error MilestoneExists();
    error ZeroAddress();
    error ZeroAmount();
    error PartiesNotDistinct();
    error TimeoutInPast();
    error WrongState(State current);
    error NotClient();
    error NotParty();
    error HoldActive(uint256 releasableAt);
    error TimeoutNotReached(uint256 timeout);

    constructor(IERC20 usdt_, address admin, address releaser) {
        if (address(usdt_) == address(0) || admin == address(0) || releaser == address(0)) revert ZeroAddress();
        usdt = usdt_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELEASER_ROLE, releaser);
    }

    /// @notice Create a milestone and pull `amount` USDT from msg.sender (the funder).
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
    ) external {
        if (_milestones[milestoneId].state != State.None) revert MilestoneExists();
        if (client == address(0) || provider == address(0) || arbiter == address(0) || vault == address(0)) {
            revert ZeroAddress();
        }
        if (client == provider || client == arbiter || provider == arbiter) revert PartiesNotDistinct();
        if (amount == 0) revert ZeroAmount();
        if (timeout <= block.timestamp) revert TimeoutInPast();

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

    /// @notice Clean path. Only the client; Funded -> Approved.
    function approve(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Funded) revert WrongState(m.state);
        if (msg.sender != m.client) revert NotClient();

        m.state = State.Approved;
        m.approvedAt = uint64(block.timestamp);
        emit Approved(milestoneId);
    }

    /// @notice Client or provider; Funded -> Disputed. Not possible after approval: the client's
    ///         approval is final. The timeout is pushed out to at least now + DISPUTE_WINDOW so the
    ///         parties have time to decide; it is never shortened.
    function dispute(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Funded) revert WrongState(m.state);
        if (msg.sender != m.client && msg.sender != m.provider) revert NotParty();

        m.state = State.Disputed;
        uint64 windowEnd = uint64(block.timestamp) + DISPUTE_WINDOW;
        if (m.timeout < windowEnd) m.timeout = windowEnd;
        emit Disputed(milestoneId, msg.sender, m.timeout);
    }

    /// @notice RELEASER only (treasury/backend, after its identity check). Approved -> Released.
    ///         A card-funded milestone must also have passed its chargeback hold.
    function release(bytes32 milestoneId) external onlyRole(RELEASER_ROLE) {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Approved) revert WrongState(m.state);
        if (m.cardFunded) {
            uint256 releasableAt = uint256(m.approvedAt) + m.holdSeconds;
            if (block.timestamp < releasableAt) revert HoldActive(releasableAt);
        }

        m.state = State.Released;
        usdt.safeTransfer(m.vault, m.amount);
        emit Released(milestoneId, m.vault, m.amount);
    }

    /// @notice Anyone, once the timeout has passed, while Funded or Disputed. Pays the funder.
    function refund(bytes32 milestoneId) external {
        Milestone storage m = _milestones[milestoneId];
        if (m.state != State.Funded && m.state != State.Disputed) revert WrongState(m.state);
        if (block.timestamp < m.timeout) revert TimeoutNotReached(m.timeout);

        m.state = State.Refunded;
        usdt.safeTransfer(m.funder, m.amount);
        emit Refunded(milestoneId, m.funder, m.amount);
    }

    function state(bytes32 milestoneId) external view returns (State) {
        return _milestones[milestoneId].state;
    }

    function milestone(bytes32 milestoneId) external view returns (Milestone memory) {
        return _milestones[milestoneId];
    }
}
