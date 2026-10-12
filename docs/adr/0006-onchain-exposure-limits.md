# ADR-0006: On-chain Exposure Limits

- **Status:** Accepted
- **Date:** 2026-10-12
- **Scope:** POC / testnet; revisit before real-money MVP (#23)
- **Issue:** #18

## Context

ADR-0005 fixes POC economics at 1 test USDC × max 10 completions. The API validates `maxCompletions <= 10`, but anyone can call `CampaignManager.createCampaign` directly, so API validation is not a financial security boundary.

## Decision

`CampaignManager` takes three **immutable constructor parameters** and enforces them in `createCampaign` (and re-checks the budget in `fundCampaign` before narrowing to `uint128`):

| Limit | POC / testnet value | Enforced as |
| --- | ---: | --- |
| `maxRewardPerCompletion` | 1 USDC (`1_000_000`) | `rewardPerCompletion <= limit` → `RewardAboveLimit` |
| `maxCompletionsPerCampaign` | 10 | `maxCompletions <= limit` → `CompletionsAboveLimit` |
| `maxCampaignBudget` | 10 USDC (`10_000_000`) | `reward × completions <= limit` → `BudgetAboveLimit` |

The constructor rejects zero limits and `maxCampaignBudget < maxRewardPerCompletion` (`InvalidExposureLimits`).

Related hardening in the same change:

- `fundCampaign` reverts with `CampaignAlreadyEnded` once `block.timestamp >= endTime`, so an expired draft cannot become an active funded campaign.
- `cancelCampaign` lets the advertiser move an **unfunded** `Draft` to `Cancelled` (`CampaignCancelled` event). No funds move; funded campaigns still follow close/refund.

## Why immutable, not owner-adjustable

- No new privileged setter, so an owner-key compromise cannot raise exposure.
- No proxy upgradeability in the POC (CONTRACT_SPEC). Raising limits means deploying a new `CampaignManager`, which is an explicit, reviewable event.

## Consequences

- Deployment scripts and configs must pass the limits explicitly and record them in deployment output (#19).
- Real-money MVP needs a separate decision on per-campaign, global, and daily payout limits (#23). Global/daily limits are not covered here.
