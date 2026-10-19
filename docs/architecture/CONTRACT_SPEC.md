# Smart Contract Specification

> Status: System Design  
> Target: POC → MVP
>
> Reconciled with `packages/contracts/src/CampaignManager.sol`: 2026-10-19

## Design Goal

Keep the financial layer small, deterministic, and independently testable.

## Contract Layout

The design once foresaw three contracts (a factory, an escrow and a reward distributor). The implementation is **one contract, `CampaignManager`**, which holds all three responsibilities: campaign records and the canonical creation event, USDC escrow and lifecycle, and EIP-712 claim verification with payout. Splitting it is not planned until an interface boundary proves valuable.

```
CampaignManager
  ├─ createCampaign(reward, maxCompletions, startTime, endTime, draftRef)
  ├─ fundCampaign(campaignId, amount, draftRef)
  ├─ claim(authorization, signature)
  ├─ closeCampaign(campaignId)
  ├─ cancelCampaign(campaignId)          // unfunded draft only
  ├─ refundUnusedBudget(campaignId)
  ├─ pause() / unpause()                 // owner
  ├─ setAuthorizedSigner(newSigner)      // owner
  ├─ transferOwnership(newOwner)         // owner
  └─ views: campaigns, campaignIdByDraft, consumedNonces, claimedWallet,
            statusOf, domainSeparator, hashClaimAuthorization,
            rewardToken, authorizedSigner, owner, paused, campaignCount,
            maxRewardPerCompletion, maxCompletionsPerCampaign, maxCampaignBudget
```

Constants: `MIN_CAMPAIGN_DURATION = 15 minutes`, `MAX_CAMPAIGN_DURATION = 24 hours`, `MAX_AUTHORIZATION_TTL = 15 minutes`, EIP-712 domain name `Verified Human Attention Market`, version `1`.

## Campaign Struct

```solidity
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
```

Exact packing may change during implementation after tests.

## External Functions

```solidity
function createCampaign(
    uint96 rewardPerCompletion,
    uint32 maxCompletions,
    uint64 startTime,
    uint64 endTime,
    bytes32 draftRef // ADR-0011: one campaign per (advertiser, draftRef)
) external returns (uint256 campaignId);

function campaignIdByDraft(address advertiser, bytes32 draftRef)
    external view returns (uint256); // 0 = none

function fundCampaign(
    uint256 campaignId,
    uint256 amount,
    bytes32 draftRef // ADR-0011: must name campaignId for msg.sender
) external;

function claim(
    ClaimAuthorization calldata authorization,
    bytes calldata signature
) external;

function cancelCampaign(uint256 campaignId) external; // unfunded Draft only

function closeCampaign(uint256 campaignId) external;

function refundUnusedBudget(uint256 campaignId) external;

function pause() external;                                // owner
function unpause() external;                              // owner
function setAuthorizedSigner(address newSigner) external; // owner
function transferOwnership(address newOwner) external;    // owner

function statusOf(uint256 campaignId) external view returns (CampaignStatus); // Active past endTime reads as Expired
function domainSeparator() external view returns (bytes32);
function hashClaimAuthorization(ClaimAuthorization calldata a) external view returns (bytes32);
```

`whenNotPaused` guards `createCampaign`, `fundCampaign`, `claim` and `refundUnusedBudget`. `closeCampaign` and `cancelCampaign` are not paused: an advertiser can always stop new issuance.

## Exposure Limits (ADR-0006)

Immutable constructor parameters bound every campaign:

- `maxRewardPerCompletion`
- `maxCompletionsPerCampaign`
- `maxCampaignBudget` (`reward × completions`)

`createCampaign` reverts with `InvalidReward` / `InvalidCompletionLimit` for zero values, `RewardAboveLimit`, `CompletionsAboveLimit`, or `BudgetAboveLimit`, `InvalidCampaignWindow` when `startTime < block.timestamp`, `endTime <= startTime` or the duration is outside 15 minutes – 24 hours, `InvalidDraftRef` for a zero reference, and `DraftAlreadyCreated(campaignId)` when the sender already created a campaign for that reference (ADR-0011). `fundCampaign` requires exactly `rewardPerCompletion × maxCompletions` (`InvalidFundingAmount`), a `Draft` that is not funded yet (`InvalidCampaignStatus`, `AlreadyFunded`), rejects campaigns whose `endTime` has passed (`CampaignAlreadyEnded`) and reverts with `WrongDraft` unless `campaignIdByDraft[msg.sender][draftRef] == campaignId`, so after a deep reorg an advertiser cannot fund another of their drafts that took the same id (ADR-0011). `cancelCampaign` cancels an unfunded draft. `claim` reverts with `WrongDraft` unless `campaignIdByDraft[advertiser][authorization.draftRef] == authorization.campaignId`, so an authorization never pays from a campaign created for another draft (ADR-0011; EIP-712 type in CLAIM_AUTHORIZATION.md).

## Events

```solidity
event CampaignCreated(uint256 indexed campaignId, address indexed advertiser, bytes32 indexed draftRef);
event CampaignFunded(uint256 indexed campaignId, uint256 amount);
event RewardClaimed(
    uint256 indexed campaignId,
    address indexed claimant,
    uint256 amount,
    bytes32 nonce
);
event CampaignClosed(uint256 indexed campaignId);
event CampaignRefunded(uint256 indexed campaignId, uint256 amount);
event CampaignCancelled(uint256 indexed campaignId);
event SignerUpdated(address indexed previousSigner, address indexed newSigner);
event PausedStateChanged(bool paused);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

Topics and function selectors are pinned in `test/EventTopics.t.sol` and derived at runtime from the exported ABI by the API (`apps/api/src/chain/abi.ts`).

## Core Invariants

### INV-001 Budget Conservation

```
paidRewards + refundableBalance <= fundedBudget
```

### INV-002 Replay Safety

Consumed authorization nonce can never succeed again.

### INV-003 Completion Bound

```
paidCompletions <= maxCompletions
```

### INV-004 Reward Bound

For the first mission type:

```
authorization.amount == campaign.rewardPerCompletion
```

### INV-005 Refund Safety

The contract enforces a maximum authorization TTL. A refund is permitted only after the campaign's issuance deadline (manual `closedAt` or natural `endTime`) plus that TTL. At that point no valid pre-close authorization can remain unexpired.

This avoids pretending that an off-chain signed authorization is an on-chain `reservedLiability` before it is submitted.

## Access Control

- advertiser controls own campaign fund/close/cancel/refund;
- the owner can only `pause` / `unpause`, rotate the signer and transfer ownership (ADR-0008); there is no owner withdrawal path and the exposure limits are immutable (ADR-0006);
- the authorized signer can only authorize claims, not withdraw funds;
- a participant can only be paid to `msg.sender` and only once per campaign.

## Token Scope

POC/MVP supports exactly one configured USDC token address.

Arbitrary ERC-20 reward tokens are out of scope.

## Upgradeability

Do not introduce proxy upgradeability for POC.

If production later requires upgradeability, create a separate ADR after threat modeling governance and upgrade keys.
