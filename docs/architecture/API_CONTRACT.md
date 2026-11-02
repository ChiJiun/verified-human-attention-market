# Public API Contract (v1)

> Issue #26. Applies to everything under `/v1`. Endpoint details:
> [API_SPEC.md](./API_SPEC.md).

## Authentication

| Caller | Credential | Reaches |
| --- | --- | --- |
| Participants | none (World ID proof per campaign) | mission, eligibility, submissions, claim authorization, reports |
| Advertisers (interactive) | SIWE session (`POST /v1/auth/verify`) | everything an advertiser can do, including key management |
| Integrations (servers) | API key `vhamk_test_…` / `vhamk_live_…` | the scoped routes below, acting as the advertiser that created the key; also accepted on public routes (where it grants nothing), never on admin, key-management or session routes |
| Operators | SIWE session of a wallet in `OPERATOR_ADDRESSES` | `/v1/admin/*` |

API keys:

- Created by the advertiser with a SIWE session: `POST /v1/api-clients
  { name, scopes, rateLimitPerMinute? }`. The key is returned **once**; only
  `sha256(key)` and a display prefix are stored. At most 10 active keys per
  advertiser.
- Sent as `Authorization: Bearer vhamk_…`.
- Scopes:

  | Scope | Routes |
  | --- | --- |
  | `campaigns:write` | `POST /v1/campaigns`, `POST /v1/campaigns/:id/publish`, `POST /v1/campaigns/:id/onchain` |
  | `analytics:read` | `GET /v1/campaigns/:id/analytics` |

- Never accepted on `/v1/admin/*`, `/v1/api-clients*` or `/v1/auth/*`
  (`403 API_KEY_NOT_ALLOWED`), so an integration cannot mint keys, act as an
  operator or hold a wallet session. Operator credentials are never shared.
- Revocation: the owner (`DELETE /v1/api-clients/:id`) or any operator
  (`POST /v1/admin/api-clients/:id/revoke { reason }`, the abuse path). Both
  are logged as `audit: "api_client_revoked"`. Revoked keys fail with
  `401 INVALID_API_KEY` on the next request.
- Usage: every keyed request is logged with `apiClientId` and counted in
  `vham_api_client_requests_total{client}`.

## Sandbox

The sandbox is the Base Sepolia (84532) or local anvil (31337) deployment:
keys there are `vhamk_test_…`, money is test USDC, and World ID may use the
staging environment. A deployment on any other chain is `live` and issues
`vhamk_live_…` keys. Keys only work in their own environment
(`401 API_KEY_WRONG_ENVIRONMENT`). Sandbox and live never share a database.

## Rate limits

Fixed one-minute windows, per API instance:

| Bucket | Default | Env |
| --- | --- | --- |
| Per IP, unauthenticated or SIWE | 300 / min | `RATE_LIMIT_ANONYMOUS_PER_MINUTE` |
| Per IP and route: sign-in, eligibility, reports | 30 / min | `RATE_LIMIT_SENSITIVE_PER_MINUTE` |
| Per API key | 600 / min (key setting, max 6000) | `RATE_LIMIT_CLIENT_DEFAULT_PER_MINUTE`, `RATE_LIMIT_CLIENT_MAX_PER_MINUTE` |

Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` (seconds). Over the limit: `429 RATE_LIMITED` with
`Retry-After`; counted in `vham_rate_limited_total{bucket}`. Behind a reverse
proxy set `TRUST_PROXY_HOPS` so limits apply to the client IP. Health and
metrics endpoints are exempt.

## Errors

```json
{ "error": { "code": "CAMPAIGN_CAP_REACHED", "message": "…", "requestId": "…", "retryable": true } }
```

- `code` is stable within `/v1` and listed in
  `apps/api/src/errors/catalog.ts` (a test fails if the API uses an
  uncatalogued code). `message` is for humans and may change.
- `retryable: true` — the same request may succeed later (back off
  exponentially; honour `Retry-After`). Examples: `RATE_LIMITED`,
  `CHAIN_UNAVAILABLE`, `CAMPAIGN_CAP_REACHED`. (`TX_PENDING` and the other
  `202 reconciling` codes are not error bodies; they carry
  `retryAfterSeconds` instead.)
- `retryable: false` — change the request or stop. Examples:
  `IDEMPOTENCY_CONFLICT`, `ALREADY_CLAIMED`, `INSUFFICIENT_SCOPE`.
- Unknown codes: treat 5xx and 429 as retryable, other 4xx as terminal.
- `requestId` equals the `x-request-id` response header; quote it in
  support requests.

## Idempotency

Mutations that create durable state take `Idempotency-Key` (1–200 chars):
`POST /v1/campaigns` (required, scoped to the advertiser) and
`POST /v1/campaigns/:id/submissions` (required, scoped to the campaign).

| Retry | Result |
| --- | --- |
| Same key, same normalized body | Original resource, `200` instead of `201`; no new state |
| Same key, different body | `409 IDEMPOTENCY_CONFLICT` (terminal) |
| Concurrent duplicates | Exactly one is created (database unique constraint) |

Other mutations are idempotent by construction: claim authorization returns
the same unexpired signature on retry; `POST /onchain` with the same
transaction returns the same link; moderation actions and revocations are
state transitions that conflict instead of repeating. Covered by the
campaign, submission, claim and PostgreSQL tests.

## Versioning and deprecation

- The major version is in the path (`/v1`). Within a major version changes
  are additive only: new endpoints, new optional fields, new error codes,
  new enum values in responses. Clients must ignore unknown fields.
- Breaking changes (removing or renaming fields, changing types or
  semantics, making optional input required) require `/v2`.
- A deprecated endpoint or field is announced in the changelog and served
  with `Deprecation: true` and `Sunset: <HTTP date>` headers for at least
  90 days in the sandbox and 180 days in live before removal. (Policy only:
  nothing is deprecated yet and the API emits no such headers today.)
- Error codes are never reused for a different meaning.
