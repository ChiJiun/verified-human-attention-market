# Data Model v0

> Status: System Design  
> Database: PostgreSQL proposed

The database is **not** the source of truth for final settlement. On-chain events remain authoritative for funded, paid, and refunded amounts.

## campaigns

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid/text | internal ID |
| chain_id | bigint | target EVM chain |
| onchain_campaign_id | numeric nullable | set after creation |
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

Unique constraint should enforce the campaign-specific duplicate policy.

## submissions

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | |
| campaign_id | fk | |
| eligibility_id | fk | |
| idempotency_key | text | unique within route/scope |
| claimant_address | text | |
| result | enum | accepted/rejected/pending |
| rejection_code | text nullable | |
| claim_nonce | bytea/text nullable | |
| claim_expires_at | timestamptz nullable | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

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
