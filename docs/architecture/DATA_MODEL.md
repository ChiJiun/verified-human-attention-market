# Data Model v0

> Status: System Design  
> Database: PostgreSQL proposed

The database is **not** the source of truth for final settlement. On-chain events remain authoritative for funded, paid, and refunded amounts.

## campaigns

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid/text | internal ID |
| chain_id | bigint | target EVM chain |
| onchain_campaign_id | numeric nullable | set after creation; `UNIQUE (chain_id, onchain_campaign_id)` |
| advertiser_address | text | normalized EVM address |
| content_url | text | first mission |
| reward_atomic | numeric | USDC atomic units |
| max_completions | integer | > 0 |
| start_at | timestamptz | |
| end_at | timestamptz | |
| status | enum/text | draft/active/closed/etc |
| created_at | timestamptz | |
| updated_at | timestamptz | |

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
| idempotency_key | text | unique within route/scope |
| request_hash | text | sha256 of the normalized request (`hashSubmissionRequest`) |
| claimant_address | text | |
| result | text | accepted/rejected (POC verifier is synchronous; no pending state) |
| rejection_code | text nullable | |
| claim_nonce | bytea/text nullable | |
| claim_expires_at | timestamptz nullable | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Enforced constraints (migration `0002_submission_integrity`):

- `UNIQUE (campaign_id, idempotency_key)`; same key + same `request_hash` replays the original result, a different hash is an idempotency conflict;
- partial `UNIQUE (eligibility_id) WHERE result = 'accepted'` — at most one accepted completion, and therefore one reward liability, per human per campaign, even under concurrent retries;
- `UNIQUE (claim_nonce)`;
- `CHECK`: accepted ⇒ `rejection_code IS NULL`; rejected ⇒ `rejection_code IS NOT NULL`;
- the submission's campaign and claimant must match its eligibility record, and eligibility must not be expired (checked in the repository);
- submission and its answers are written in one transaction;
- `campaign_id` FK is `ON DELETE RESTRICT`, so deleting a campaign cannot silently erase completion history.

Do not store signer private material.

## answers

| Column | Type | Notes |
| --- | --- | --- |
| submission_id | fk | |
| question_id | text | |
| normalized_answer | text/jsonb | minimize sensitive free text |
| score | numeric nullable | |

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

Unique key: `(chain_id, tx_hash, log_index)`.

## reconciliation_state

Tracks latest indexed block/finality state per chain.

## Data Retention Principles

- do not retain full World ID proof longer than required for verification/debug policy;
- never log proof payloads by default;
- store the minimum campaign-specific participant key needed for duplicate prevention;
- define deletion/retention policy before public beta;
- avoid free-text mission answers in POC unless required.
