// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract CampaignManager {
    enum CampaignStatus {
        Draft,
        Active,
        Closed,
        Expired,
        Settled,
        Cancelled
    }

    struct Campaign {
        address advertiser;
        uint128 fundedBudget;
        uint128 paidRewards;
        uint96 rewardPerCompletion;
        uint32 maxCompletions;
        uint32 paidCompletions;
        uint64 startTime;
        uint64 endTime;
        uint64 closedAt;
        CampaignStatus status;
    }

    struct ClaimAuthorization {
        uint256 campaignId;
        address claimant;
        uint256 amount;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    error Unauthorized();
    error ZeroAddress();
    error Paused();
    error InvalidCampaign();
    error InvalidCampaignWindow();
    error InvalidReward();
    error InvalidCompletionLimit();
    error InvalidCampaignStatus();
    error InvalidFundingAmount();
    error AlreadyFunded();
    error CampaignAlreadyEnded();
    error CampaignNotClaimable();
    error WrongClaimant();
    error InvalidClaimAmount();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationLifetimeTooLong();
    error AuthorizationIssuedAfterDeadline();
    error NonceAlreadyUsed();
    error WalletAlreadyClaimed();
    error CompletionLimitReached();
    error InsufficientCampaignBudget();
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error InvalidSignature();
    error RefundNotAvailable();
    error TokenTransferFailed();

    event CampaignCreated(uint256 indexed campaignId, address indexed advertiser);
    event CampaignFunded(uint256 indexed campaignId, uint256 amount);
    event RewardClaimed(uint256 indexed campaignId, address indexed claimant, uint256 amount, bytes32 nonce);
    event CampaignClosed(uint256 indexed campaignId);
    event CampaignRefunded(uint256 indexed campaignId, uint256 amount);
    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event PausedStateChanged(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    uint64 public constant MIN_CAMPAIGN_DURATION = 15 minutes;
    uint64 public constant MAX_CAMPAIGN_DURATION = 24 hours;
    uint64 public constant MAX_AUTHORIZATION_TTL = 15 minutes;

    bytes32 public constant CLAIM_AUTHORIZATION_TYPEHASH = keccak256(
        "ClaimAuthorization(uint256 campaignId,address claimant,uint256 amount,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Verified Human Attention Market");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable rewardToken;

    address public owner;
    address public authorizedSigner;
    bool public paused;
    uint256 public campaignCount;

    mapping(uint256 => Campaign) public campaigns;
    mapping(bytes32 => bool) public consumedNonces;
    mapping(uint256 => mapping(address => bool)) public claimedWallet;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(address rewardToken_, address authorizedSigner_) {
        if (rewardToken_ == address(0) || authorizedSigner_ == address(0)) {
            revert ZeroAddress();
        }

        rewardToken = IERC20(rewardToken_);
        authorizedSigner = authorizedSigner_;
        owner = msg.sender;

        emit OwnershipTransferred(address(0), msg.sender);
        emit SignerUpdated(address(0), authorizedSigner_);
    }

    function createCampaign(uint96 rewardPerCompletion, uint32 maxCompletions, uint64 startTime, uint64 endTime)
        external
        whenNotPaused
        returns (uint256 campaignId)
    {
        if (rewardPerCompletion == 0) revert InvalidReward();
        if (maxCompletions == 0) revert InvalidCompletionLimit();
        if (startTime < block.timestamp || endTime <= startTime) {
            revert InvalidCampaignWindow();
        }

        uint256 duration = uint256(endTime) - uint256(startTime);
        if (duration < MIN_CAMPAIGN_DURATION || duration > MAX_CAMPAIGN_DURATION) {
            revert InvalidCampaignWindow();
        }

        campaignId = ++campaignCount;

        campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            fundedBudget: 0,
            paidRewards: 0,
            rewardPerCompletion: rewardPerCompletion,
            maxCompletions: maxCompletions,
            paidCompletions: 0,
            startTime: startTime,
            endTime: endTime,
            closedAt: 0,
            status: CampaignStatus.Draft
        });

        emit CampaignCreated(campaignId, msg.sender);
    }

    function fundCampaign(uint256 campaignId, uint256 amount) external whenNotPaused {
        Campaign storage campaign = _campaign(campaignId);

        if (msg.sender != campaign.advertiser) revert Unauthorized();
        if (campaign.status != CampaignStatus.Draft) revert InvalidCampaignStatus();
        if (campaign.fundedBudget != 0) revert AlreadyFunded();

        uint256 requiredBudget = uint256(campaign.rewardPerCompletion) * uint256(campaign.maxCompletions);
        if (amount != requiredBudget) revert InvalidFundingAmount();

        campaign.fundedBudget = uint128(amount);
        campaign.status = CampaignStatus.Active;

        _safeTransferFrom(msg.sender, address(this), amount);

        emit CampaignFunded(campaignId, amount);
    }

    function claim(ClaimAuthorization calldata authorization, bytes calldata signature) external whenNotPaused {
        Campaign storage campaign = _campaign(authorization.campaignId);

        if (campaign.status != CampaignStatus.Active && campaign.status != CampaignStatus.Closed) {
            revert CampaignNotClaimable();
        }
        if (authorization.claimant != msg.sender) revert WrongClaimant();
        if (authorization.amount != campaign.rewardPerCompletion) {
            revert InvalidClaimAmount();
        }
        if (authorization.issuedAt > block.timestamp) {
            revert AuthorizationNotYetValid();
        }
        if (authorization.expiresAt <= block.timestamp) {
            revert AuthorizationExpired();
        }
        if (
            authorization.expiresAt <= authorization.issuedAt
                || uint256(authorization.expiresAt) - uint256(authorization.issuedAt) > MAX_AUTHORIZATION_TTL
        ) {
            revert AuthorizationLifetimeTooLong();
        }

        uint64 issuanceDeadline = campaign.closedAt == 0 ? campaign.endTime : campaign.closedAt;
        if (authorization.issuedAt < campaign.startTime || authorization.issuedAt > issuanceDeadline) {
            revert AuthorizationIssuedAfterDeadline();
        }

        if (consumedNonces[authorization.nonce]) revert NonceAlreadyUsed();
        if (claimedWallet[authorization.campaignId][msg.sender]) {
            revert WalletAlreadyClaimed();
        }
        if (campaign.paidCompletions >= campaign.maxCompletions) {
            revert CompletionLimitReached();
        }

        uint256 nextPaidRewards = uint256(campaign.paidRewards) + authorization.amount;
        if (nextPaidRewards > campaign.fundedBudget) {
            revert InsufficientCampaignBudget();
        }

        bytes32 digest = hashClaimAuthorization(authorization);
        if (_recover(digest, signature) != authorizedSigner) {
            revert InvalidSignature();
        }

        consumedNonces[authorization.nonce] = true;
        claimedWallet[authorization.campaignId][msg.sender] = true;
        campaign.paidRewards = uint128(nextPaidRewards);
        campaign.paidCompletions += 1;

        _safeTransfer(msg.sender, authorization.amount);

        emit RewardClaimed(authorization.campaignId, msg.sender, authorization.amount, authorization.nonce);
    }

    function closeCampaign(uint256 campaignId) external {
        Campaign storage campaign = _campaign(campaignId);

        if (msg.sender != campaign.advertiser) revert Unauthorized();
        if (campaign.status != CampaignStatus.Active) revert InvalidCampaignStatus();
        if (block.timestamp >= campaign.endTime) revert CampaignAlreadyEnded();

        campaign.closedAt = uint64(block.timestamp);
        campaign.status = CampaignStatus.Closed;

        emit CampaignClosed(campaignId);
    }

    function refundUnusedBudget(uint256 campaignId) external whenNotPaused {
        Campaign storage campaign = _campaign(campaignId);

        if (msg.sender != campaign.advertiser) revert Unauthorized();
        if (campaign.status != CampaignStatus.Active && campaign.status != CampaignStatus.Closed) {
            revert InvalidCampaignStatus();
        }

        uint64 issuanceDeadline = campaign.closedAt == 0 ? campaign.endTime : campaign.closedAt;

        if (block.timestamp <= uint256(issuanceDeadline) + MAX_AUTHORIZATION_TTL) {
            revert RefundNotAvailable();
        }

        uint256 refundAmount = uint256(campaign.fundedBudget) - uint256(campaign.paidRewards);
        campaign.status = CampaignStatus.Settled;

        if (refundAmount != 0) {
            _safeTransfer(campaign.advertiser, refundAmount);
        }

        emit CampaignRefunded(campaignId, refundAmount);
    }

    function pause() external onlyOwner {
        paused = true;
        emit PausedStateChanged(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedStateChanged(false);
    }

    function setAuthorizedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();

        address previousSigner = authorizedSigner;
        authorizedSigner = newSigner;

        emit SignerUpdated(previousSigner, newSigner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function statusOf(uint256 campaignId) external view returns (CampaignStatus) {
        Campaign storage campaign = _campaign(campaignId);

        if (campaign.status == CampaignStatus.Active && block.timestamp >= campaign.endTime) {
            return CampaignStatus.Expired;
        }

        return campaign.status;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashClaimAuthorization(ClaimAuthorization calldata authorization) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_AUTHORIZATION_TYPEHASH,
                authorization.campaignId,
                authorization.claimant,
                authorization.amount,
                authorization.nonce,
                authorization.issuedAt,
                authorization.expiresAt
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _campaign(uint256 campaignId) private view returns (Campaign storage campaign) {
        campaign = campaigns[campaignId];
        if (campaign.advertiser == address(0)) revert InvalidCampaign();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (uint256(s) > uint256(SECP256K1N_HALF)) revert InvalidSignatureS();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignatureV();

        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory returnData) =
            address(rewardToken).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool success, bytes memory returnData) =
            address(rewardToken).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
