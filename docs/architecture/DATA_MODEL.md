# Data Model v0

> Status: System Design  
> Database: PostgreSQL 16, Drizzle ORM
>
> Reconciled with `apps/api/src/db/schema.ts` and migrations 0000–0013: 2026-10-19

The database is **not** the source of truth for final settlement. On-chain events remain authoritative for funded, paid, and refunded amounts.

## campaigns

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | internal ID |
| chain_id | bigint | target EVM chain |
| onchain_campaign_id | numeric(78,0) nullable | set after creation; `UNIQUE (chain_id, onchain_contract_address, onchain_campaign_id)` |
| onchain_contract_address | text nullable | CampaignManager the id belongs to (ids restart on every deployment, ADR-0011); `CHECK` set together with `onchain_campaign_id`. Rows linked before migration 0011 are marked `pre-adr-0011` and never match a configured contract |
| advertiser_address | text | normalized EVM address (indexed) |
| creation_idempotency_key | text | `UNIQUE (advertiser_address, creation_idempotency_key)` |
| creation_request_hash | text | sha256 of the normalized creation request; a replay with another hash is `IDEMPOTENCY_CONFLICT` |
| content_url | text | first mission |
| reward_atomic | numeric | USDC atomic units |
| max_completions | integer | > 0 |
| start_at | timestamptz | |
| end_at | timestamptz | |
| publish_tx_hash | text nullable | createCampaign tx, once linked |
| status | text | `draft`, `pending_onchain`, `active`, `closed`, `expired`, `settled`, `cancelled` (CHECK, indexed). Lifecycle values mirror confirmed chain events; `expired` is reserved and never written by status sync (the API enforces the window from `start_at` / `end_at`). |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## missions

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | |
| campaign_id | fk | `ON DELETE RESTRICT` |
| version | integer | `UNIQUE (campaign_id, version)`, `>= 1` |
| kind | text | `comprehension_check` |
| content_url | text | https only (validated at API) |
| questions | jsonb | public question/choice definitions |
| answer_key | jsonb | **server-only**; never serialized to participants |
| pass_threshold | integer | minimum correct answers, `>= 1` (CHECK) |
| definition_hash | text | sha256 of the canonical definition |
| created_at | timestamptz | |

Rows are immutable: a `BEFORE UPDATE` trigger (`missions_immutable`, migration `0003_missions`) rejects updates. Changes are new versions. `UNIQUE (id, campaign_id)` is the target of the submissions composite FK.

## eligibility

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | opaque internal record |
| campaign_id | fk | |
| participant_key | bytes/text | derived/minimized identifier, not raw public identity |
| claimant_address | text | payout wallet |
| verified_at | timestamptz | |
| expires_at | timestamptz | |
| provider | text | world_id initially |

Enforced constraints (migration `0002_submission_integrity`):

