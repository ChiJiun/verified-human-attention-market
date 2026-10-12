# API Specification v0

> Status: System Design  
> Style: REST/JSON  
> Authentication details may evolve before implementation.

## Conventions

- Base path: `/v1`
- JSON only
- Mutating endpoints that create durable state require or accept `Idempotency-Key`; repeated keys with identical normalized input return the original result, while changed input returns a conflict.
- Dates/times use RFC 3339 externally.
- Monetary integer fields use atomic units or explicit decimal strings; never floating-point JSON numbers for settlement.

# Campaigns

## POST /v1/campaigns

Create off-chain campaign draft / metadata.

Headers:

```
Idempotency-Key: <client-generated unique key>
```

For the same advertiser, retrying the same normalized request with the same key returns the existing campaign. Reusing the key with different input returns `409 IDEMPOTENCY_CONFLICT`.

Request:

```json
{
  "advertiser": "0x...",
  "contentUrl": "https://example.com/article",
  "rewardPerCompletion": "1000000",
  "maxCompletions": 10,
  "startAt": "2026-10-05T12:00:00+08:00",
  "endAt": "2026-10-05T18:00:00+08:00",
  "mission": {
    "questions": [
      {
        "id": "q1",
        "prompt": "Which feature did the article highlight?",
        "choices": [
          { "id": "a", "label": "Speed" },
          { "id": "b", "label": "Price" }
        ]
      }
    ],
    "answerKey": { "q1": "a" },
    "passThreshold": 1
  }
}
```

- `contentUrl` must be `https:`; `javascript:`, `data:`, `file:` and plain `http:` are rejected.
- `mission` (ADR-0002 comprehension check): 1–3 questions, 2–6 choices each, identifiers `[A-Za-z0-9_-]{1,32}`. `answerKey` must name a valid choice for every question. `passThreshold` defaults to the number of questions (all correct).
- Campaign and mission version 1 are stored in one transaction. Missions are immutable (DB trigger); a change requires a new version. The mission is part of the idempotency hash, and answer-key ordering does not matter.

Response:

```json
{
  "id": "cmp_...",
  "status": "draft"
}
```

## GET /v1/campaigns/:id

Returns normalized off-chain + indexed on-chain state.

## GET /v1/campaigns/:id/mission

Public mission payload for participants. **Never** includes `answerKey` or `passThreshold`.

```json
{
  "missionId": "uuid",
  "campaignId": "uuid",
  "version": 1,
  "kind": "comprehension_check",
  "contentUrl": "https://example.com/article",
  "questions": [
    { "id": "q1", "prompt": "...", "choices": [{ "id": "a", "label": "Speed" }] }
  ]
}
```

Unknown or malformed campaign ids return `404`.

## POST /v1/campaigns/:id/publish

Returns the on-chain transaction intent for a `draft` (no state change): `createCampaign(reward, maxCompletions, startTime, endTime)` on `CampaignManager`, `approve(CampaignManager, budget)` on USDC, then `fundCampaign(campaignId, budget)`. Returns `409 CAMPAIGN_START_PASSED` once `startAt` has passed (the contract would reject it), and `503 CHAIN_NOT_CONFIGURED` without chain config.

## POST /v1/campaigns/:id/onchain

Body: `{ "txHash": "0x…" }` of the advertiser's `createCampaign` transaction (issue #16).

The client's report is never trusted. The API fetches the receipt, requires a `CampaignCreated` log from the configured contract with the draft's advertiser, and reads `campaigns(id)` via `eth_call` to require identical reward, completion cap and window. Then it links `onchain_campaign_id` (`UNIQUE(chain_id, onchain_campaign_id)`) with status `pending_onchain`.

| Status | Meaning |
| --- | --- |
| 200 | linked (idempotent for the same `txHash`) |
| 202 `TX_PENDING`, 503 `RPC_UNAVAILABLE` | `{ "status": "reconciling" }`: retry later. **Never** treat it as failure or create/fund again. |
| 409 | `ALREADY_LINKED`, `ONCHAIN_CAMPAIGN_ALREADY_LINKED`, `WRONG_CHAIN` |
| 422 | `TX_REVERTED`, `NO_CAMPAIGN_CREATED_EVENT`, `ADVERTISER_MISMATCH`, `PARAMETERS_MISMATCH` |

If the hash is never reported (e.g. the browser closed after broadcast), the indexer worker links a confirmed `CampaignCreated` to the advertiser's **single** unlinked draft with identical economics. Ambiguous matches are logged for manual resolution.

Lifecycle status (`active`, `closed`, `settled`, `cancelled`) is derived only from **confirmed** chain events by the indexer worker. Submissions are accepted only while `active`.

# World ID / Eligibility

## POST /v1/campaigns/:id/eligibility/verify

See ADR-0007. Request:

```json
{
  "claimant": "0x...",
  "idkitResponse": { "protocol_version": "4.0", "action": "vham-campaign-<campaignId>", "...": "forwarded unchanged" }
}
```

Backend:

1. checks `idkitResponse.action == "vham-campaign-<campaignId>"` and the environment;
2. verifies via `POST https://developer.world.org/api/v4/verify/{rp_id}`;
3. stores only `HMAC(PARTICIPANT_KEY_SECRET, campaignId ‖ nullifier)` plus the claimant wallet;
4. returns an opaque eligibility token.

