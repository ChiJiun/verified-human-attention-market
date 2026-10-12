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

Marks metadata ready and returns the required on-chain create/fund transaction intent if the campaign is not yet active.

# World ID / Eligibility

## POST /v1/campaigns/:id/eligibility/verify

Request includes current World ID proof fields required by the official verification API plus claimant wallet address.

Backend:

1. verifies proof with current official World ID API;
2. applies campaign verification-count policy;
3. stores only the minimum identifier needed for duplicate prevention;
4. returns an opaque eligibility session/token.

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
  "eligibilityToken": "...",
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

Possible outcomes:

- `accepted`
- `rejected`
- `pending`

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

Advertiser-only or authenticated response:

```json
{
  "validCompletions": 8,
  "rejectedSubmissions": 3,
  "paidRewards": "8000000",
  "remainingBudget": "2000000",
  "status": "active"
}
```

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
