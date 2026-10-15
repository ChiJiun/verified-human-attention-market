# Smart Contract Specification

> Status: System Design  
> Target: POC → MVP

## Design Goal

Keep the financial layer small, deterministic, and independently testable.

## Proposed Contracts

### 1. CampaignFactory

Responsibilities:

- create campaign instances/records;
- emit canonical campaign-created event;
- maintain approved implementation/configuration references if required.

### 2. CampaignEscrow / CampaignManager

For the first implementation, **CampaignEscrow and lifecycle management may be one contract** to reduce deployment and call complexity.

Responsibilities:

- accept approved USDC;
- track funded budget;
- track paid rewards;
- track campaign lifecycle;
- close/expire campaign;
- refund unused funds.

### 3. RewardDistributor

May be integrated into CampaignEscrow for POC, or separated if tests show the boundary is valuable.

Responsibilities:

- verify EIP-712 authorization;
- consume nonce;
- enforce campaign state and budget;
- transfer reward token;
- emit claim event.

## Recommended POC Simplification

Start with:

```
CampaignManager
  ├─ createCampaign
  ├─ fundCampaign
  ├─ claim
  ├─ closeCampaign
  ├─ refund
  └─ pause
```

Do not split into multiple deployed contracts until the interfaces justify it.

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
    uint256 amount
) external;

function claim(
    ClaimAuthorization calldata authorization,
    bytes calldata signature
) external;

function cancelCampaign(uint256 campaignId) external; // unfunded Draft only

function closeCampaign(uint256 campaignId) external;

function refundUnusedBudget(uint256 campaignId) external;

function pause() external;
function unpause() external;
```

## Exposure Limits (ADR-0006)

Immutable constructor parameters bound every campaign:

- `maxRewardPerCompletion`
- `maxCompletionsPerCampaign`
- `maxCampaignBudget` (`reward × completions`)

`createCampaign` reverts with `RewardAboveLimit`, `CompletionsAboveLimit`, or `BudgetAboveLimit`, with `InvalidDraftRef` for a zero reference, and with `DraftAlreadyCreated(campaignId)` when the sender already created a campaign for that reference (ADR-0011). `fundCampaign` rejects campaigns whose `endTime` has passed. `cancelCampaign` cancels an unfunded draft. `claim` reverts with `WrongDraft` unless `campaignIdByDraft[advertiser][authorization.draftRef] == authorization.campaignId`, so an authorization never pays from a campaign created for another draft (ADR-0011; EIP-712 type in CLAIM_AUTHORIZATION.md).

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
event SignerUpdated(address indexed previousSigner, address indexed newSigner);
```

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

- advertiser controls own campaign close/cancel where permitted;
- protocol admin can pause;
- authorized signer can only authorize claims, not withdraw funds;
- admin should not have arbitrary campaign-withdraw authority.

## Token Scope

POC/MVP supports exactly one configured USDC token address.

Arbitrary ERC-20 reward tokens are out of scope.

## Upgradeability

Do not introduce proxy upgradeability for POC.

If production later requires upgradeability, create a separate ADR after threat modeling governance and upgrade keys.