- `UNIQUE (campaign_id, participant_key)` — one verified human per campaign;
- `UNIQUE (campaign_id, claimant_address)` — one payout wallet per campaign (mirrors the contract's one-claim-per-wallet rule);
- `participant_key` must be a 64-char lowercase hex HMAC (`CHECK`). It is derived with `deriveParticipantKey(PARTICIPANT_KEY_SECRET, campaignId, providerSubject)`; raw World ID identifiers or proofs are never stored;
- `claimant_address` must be a lowercase EVM address (`CHECK`);
- `campaign_id` FK is `ON DELETE RESTRICT`.

Replaying the same participant + wallet is idempotent. The same participant with a different wallet, or the same wallet with a different participant, is rejected.

## submissions

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | |
| campaign_id | fk | |
| eligibility_id | fk | |
| mission_id | fk | mission version used for evaluation; composite FK `(mission_id, campaign_id) → missions(id, campaign_id)` |
| idempotency_key | text | unique within route/scope |
| request_hash | text | sha256 of the normalized request (`hashSubmissionRequest`) |
| claimant_address | text | |
| result | text | accepted/rejected (POC verifier is synchronous; no pending state) |
| rejection_code | text nullable | |
| quality_flags | jsonb | reason codes (ADR-0009), `NOT NULL DEFAULT '[]'` |
| claim_nonce | text nullable | 32-byte hex |
| claim_expires_at | timestamptz nullable | |
| claim_issued_at | timestamptz nullable | |
| claim_signature | text nullable | EIP-712 signature; never private key |
| claim_chain_id | bigint nullable | domain chain ID |
| claim_contract_address | text nullable | domain verifying contract |
| claim_onchain_campaign_id | numeric(78,0) nullable | on-chain id the signature was issued for; a replay requires it, the chain and the contract to equal the campaign's current link, otherwise the authorization is reissued (ADR-0011, migration 0013) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Enforced constraints (migration `0002_submission_integrity`):

- `UNIQUE (campaign_id, idempotency_key)`; same key + same `request_hash` replays the original result, a different hash is an idempotency conflict;
- partial `UNIQUE (eligibility_id) WHERE result = 'accepted'` — at most one accepted completion, and therefore one reward liability, per human per campaign, even under concurrent retries;
- `UNIQUE (claim_nonce)`;
- `CHECK`: accepted ⇒ `rejection_code IS NULL`; rejected ⇒ `rejection_code IS NOT NULL`;
- `CHECK`: `claimant_address` is a lowercase EVM address;
- trigger `submissions_settlement_immutable` (migration `0008_moderation`): rows cannot be deleted, and `result`, `rejection_code`, `campaign_id`, `eligibility_id`, `mission_id` and `created_at` cannot change; only claim columns, flags and `updated_at` may be updated;
- `eligibility_id` FK is `ON DELETE RESTRICT`;
- the submission's campaign and claimant must match its eligibility record, and eligibility must not be expired (checked in the repository);
- submission and its answers are written in one transaction, and an accepted submission is committed only together with its claim authorization (`beforeCommit`, ADR-0011);
- `campaign_id` FK is `ON DELETE RESTRICT`, so deleting a campaign cannot silently erase completion history.

Do not store signer private material.

## answers

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | |
| submission_id | fk | `ON DELETE CASCADE` (retention deletes answers, never submissions) |
| question_id | text | |
| normalized_answer | jsonb | `{ "choiceId": "a" }`; minimize sensitive free text |
| score | numeric(10,4) nullable | |

For POC deterministic multiple-choice answers are preferred over free-text collection.

## chain_events

| Column | Type | Notes |
| --- | --- | --- |
| chain_id | bigint | |
| tx_hash | text | |
| log_index | integer | |
| block_number | bigint | |
| block_hash | text | |
| event_name | text | |
| payload | jsonb | |
| confirmation_status | text | observed/confirmed/orphaned |
| observed_at | timestamptz | |

Unique key: `(chain_id, tx_hash, log_index)`. Also `contract_address` and decoded `onchain_campaign_id` (indexed). `confirmation_status` is `observed` (inside the confirmation window), `confirmed`, or `orphaned` (removed by a reorg; never counted).

## reconciliation_state

Primary key `(chain_id, contract_address)`. Stores `latest_confirmed_block`, its `latest_confirmed_block_hash` (a mismatch means a reorg deeper than the confirmation depth, and the indexer stops for an operator), `latest_observed_block` and `updated_at`. Each confirmed batch commits events and cursor in one transaction.

## indexer_halts

Primary key `(chain_id, contract_address)`; migration 0012. `halted_block`, `halted_at`, `recovery_applied_at`. A row means a reorg deeper than the confirmation depth was detected: the API refuses participation and signing with `CHAIN_HALTED`. It lives apart from `reconciliation_state` so that dropping the index never drops the halt. `reorg:recover -- --apply` deletes the deployment's events and cursor and sets `recovery_applied_at`; the worker refuses to start without it, and deletes the row only after the rebuilt index has caught up and every link verifies (ADR-0011). Recording a new halt resets `recovery_applied_at`.

## auth_nonces, auth_sessions (#37)

`auth_nonces(nonce PK, created_at, expires_at, consumed_at)`: single-use SIWE nonces, consumed atomically on sign-in. `auth_sessions(id, token_hash UNIQUE, address (indexed), chain_id, created_at, expires_at, revoked_at)`: only `sha256(token)` is stored.

## campaign_moderation, campaign_reports, moderation_actions (#24)

- `campaign_moderation(campaign_id PK → campaigns, status, updated_at)`: `pending_review`, `approved`, `rejected`, `taken_down` (CHECK); no row means pending.
- `campaign_reports(id, campaign_id → campaigns, reason, details ≤ 500, status open/dismissed/actioned, created_at, resolved_at, resolved_by)`: anonymous reports, no reporter identity.
- `moderation_actions(id, campaign_id, action approve/reject/take_down/reinstate/resolve_report, from_status, to_status, actor, reason 1–1000, report_id → campaign_reports, created_at)`: append-only (`moderation_actions_append_only` trigger rejects UPDATE/DELETE).

## api_clients (#26)

`api_clients(id, name, advertiser_address, key_prefix, key_hash UNIQUE, scopes jsonb, environment sandbox/live, rate_limit_per_minute > 0, created_at, revoked_at, revoked_by, revoked_reason)`. Only `sha256(key)` is stored; a key acts as its advertiser within its scopes.

## Data Retention

Policy, per-table retention periods and the erasure workflow:
[docs/privacy/DATA_RETENTION.md](../privacy/DATA_RETENTION.md) (#22).

- World ID proofs and nullifiers are never stored.
- `eligibility.participant_key` is a campaign-scoped HMAC, retired 30 days after campaign end.
- Unpaid `claimant_address` values are pseudonymized and `answers` deleted 30 days after campaign end.
- `auth_nonces` are deleted 1 day after expiry; `auth_sessions` 30 days after expiry or revocation.
- No free-text mission answers in the POC.
