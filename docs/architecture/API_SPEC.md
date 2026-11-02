# API Specification v0

> Status: System Design  
> Style: REST/JSON  
> Authentication details may evolve before implementation.
>
> Reconciled with the routes under `apps/api/src/**/routes.ts` on 2026-10-19. Every error code is catalogued in `apps/api/src/errors/catalog.ts`.

## Conventions

Authentication model, API keys, sandbox, rate limits, error model,
idempotency and versioning rules: [API_CONTRACT.md](./API_CONTRACT.md) (#26).

- Base path: `/v1`
- JSON only
- Mutating endpoints that create durable state require or accept `Idempotency-Key`; repeated keys with identical normalized input return the original result, while changed input returns a conflict.
- Dates/times use RFC 3339 externally.
- Monetary integer fields use atomic units or explicit decimal strings; never floating-point JSON numbers for settlement.

# Authentication (Sign-In with Ethereum, #37; browser sessions, #72)

1. `POST /v1/auth/nonce` → `{ nonce, expiresAt }` (single-use, 10 min).
2. The wallet signs an EIP-4361 message with that nonce, `domain = SIWE_DOMAIN`,
   `chainId = EVM_CHAIN_ID`, `version = 1` and a current `issuedAt`.
3. `POST /v1/auth/verify { message, signature, transport? }` with `transport`
   `"bearer"` (default) or `"cookie"`:
   - `bearer` → `{ token, tokenType: "Bearer", address, chainId, expiresAt }`;
     the caller then sends `Authorization: Bearer <token>`. For scripts,
     operators and tests.
   - `cookie` → `{ transport: "cookie", address, chainId, expiresAt }` with
     `Set-Cookie: __Host-vham_session=<token>; Path=/; Max-Age=<seconds until expiresAt>; HttpOnly; Secure; SameSite=Strict`
     and `Cache-Control: no-store`. The token never appears in a body. For the
     web app, which reaches the API same-origin through `/api/*`. A cookie
     sign-in must pass the CSRF rule below (`403 CSRF_REJECTED`) before the
     nonce is consumed. A successful cookie sign-in revokes the session of
     every session cookie the request carried, so the new cookie replaces the
     old session instead of leaving it valid. The web app then reads
     `GET /v1/auth/session` to confirm that the browser kept the cookie.

   `400 INVALID_SIGN_IN_REQUEST` for a malformed body, `401` with `INVALID_MESSAGE` / `WRONG_DOMAIN` / `WRONG_CHAIN` / `MESSAGE_NOT_VALID_NOW` / `INVALID_SIGNATURE` / `NONCE_INVALID_OR_USED`.
   The server checks domain, chain, time window (`issuedAt` ≤ now + 60 s,
   `expirationTime` / `notBefore`), the signature (EOA offline; ERC-1271/6492
   smart wallets via RPC when configured) and then **atomically consumes** the
   nonce, so replays fail with `NONCE_INVALID_OR_USED`. A failed sign-in
   leaves the current session alone.
4. Credential precedence: an `Authorization` header, when present, is the only
   credential read. `Bearer vhamk_…` is an API key, so a malformed key is
   `401 INVALID_API_KEY` on every `/v1` route. Any other value counts only as
   `Bearer <session token>` with the exact 43-character token. Anything else
   is `401` on session routes and never falls back to the cookie. Behind an
   HTTP Basic gate the browser sends `Authorization: Basic …`, so cookie
   sessions do not work there. Without the header, exactly one well-formed
   `__Host-vham_session` cookie counts. An API key, a malformed value or
   duplicate session cookies are no credential, and API keys are
   header-only. Sessions last up to 12 h (or the message's `expirationTime`
   if earlier). Only `sha256(token)` is stored.
5. CSRF rule for the session cookie: a request other than `GET`, `HEAD` or
   `OPTIONS` that carries the `__Host-vham_session` cookie name, whatever its
   value and whatever else the request carries, must carry
   `Sec-Fetch-Site: same-origin`. When the browser sends no Fetch Metadata,
   `Origin` must equal `WEB_ORIGIN`. Anything else is `403 CSRF_REJECTED`,
   logged as `event: "csrf_rejected"` with the `Sec-Fetch-Site` value and
   whether an `Origin` came, never the origin itself. Requests without the
   session cookie, such as scripts with a bearer token or an API key, are not
   subject to the rule. Responses to requests that carry the session cookie
   are `Cache-Control: no-store`. Every API response carries
   `X-Content-Type-Options: nosniff`.

   `WEB_ORIGIN` is optional. The API validates it at startup as an http(s)
   origin whose host is `SIWE_DOMAIN`. Without it there is no `Origin`
   fallback, and off the local chain the API logs a warning at startup.
6. Key management (`/v1/api-clients*`) and operator routes (`/v1/admin/*`)
   refuse a credential that comes from the session cookie with
   `403 COOKIE_SESSION_NOT_ALLOWED`. The web app has no UI for them. Use the
   bearer transport.
7. `GET /v1/auth/session` → `{ address, chainId, expiresAt }`, `204` when the
   request presents no credential, and `401 UNAUTHENTICATED` when it presents
   one that is not a live session, always with `Cache-Control: no-store`. The
   web app restores a cookie session with it after a reload. A `401 UNAUTHENTICATED` from this route or from an
   advertiser-only route clears the cookie (`Max-Age=0`) when the cookie was
   the credential: expired, revoked or malformed.
8. `POST /v1/auth/logout` → `204`. It revokes the session of a session token
   in the `Authorization` header and of every session token among the session
   cookie values. It sends the clearing `Set-Cookie` (`Max-Age=0`) only when
   the request carried the session cookie. A cross-site form carries no
   `SameSite=Strict` cookie, so it cannot sign the browser out.

Advertiser-only endpoints return `401 UNAUTHENTICATED` without a session and
`403 NOT_CAMPAIGN_ADVERTISER` when the signed-in wallet is not the campaign's
advertiser: `POST /v1/campaigns` (body `advertiser` must equal the session
wallet), `POST /v1/campaigns/:id/publish`, `POST /v1/campaigns/:id/onchain`,
`GET /v1/campaigns/:id/analytics`. Without `SIWE_DOMAIN`, sign-in returns
`503 AUTH_NOT_CONFIGURED` and these endpoints stay closed.

Participant endpoints (eligibility, submissions, claim authorization) do not
require a session in the POC: rewards are bound to the wallet verified with
World ID, and the contract requires `msg.sender == claimant`.

# Chain

## GET /v1/chain

Public. `{ chainId, campaignManager, usdc }` of the configured deployment (contract addresses are public data), or `503 CHAIN_NOT_CONFIGURED`. The web app uses it to check that a campaign's link belongs to the current deployment before funding.

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

Response (`201`, or `200` on an idempotent replay): the campaign as returned by `GET /v1/campaigns/:id`.

Errors: `400 INVALID_IDEMPOTENCY_KEY` (missing or longer than 200 chars), `400 INVALID_CAMPAIGN` (with `details` from the schema), `400 CAMPAIGN_START_IN_PAST`, `400 UNSAFE_CONTENT_URL`, `401` / `403` (see Authentication), `409 IDEMPOTENCY_CONFLICT`.

## GET /v1/campaigns/:id

Public. The off-chain draft and its link:

```json
{
  "id": "uuid",
  "chainId": 84532,
  "onchainCampaignId": "1",
  "advertiser": "0x...",
  "contentUrl": "https://example.com/article",
  "rewardPerCompletion": "1000000",
  "maxCompletions": 10,
  "startAt": "2026-10-05T04:00:00.000Z",
  "endAt": "2026-10-05T10:00:00.000Z",
  "status": "active",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`status` mirrors confirmed chain events (see `/onchain`). Settlement numbers are not here; use `/analytics`. `404 CAMPAIGN_NOT_FOUND` for unknown or malformed ids.

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

Unknown or malformed campaign ids return `404 MISSION_NOT_FOUND`. Moderation-gated (see Moderation).

## POST /v1/campaigns/:id/publish

Returns the on-chain transaction intent for a `draft` (no state change): `createCampaign(reward, maxCompletions, startTime, endTime, draftRef)` on `CampaignManager` (`draftRef = keccak256("vham-draft:" + draftId)`, ADR-0011), `approve(CampaignManager, budget)` on USDC, then `fundCampaign(campaignId, budget, draftRef)` (the contract reverts with `WrongDraft` unless the reference names that id for the sender).

```json
{
  "chainId": 84532,
  "campaignManager": "0x...",
  "steps": [
    { "contract": "0x<CampaignManager>", "function": "createCampaign", "args": { "rewardPerCompletion": "1000000", "maxCompletions": 10, "startTime": 1791180000, "endTime": 1791201600, "draftRef": "0x..." } },
    { "contract": "0x<USDC>", "function": "approve", "args": { "spender": "0x<CampaignManager>", "amount": "10000000" } },
    { "contract": "0x<CampaignManager>", "function": "fundCampaign", "args": { "campaignId": "<from CampaignCreated>", "amount": "10000000", "draftRef": "0x..." } }
  ],
  "linkEndpoint": "/v1/campaigns/<id>/onchain"
}
```

Before answering, the API reads `campaignIdByDraft(advertiser, draftRef)` at the **latest** block. Linking reads the confirmed block, so a creation that is mined but not yet final is invisible to it; the intent is refused instead, so a second tab or browser cannot send a `createCampaign` that only reverts (`DraftAlreadyCreated`) and costs gas (#78). A creation still in the mempool is not visible here either; the contract refuses it on-chain.

Errors: `404 CAMPAIGN_NOT_FOUND`, `409 CAMPAIGN_ALREADY_PUBLISHED` (not a `draft` or already linked), `409 CAMPAIGN_START_PASSED` (the contract would reject it), `409 DRAFT_ALREADY_CREATED` (this draft's campaign exists at the latest block: link it with `POST /onchain`, which succeeds once it is final), `503 RPC_UNAVAILABLE` (the chain could not be read; retryable), `503 CHAIN_NOT_CONFIGURED`. Moderation-gated.

## POST /v1/campaigns/:id/onchain

Body: `{ "txHash": "0x…" }` of the advertiser's `createCampaign` transaction (issue #16), or `{}` to link by draft reference when no hash is known (ADR-0011).

The client's report is never trusted. With a hash, the API fetches the receipt, requires its block to still be canonical (`getBlock(receipt.blockNumber).hash == receipt.blockHash`, `202 TX_UNCONFIRMED` otherwise) and the contract's `campaignIdByDraft` at the indexed block (below) to name the receipt's id (`202 TX_UNCONFIRMED` while the mapping is still empty at that block, `422 DRAFT_MISMATCH` when it names another id), requires a `CampaignCreated` log from the configured contract with the draft's advertiser **and the draft's `draftRef`**, and reads `campaigns(id)` via `eth_call` at the same block to require identical reward, completion cap and window. Then it links `onchain_campaign_id` (`UNIQUE(chain_id, onchain_contract_address, onchain_campaign_id)`; ids restart on every deployment, ADR-0011) with status `pending_onchain`.

| Status | Meaning |
| --- | --- |
| 200 | `{ id, onchainCampaignId, publishTxHash, status }` — linked (idempotent for the same creation, by hash or by draft) |
| 202 `TX_PENDING`, 202 `TX_UNCONFIRMED`, 202 `NOT_CREATED_YET`, 503 `RPC_UNAVAILABLE` | `{ "status": "reconciling", "code": "<one of these>", "retryAfterSeconds": 10 }`: retry later. **Never** treat it as failure or create/fund again. (Not an error body: no `error` object.) |
| 400 | `INVALID_TX_HASH` |
| 404 | `CAMPAIGN_NOT_FOUND` |
| 409 | `ALREADY_LINKED` (this draft is linked to another creation, or was linked on an earlier contract deployment), `ONCHAIN_CAMPAIGN_ALREADY_LINKED`, `LINK_NOT_CANONICAL` (retryable; see below), `WRONG_CHAIN` |
| 422 | `TX_REVERTED`, `NO_CAMPAIGN_CREATED_EVENT`, `ADVERTISER_MISMATCH`, `DRAFT_MISMATCH`, `PARAMETERS_MISMATCH` |

**Links are read at the indexed block (issue #76).** Both paths read the contract at the indexer worker's latest confirmed block (its cursor), addressed by the block's hash (EIP-1898 `{ blockHash, requireCanonical: true }`) after checking that this block is still canonical. A creation the worker has not committed yet is not linked (`202 TX_UNCONFIRMED` / `202 NOT_CREATED_YET`); a hash link also needs the receipt buried under `INDEXER_CONFIRMATIONS` blocks. Two guarantees follow:

- An RPC node on another fork cannot answer for that block: it does not hold the hash on its canonical chain, so the read fails (`503 RPC_UNAVAILABLE`, reconciling) instead of returning the other fork's mapping.
- Every link is backed by a block the worker has committed. A shallow reorg cannot reach it. The worker commits only ranges whose block headers link to each other by hash, whose first block extends the last committed block, and whose logs carry those hashes, so the committed index is one chain ending at the cursor block. A reorg deeper than `INDEXER_CONFIRMATIONS` that removes the creation therefore replaces the cursor block, which the worker re-reads at the start of each pass (and the last committed block whenever a range does not extend it, so also during a pass). A replaced block records a halt; a node that does not have the block yet, or a range read from different forks or nodes, is retried and never committed (VhamIndexerInconsistentReads alerts when that repeats). The halt then holds: until `reorg:recover -- --apply` has run **and** the worker has rebuilt and verified the index, World ID requests, eligibility, submissions and claim authorizations for the deployment return `503 CHAIN_HALTED` (RUNBOOK).

The cost is availability: linking waits for the worker (up to one poll interval once the creation is final) and answers `202` for as long as the worker is down or lagging. A campaign cannot become `active` without the worker anyway. A read by hash also needs the RPC to still hold that block's state: a full node keeps only recent state (about 128 blocks, some 4 minutes on Base), so with a worker that far behind linking answers `503 RPC_UNAVAILABLE` until it catches up (an archive RPC does not have this limit). Independently, a submission is accepted only if the contract would pay it right now (see Submissions), so no work is completed for a stale link even when the worker is down.

An already linked draft is answered from the chain, not from the database, by hash or without: at the indexed block, `campaignIdByDraft` must still name the linked id and `campaigns(id)` must carry the draft's parameters (`200`). If it names another id or the parameters differ, the link is stale: `409 LINK_NOT_CANONICAL`, retryable, because the worker relinks the draft (below) or halts the deployment. While this cannot be decided the answer is `202` (`TX_UNCONFIRMED` with a hash, `NOT_CREATED_YET` without): no indexed block (index empty or dropped by `reorg:recover`, or its block no longer canonical), a mapping still `0` at it (a rebuild that has not reached the creation yet), or a recorded halt (recovery may still relink the draft).

Without a hash (`{}`), the API reads `campaignIdByDraft(advertiser, draftRef)` at the indexed block: `0` means not created yet or not final (`202 reconciling`), otherwise it checks the on-chain economics at the same block and links with `publishTxHash: null`. This is how the web app recovers from a lost RPC response or a second tab: it stores no transaction hash, only a per-draft "a creation may be pending" marker that makes it offer *Check again* first after a reload, and pressing Create again is always safe because the contract refuses a second campaign for the same draft. A hash reported after linking by draft is accepted when it is the same creation. The web app retries every `reconciling` answer, the `503 RPC_UNAVAILABLE` one included, and every retryable error such as `409 LINK_NOT_CANONICAL`, for about two minutes, then asks the advertiser to press *Check again*; checking never sends a transaction.

If nothing is reported at all (e.g. the browser closed after broadcast), the indexer worker links a confirmed `CampaignCreated` to the unlinked draft whose `draftRef` it carries, after checking the economics. It acts on a creation only when the contract's `campaignIdByDraft` at the indexed block names the creation's id (index rows alone are not enough: they could hold creations of one draft or one id from two forks), and reads the economics at that block. Creations that name no known draft are ignored; one whose economics contradict its draft is logged for manual resolution. A confirmed creation also releases stale links (the campaign returns to `draft`) before the named draft is linked: a link of its id to a **different** draft (left behind by a reorg deeper than the confirmation depth), and a link of the draft it names to a **different** id (the contract allows one creation per advertiser and draft on a fork, so the other id is not this draft's; e.g. a link made before issue #76 from a node on another fork). Status sync never applies such a creation's events to the wrong draft, and the claim service checks `campaignIdByDraft` live before signing.

The halt guarantee covers links made since issue #76. It does not cover a `getLogs` answer that omits logs (a node behind, or on another fork with no logs in the range): such a range is committed without them, so a creation can be missing from the index (the API link paths still read the contract) and the settlement reconciliation reports the difference. An older link whose creation disappeared without any replacement is not released or halted automatically: `POST /onchain` answers `202 reconciling` for it (its mapping is `0`), participation is refused by the live checks, and `reorg:recover` lists it as `creation_missing`. The ADR-0011 redeploy starts a deployment with no such links.

Lifecycle status (`active`, `closed`, `settled`, `cancelled`) is derived only from **confirmed** chain events by the indexer worker. Submissions are accepted only while `active`.

# World ID / Eligibility

## POST /v1/campaigns/:id/world-id/request

No request body. Returns what IDKit needs to open a request (ADR-0007, #12):

```json
{
  "mode": "live",
  "appId": "app_…",
  "action": "vham-campaign-<campaignId>",
  "environment": "production",
  "rpContext": { "rp_id": "rp_…", "nonce": "0x00…", "created_at": 1791194400, "expires_at": 1791194700, "signature": "0x…" }
}
```

`mode` names the response shape. A `live` response always has an `appId`. With `WORLD_ID_MODE=simulated` (local anvil only) the response is `{ "mode": "simulated", "action" }`, with no `appId`, `environment`, or `rpContext`.

The response carries no signal. The page derives the wallet-bound signal itself from the campaign id, the claimant and a 32-byte salt it draws (`@vham/shared/world-id`, ADR-0007 update 2026-10-21), passes the signal to IDKit, and sends the salt with the proof to `eligibility/verify`.

`404 CAMPAIGN_NOT_FOUND`, `409 CAMPAIGN_NOT_OPEN` (ended, not draft/active, or linked on a retired deployment), `503 WORLD_ID_NOT_CONFIGURED` (none of `WORLD_ID_RP_ID`, `RP_SIGNING_KEY` and `WORLD_ID_APP_ID` is set; a partial or malformed set stops the API at startup), `503 CHAIN_HALTED`. Moderation-gated; sensitive rate-limit bucket.

## POST /v1/campaigns/:id/eligibility/verify

See ADR-0007. Request:

```json
{
  "claimant": "0x...",
  "signalSalt": "0x<32 bytes>",
  "idkitResponse": { "protocol_version": "4.0", "action": "vham-campaign-<campaignId>", "...": "forwarded unchanged" }
}
```

`signalSalt` is the salt the client drew for this proof: 32 random bytes as `0x` hex, either case. The expected signal is

```text
keccak256(abi.encode(string "vham:world-id-signal:v2", string campaignId, address claimant, bytes32 signalSalt))
```

with the ABI types `(string, string, address, bytes32)` and the campaign id in lowercase (`worldIdSignal` in `@vham/shared/world-id`). A client passes this signal to IDKit as the `0x` hex string, for example `CredentialRequest("proof_of_human", { signal })`; IDKit hashes a `0x` string as bytes, not as text, and the result's `signal_hash` is `keccak256(signal bytes) >> 8` as 32 bytes. The salt is never stored, logged, or sent to World.

`signalSalt` became required within `/v1` (#71). This is a recorded exception to the versioning rule in API_CONTRACT.md; see ADR-0007, update 2026-10-21.

Backend:

1. accepts only `idkitResponse.protocol_version == "4.0"` whose `responses` items have the 4.0 shape: `identifier` `"proof_of_human"` with `issuer_schema_id` 1 (any other credential is refused), `nullifier`, `expires_at_min`, and a `proof` array of exactly 5 strings. A legacy 3.0 result, or a 4.0 result that carries a 3.0 item, returns `400 INVALID_PROOF_PAYLOAD` without a call to World. The backend then checks `idkitResponse.action == "vham-campaign-<campaignId>"` and the environment;
2. checks that every credential's `signal_hash`, `0x` hex only, is the hash of the signal derived from this `claimant` and `signalSalt` (`403 SIGNAL_MISMATCH` without a call to World: the result does not match this wallet, campaign and salt, or carries no signal hash);
3. verifies via `POST https://developer.world.org/api/v4/verify/{rp_id}`; on a 400 from World it logs World's `code` and per-result codes, never the `detail` text;
4. stores only `HMAC(PARTICIPANT_KEY_SECRET, campaignId ‖ nullifier)` plus the claimant wallet;
5. returns an opaque eligibility token.

Responses:

| Status | Body / code |
| --- | --- |
| 201 / 200 (replay) | `{ "eligibilityToken", "campaignId", "claimant", "expiresAt" }` |
| 400 | `INVALID_ELIGIBILITY_REQUEST` (missing or malformed `claimant`, `signalSalt`, or `idkitResponse`), `INVALID_PROOF_PAYLOAD` |
| 403 | `VERIFICATION_FAILED`, `ACTION_MISMATCH`, `ENVIRONMENT_MISMATCH`, `SIGNAL_MISMATCH` |
| 404 | `CAMPAIGN_NOT_FOUND` |
| 409 | `CAMPAIGN_NOT_OPEN`, `PARTICIPANT_WALLET_MISMATCH`, `WALLET_ALREADY_BOUND` |
| 503 | `WORLD_ID_NOT_CONFIGURED`, `PROVIDER_UNAVAILABLE`, `CHAIN_HALTED` |

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

0. `400 INVALID_IDEMPOTENCY_KEY` without a valid header, `400 INVALID_SUBMISSION` for a malformed body, `404 CAMPAIGN_NOT_FOUND` / `MISSION_NOT_FOUND`, `409 CAMPAIGN_NOT_ACTIVE` when the campaign is linked on a retired deployment, `503 CHAIN_HALTED` during a deep-reorg halt.
1. Same `Idempotency-Key` + same request returns the stored outcome, even after the campaign ends. A changed request returns `409 IDEMPOTENCY_CONFLICT`.
2. The eligibility token must belong to this campaign **and** the claimant wallet bound during World ID verification (`403 INVALID_ELIGIBILITY`, `403 ELIGIBILITY_EXPIRED`).
3. One accepted completion per human (`409 ALREADY_COMPLETED`), and at most **2 attempts** per human per campaign (`429 ATTEMPT_LIMIT_REACHED`), so the multiple-choice check cannot be brute-forced by retrying.
4. Before the verifier evaluates the answers, the API reads the contract **live** (ADR-0011, decision 12). `campaignIdByDraft` must still name the linked id, and `campaigns(id)` must carry the draft's parameters. The campaign must be `Active`, not closed, inside its window, with remaining budget ≥ reward and completions below the cap. Otherwise the response is `409 CAMPAIGN_NOT_ACTIVE`. When a claim signer is configured, the API also reads `authorizedSigner` and `claimedWallet(id, claimant)`. If `authorizedSigner` is not the configured signer, the response is `503 SIGNER_MISMATCH`. If `claimedWallet` reports a paid wallet, a request with correct answers fails in step 6 with `409 ALREADY_CLAIMED`. If a read fails, the response is `503 CHAIN_UNAVAILABLE`. A refusal at this step stores nothing and consumes no attempt, even for wrong answers. Indexed status can lag by the confirmation depth. These reads do not lag.
5. The deterministic verifier runs. `CAMPAIGN_NOT_ACTIVE` / `CAMPAIGN_NOT_STARTED` / `CAMPAIGN_ENDED` (409) and `MALFORMED_ANSWERS` (400) are not stored and do not count as attempts. `MISSING_ANSWERS` and `COMPREHENSION_FAILED` are stored as rejected attempts.
6. An accepted completion gets its claim authorization in the same request (see Claims). The contract pays an authorization issued up to `closedAt`, so a close after acceptance cannot strand the participant.
7. The response reveals only the status and reason code, never which answers were wrong.

Outcomes: `accepted`, `rejected` (POC verifier is synchronous; no `pending`). Status `201` for a new outcome, `200` for a replay. A rejected submission has `"status": "rejected"`, a `rejectionCode` and `"claim": null`.

Accepted response:

```json
{
  "submissionId": "uuid",
  "campaignId": "uuid",
  "claimant": "0x...",
  "status": "accepted",
  "rejectionCode": null,
  "claim": {
    "status": "authorized",
    "authorization": {
      "campaignId": "1",
      "draftRef": "0x...",
      "claimant": "0x...",
      "amount": "1000000",
      "nonce": "0x...",
      "issuedAt": 1791186300,
      "expiresAt": 1791187200,
      "signature": "0x...",
      "chainId": 84532,
      "contractAddress": "0x..."
    }
  }
}
```

The acceptance and its authorization are one persisted result (ADR-0011): the signature is issued inside the transaction that records the completion. If it cannot be issued, nothing is recorded, the attempt is not consumed and the request fails with the reason: `409 CAMPAIGN_NOT_ACTIVE` (closed or no longer payable since the live check), `409 CAMPAIGN_CAP_REACHED`, `409 ALREADY_CLAIMED`, `503 SIGNER_UNAVAILABLE`, `503 SIGNER_MISMATCH`, `503 DAILY_LIMIT_REACHED`, `503 CHAIN_UNAVAILABLE` or `503 CHAIN_HALTED`; the same request can be retried. Only an API without a configured signer **or without a chain configuration** (local development) accepts with `claim` = `{ "status": "pending_authorization", "code": null }`. A replay of an accepted submission returns its stored authorization (reissued if it expired), or `pending_authorization` with the reason when it expired after the campaign closed. Once the wallet was paid, a replay returns `claim` = `{ "status": "claimed", "code": "ALREADY_CLAIMED" }` and no authorization, before and after the stored one expires, matching the `409 ALREADY_CLAIMED` of the authorization endpoint (#82). `claimed` is read from `claimedWallet` at the latest block and is not final: if a shallow reorg undoes the payout, a later replay or authorization request returns the stored authorization again (or a reissued one after expiry).

# Claims

## POST /v1/campaigns/:id/submissions/:submissionId/authorization

Body: `{ "eligibilityToken": "<opaque token returned by verification>" }`.

Only an accepted submission bound to that verified campaign and claimant can
receive an authorization. Fresh issuance requires an active, linked campaign;
an existing unexpired authorization may be retrieved after close. The server's
signer must match the contract's current signer.
The response contains the exact EIP-712 `ClaimAuthorization` fields
(including `draftRef`, which the contract checks against
`campaignIdByDraft`), `signature`, `chainId`, and `contractAddress`. Monetary values and `campaignId`
are decimal strings. A retry before expiry returns the same signed payload;
concurrent requests cannot issue a second authorization. After expiry, an
unredeemed authorization is reissued with a new nonce while the campaign is
still active and under its cap. Once the wallet has been paid (live
`claimedWallet`, or the stored nonce is a confirmed `RewardClaimed`) the
endpoint returns `409 ALREADY_CLAIMED` before and after expiry, never the
redeemed authorization, which the contract would revert (#82). Status `201`
for a newly signed authorization, `200` for a replay. Other errors:
`400 INVALID_ELIGIBILITY_TOKEN`, `403
INVALID_ELIGIBILITY` (token not bound to this campaign and claimant), `404
SUBMISSION_NOT_FOUND`, `409 SUBMISSION_NOT_ACCEPTED`, `409 CAMPAIGN_CAP_REACHED`
(paid + outstanding authorizations reached `maxCompletions`), `409
CAMPAIGN_NOT_ACTIVE` (including closed on-chain, a link that `campaignIdByDraft`
no longer confirms, or a retired deployment), `503 AUTHORIZATION_UNAVAILABLE`
(no signer or chain configured), `503 CHAIN_HALTED`, `503 CHAIN_UNAVAILABLE`,
`503 SIGNER_MISMATCH`, `503 SIGNER_UNAVAILABLE`, `503 DAILY_LIMIT_REACHED` (fail
closed). Before signing, the service reads `campaignIdByDraft`,
`authorizedSigner`, `campaigns(id)` and `claimedWallet` live. The API never
returns or logs the private signing key.

# Analytics

## GET /v1/campaigns/:id/analytics

Issue #20. Advertiser-only (SIWE session of the campaign's advertiser, #37).

Settlement values come only from reconciled chain events, and submission counts come from persisted server-side results. `confirmed` counts finalized events; `pending` also includes observed, unconfirmed events and is for progress display only.

```json
{
  "campaignId": "uuid",
  "chainId": 84532,
  "onchainCampaignId": "1",
  "onchainContractAddress": "0x...",
  "draftRef": "0x...",
  "status": "active",
  "rewardPerCompletion": "1000000",
  "maxCompletions": 10,
  "startAt": "2026-10-05T04:00:00.000Z",
  "endAt": "2026-10-05T10:00:00.000Z",
  "plannedBudget": "10000000",
  "submissions": {
    "accepted": 8,
    "rejected": 3,
    "flaggedAccepted": 2,
    "adjustedAccepted": 6,
    "flagReasons": { "FAST_COMPLETION": 2, "PASSED_ON_RETRY": 1 }
  },
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

`settlement` is `null` until the campaign is linked on-chain, and also when the link belongs to another deployment than the one the API is configured for (events of another contract are never shown). The web app compares `chainId` + `onchainContractAddress` with `GET /v1/chain` before offering to fund.

# API clients (#26)

SIWE session of the advertiser only (API keys get `403 API_KEY_NOT_ALLOWED`).

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/api-clients` | `{ name, scopes: ["campaigns:write" \| "analytics:read"], rateLimitPerMinute? }` → `201 { id, name, key, keyPrefix, scopes, environment, rateLimitPerMinute, createdAt, revokedAt: null }`; the key is shown once. `400 INVALID_API_CLIENT`, `409 API_CLIENT_LIMIT_REACHED` above 10 active keys. |
| `GET /v1/api-clients` | `{ items: [ … ] }` — own keys (no secrets) |
| `DELETE /v1/api-clients/:id` | Revoke own key → `204`; `404 API_CLIENT_NOT_FOUND` |
| `POST /v1/admin/api-clients/:id/revoke` | Operator revoke `{ reason }` → the client; `403 NOT_OPERATOR`, `400 INVALID_ACTION`, `404 API_CLIENT_NOT_FOUND` |

# Moderation (#24)

Policy and permissions: [docs/operations/MODERATION.md](../operations/MODERATION.md).

`POST /v1/campaigns` rejects unsafe content URLs with
`400 UNSAFE_CONTENT_URL` (`reason`: `NOT_HTTPS`, `HAS_CREDENTIALS`, `IP_HOST`,
`INTERNAL_HOST`, `NON_DEFAULT_PORT`, `TOO_LONG`, `DOMAIN_NOT_ALLOWED`).

Gate: `GET /mission`, `POST /world-id/request`, `POST /eligibility/verify`,
`POST /submissions` and `POST /publish` return `403 CAMPAIGN_NOT_APPROVED`
until the campaign is approved, and `410 CAMPAIGN_TAKEN_DOWN` after a
take-down. Claim authorization is not gated: completed work stays payable.

## POST /v1/campaigns/:id/reports

Public, no identity stored. `{ "reason": "phishing" | "malware" | "scam" | "misleading" | "offensive" | "broken_link" | "other", "details"?: string ≤ 500 }`
→ `201 { reportId, status: "open" }`; `400 INVALID_REPORT`, `404 CAMPAIGN_NOT_FOUND`.

## Operator endpoints

SIWE session of a wallet in `OPERATOR_ADDRESSES`; otherwise `401` / `403 NOT_OPERATOR`.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/admin/moderation?status=pending_review` | Review queue (≤ 100) with content URL and advertiser; `400 INVALID_QUERY` |
| `GET /v1/admin/campaigns/:id/moderation` | Status, full audit trail, reports; `404 CAMPAIGN_NOT_FOUND` |
| `POST /v1/admin/campaigns/:id/moderation` | `{ action: approve \| reject \| take_down \| reinstate, reason, reportId? }`; `400 INVALID_ACTION`, `404 CAMPAIGN_NOT_FOUND` / `REPORT_NOT_FOUND`, `409 INVALID_TRANSITION` / `REPORT_CAMPAIGN_MISMATCH` |
| `GET /v1/admin/reports?status=open` | Reports by status; `400 INVALID_QUERY` |
| `POST /v1/admin/reports/:reportId/resolve` | `{ resolution: dismissed \| actioned, reason }`; `400 INVALID_RESOLUTION`, `404 REPORT_NOT_FOUND`, `409 REPORT_ALREADY_RESOLVED` |

# Health

## GET /health/live

Process liveness only.

## GET /health/ready

Checks the database and, when a chain is configured, the RPC (`eth_blockNumber`).
Returns `503` if any check fails. Only check names and `ok`/`error` are returned,
never URLs, hosts or error messages:

```json
{
  "status": "ok",
  "checks": { "process": "ok", "database": "ok", "chain": "ok" },
  "indexerLagBlocks": "2",
  "chainHalted": false
}
```

`indexerLagBlocks` is `null` before the indexer's first pass and absent without
a chain. Lag does not fail readiness (the API still serves); it is alerted on.

`chainHalted` is `true` while a deep-reorg halt is recorded (ADR-0011) and
absent without a chain or when the halt cannot be read (then `database` is
`error`). A halt does not fail readiness either: the participation endpoints
answer `503 CHAIN_HALTED` themselves, and every other route keeps working, so
a load balancer keeps routing to the instance. It is alerted on through the
`vham_chain_halted` gauge (RUNBOOK: VhamChainHalted).

# Observability (#21)

- Every response carries `x-request-id`. A caller-supplied `x-request-id`
  matching `[A-Za-z0-9._-]{8,128}` is reused (and logged as `requestId`);
  otherwise the API generates a UUID.
- Logs are structured JSON (pino). Authorization headers, cookies, proofs,
  signatures, private keys and nullifiers are redacted; request bodies are
  never logged. Rejections on critical paths are logged with route outcome
  and campaign id only.
- `GET /metrics` — Prometheus text format. Protected by
  `Authorization: Bearer $METRICS_TOKEN` when set. The indexer worker exposes
  its own `/metrics` on `INDEXER_METRICS_PORT`.

See `docs/operations/RUNBOOK.md` for the metric list, alerts and responses.

# Error Shape

```json
{
  "error": {
    "code": "CAMPAIGN_ENDED",
    "message": "Submission was not accepted",
    "requestId": "req_...",
    "retryable": false
  }
}
```

`retryable` is added to every error response (status ≥ 400) from the catalogue; `202 reconciling` bodies are not errors and carry no `error` object.

Client-visible errors must not expose proof payloads, signer material, database internals, or stack traces.