Responses:

| Status | Body / code |
| --- | --- |
| 201 / 200 (replay) | `{ "eligibilityToken", "campaignId", "claimant", "expiresAt" }` |
| 400 | `INVALID_ELIGIBILITY_REQUEST`, `INVALID_PROOF_PAYLOAD` |
| 403 | `VERIFICATION_FAILED`, `ACTION_MISMATCH`, `ENVIRONMENT_MISMATCH` |
| 404 | `CAMPAIGN_NOT_FOUND` |
| 409 | `CAMPAIGN_NOT_OPEN`, `PARTICIPANT_WALLET_MISMATCH`, `WALLET_ALREADY_BOUND` |
| 503 | `WORLD_ID_NOT_CONFIGURED`, `PROVIDER_UNAVAILABLE` |

Proof payloads are never echoed, logged, or persisted.

Do not hard-code external provider request schemas into public client types more than necessary.

# Submissions

## POST /v1/campaigns/:id/submissions

Headers:

```
Idempotency-Key: <uuid>
```

Request:

```json
{
  "eligibilityToken": "<uuid from eligibility/verify>",
  "claimant": "0x...",
  "answers": [
    {"questionId": "q1", "choiceId": "b"}
  ]
}
```

Answers are choice ids only (`{"questionId": "q1", "choiceId": "a"}`); no free text in the POC.

Engagement verifier rejection codes (deterministic, see `apps/api/src/missions/verifier.ts`):

| Code | Meaning |
| --- | --- |
| `CAMPAIGN_NOT_ACTIVE` | campaign is not active/funded (draft, closed, expired, settled) |
| `CAMPAIGN_NOT_STARTED` | before `startAt` |
| `CAMPAIGN_ENDED` | at or after `endAt`; no new liabilities |
| `MALFORMED_ANSWERS` | wrong shape, unknown/duplicate question, unknown choice |
| `MISSING_ANSWERS` | not every question answered |
| `COMPREHENSION_FAILED` | fewer correct answers than `passThreshold` |

Implemented flow (`apps/api/src/submissions/service.ts`):

1. Same `Idempotency-Key` + same request returns the stored outcome, even after the campaign ends. A changed request returns `409 IDEMPOTENCY_CONFLICT`.
2. The eligibility token must belong to this campaign **and** the claimant wallet bound during World ID verification (`403 INVALID_ELIGIBILITY`, `403 ELIGIBILITY_EXPIRED`).
3. One accepted completion per human (`409 ALREADY_COMPLETED`), and at most **2 attempts** per human per campaign (`429 ATTEMPT_LIMIT_REACHED`), so the multiple-choice check cannot be brute-forced by retrying.
4. The deterministic verifier runs. `CAMPAIGN_NOT_ACTIVE` / `CAMPAIGN_NOT_STARTED` / `CAMPAIGN_ENDED` (409) and `MALFORMED_ANSWERS` (400) are not stored and do not count as attempts. `MISSING_ANSWERS` and `COMPREHENSION_FAILED` are stored as rejected attempts.
5. The response reveals only the status and reason code, never which answers were wrong.

Outcomes: `accepted`, `rejected` (POC verifier is synchronous; no `pending`).

Current accepted response (claim authorization is issued by #10):

```json
{
  "submissionId": "uuid",
  "campaignId": "uuid",
  "claimant": "0x...",
  "status": "accepted",
  "rejectionCode": null,
  "claim": { "status": "pending_authorization" }
}
```

Target accepted response once #10 lands:

Accepted response:

```json
{
  "status": "accepted",
  "claim": {
    "campaignId": "1",
    "claimant": "0x...",
    "amount": "1000000",
    "nonce": "0x...",
    "issuedAt": 1791186300,
    "expiresAt": 1791187200,
    "signature": "0x..."
  }
}
```

# Analytics

## GET /v1/campaigns/:id/analytics

Issue #20. **Currently unauthenticated.** It becomes advertiser-only with SIWE (#37).

Settlement values come only from reconciled chain events, and submission counts come from persisted server-side results. `confirmed` counts finalized events; `pending` also includes observed, unconfirmed events and is for progress display only.

```json
{
  "campaignId": "uuid",
  "onchainCampaignId": "1",
  "status": "active",
  "rewardPerCompletion": "1000000",
  "maxCompletions": 10,
  "plannedBudget": "10000000",
  "submissions": { "accepted": 8, "rejected": 3 },
  "settlement": {
    "confirmed": {
      "status": "active",
      "advertiser": "0x…",
      "funded": "10000000",
      "paidRewards": "7000000",
      "refunded": "0",
      "remaining": "3000000",
      "paidCompletions": 7,
      "accountingViolation": false
    },
    "pending": { "paidRewards": "8000000", "paidCompletions": 8, "...": "..." },
    "hasUnconfirmedEvents": true
  }
}
```

`settlement` is `null` until the campaign is linked on-chain.

# Health

## GET /health/live

Process liveness only.

## GET /health/ready

Checks required dependencies such as database and configured chain RPC without exposing secrets.

# Error Shape

```json
{
  "error": {
    "code": "CAMPAIGN_EXPIRED",
    "message": "Campaign is no longer accepting submissions",
    "requestId": "req_..."
  }
}
```

Client-visible errors must not expose proof payloads, signer material, database internals, or stack traces.
