# Operations Runbook (POC)

> Scope: NFR-005 / issue #21. Applies to the API (`apps/api/src/server.ts`) and
> the chain indexer worker (`apps/api/src/indexer-worker.ts`).

## Signals

| Where          | Endpoint                        | Notes                                                             |
| -------------- | ------------------------------- | ----------------------------------------------------------------- |
| API liveness   | `GET /health/live`              | Process only.                                                     |
| API readiness  | `GET /health/ready`             | Database + chain RPC; `indexerLagBlocks`. 503 on failure.         |
| API metrics    | `GET /metrics`                  | Bearer `METRICS_TOKEN` when set.                                  |
| Worker metrics | `:INDEXER_METRICS_PORT/metrics` | Unset port = disabled.                                            |
| Logs           | stdout, JSON                    | `requestId` on every API line; worker lines carry `level`, `msg`. |
| Alert rules    | [`alerts.yml`](./alerts.yml)    | Prometheus rule file.                                             |

Correlation: send `x-request-id` from the web app or proxy; the API reuses it
(when it matches `[A-Za-z0-9._-]{8,128}`), logs it as `requestId` and echoes it
in the response header. Search logs by that value.

Redaction: `authorization`/`cookie` headers, `idkitResponse`, `proof`,
`signature`, `privateKey` and `nullifier` fields are replaced by
`[redacted]`; request bodies are never logged.

## Metrics

API (`/metrics`):

| Metric                                                            | Labels                | Meaning                                                              |
| ----------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| `vham_http_requests_total`                                        | route, method, status | All requests (unknown routes = `unmatched`).                         |
| `vham_sign_ins_total`                                             | outcome               | SIWE verify.                                                         |
| `vham_campaign_creations_total`                                   | outcome               | Draft creation.                                                      |
| `vham_campaign_publishes_total`                                   | outcome               | Publish intent.                                                      |
| `vham_campaign_links_total`                                       | outcome               | On-chain create/fund link (`TX_REVERTED`, `PARAMETERS_MISMATCH`, …). |
| `vham_eligibility_verifications_total`                            | outcome               | World ID (`PROVIDER_UNAVAILABLE`, `VERIFICATION_FAILED`, …).         |
| `vham_submissions_total`                                          | outcome               | Engagement result (`accepted`, `rejected`, error codes).             |
| `vham_claim_authorizations_total`                                 | outcome               | Claim signing (`SIGNER_MISMATCH`, `CHAIN_UNAVAILABLE`, …).           |
| `vham_payout_anomalies_total`                                     | scope                 | Authorization bursts (campaign / global).                            |
| `vham_rpc_up`, `vham_chain_head_block`, `vham_indexer_lag_blocks` | —                     | Refreshed on scrape and readiness.                                   |

Worker (`INDEXER_METRICS_PORT`):

| Metric                                                                               | Meaning                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `vham_indexer_head_block`, `vham_indexer_confirmed_block`, `vham_indexer_lag_blocks` | Progress per pass.                                        |
| `vham_indexer_last_success_timestamp_seconds`                                        | Stalls.                                                   |
| `vham_indexer_passes_total{result}`                                                  | `success`, `failure`, `reorg_beyond_confirmations`.       |
| `vham_reconciliation_accounting_violations`                                          | Must always be 0.                                         |
| `vham_reconciliation_ambiguous_campaigns`                                            | On-chain campaigns needing a manual `POST /onchain` link. |

Claim transaction failures happen in the participant's wallet, not the API;
they surface as authorizations that expire unredeemed (reissued on retry), i.e.
`submissions.accepted` in advertiser analytics growing faster than
`settlement.confirmed.paidCompletions`.

## Alerts and responses

### VhamPayoutAnomaly

More than `perCampaign` (10) authorizations for one campaign, or `global` (50)
overall, within 5 minutes. Possible signer abuse or a fraud wave.

1. Check `vham_submissions_total` and logs (`alert="payout_anomaly"`, `campaignId`).
2. If unexpected: run [Emergency pause](#emergency-pause). To also stop
   issuance, unset the signer (`CLAIM_SIGNER_URL` / `CLAIM_SIGNER_PRIVATE_KEY`)
   and restart the API (claims then return `503 AUTHORIZATION_UNAVAILABLE`).
3. If the key may be exposed: run [Signer rotation](#signer-rotation).

### VhamSignerMismatch

The API key's address differs from `CampaignManager.authorizedSigner()`; every claim
returns 503. Usually a rotation applied on one side only. Align the API key
with the on-chain signer. Never "fix" by disabling the check.

### VhamReconciliationFinding

The indexer worker's reconciliation (every `RECONCILIATION_INTERVAL_MS`,
default 10 min; one-shot: `pnpm --filter @vham/api reconcile`) found a
disagreement. By kind:

- `UNBACKED_PAYOUT` — a confirmed `RewardClaimed` whose claimant and nonce
  match no authorization the API issued. Treat as signer compromise (SEV1):
  [Emergency pause](#emergency-pause), then [Signer rotation](#signer-rotation).
  After a database restore, first rule out authorizations issued after the
  backup point (docs/operations/BACKUP_RESTORE.md).
- `INDEX_MISMATCH` — contract struct and indexed events differ at the same
  confirmed block: wrong contract/deploy block or a missed log. Re-index;
  analytics are wrong until fixed, payouts are not affected.
- `ACCOUNTING_VIOLATION` — see below.
- `CHAIN_READ_FAILED` — RPC could not serve the historical block (archive
  access needed); alerts only via VhamRpcDown.

### VhamSignerUnavailable

The signing service (KMS) times out, errors, or returned a signature that did
not recover to `CLAIM_SIGNER_ADDRESS`. Claims return `503 SIGNER_UNAVAILABLE`;
nothing was issued. Check the signing service and KMS health. A recovery
mismatch means the service signed with another key or payload: treat it as a
possible compromise and rotate.

### VhamDailyPayoutLimit

Authorized rewards in the last 24 h reached `DAILY_PAYOUT_LIMIT_ATOMIC`; new
claims return `503 DAILY_LIMIT_REACHED` (existing authorizations still work).
If the volume is legitimate, raise the limit through a reviewed config change;
otherwise treat as VhamPayoutAnomaly.

### VhamAccountingViolation

Indexed `paid + refunded > funded` for a campaign. The contract's invariant
tests forbid this, so suspect the indexer (wrong contract/deploy block, reorg
handling) first. Freeze advertiser analytics decisions, compare with on-chain
`campaigns(id)` reads, and open an incident issue.

### VhamIndexerLag / VhamIndexerStalled

Check worker logs (`indexer pass failed; retrying` with backoff up to 60 s) and
RPC health. Raise `INDEXER_MAX_BLOCK_RANGE` only if the RPC allows it. Status
sync (`active`, `closed`, `refunded`) and analytics lag behind until it recovers;
claim issuance still reads the contract directly.

### VhamReorgBeyondConfirmations

The worker stopped on purpose: a reorg deeper than `INDEXER_CONFIRMATIONS` would
rewrite confirmed settlement data. It recorded a halt, so the API already
refuses new World ID requests, eligibility, completions and claim
authorizations for this deployment with `503 CHAIN_HALTED` (ADR-0011). The
worker also refuses to start while the halt is recorded. Do not just restart.

1. Inspect the reported block on a block explorer.
2. Dry run: `pnpm --filter @vham/api reorg:recover`. It checks every linked
   campaign against the contract's own `campaignIdByDraft` at the confirmed
   head and prints which links it would keep and release (a release means the
   creation is gone or the id now belongs to another draft).
3. Review the plan, then `pnpm --filter @vham/api reorg:recover -- --apply`:
   released campaigns return to `draft`, the index is dropped and the halt is
   cleared.
4. Restart the worker; it rebuilds the index from the deploy block, links
   canonical creations and re-syncs statuses. Run `pnpm --filter @vham/api
   reconcile` once it has caught up.

Consider raising `INDEXER_CONFIRMATIONS` (used by both the API and the worker)
if this happens more than once.

### VhamRpcDown

Readiness returns 503 and claim issuance returns `CHAIN_UNAVAILABLE`. Check the
RPC provider status and credentials (never paste RPC URLs with keys into issues).

### VhamWorldIdUnavailable

World ID's verify endpoint is failing or not configured. Check
https://status.world.org and `WORLD_ID_RP_ID`. Users get 503 and can retry; no
eligibility is recorded on failure.

### VhamServerErrors

Group `vham_http_requests_total{status=~"5.."}` by route, then search logs for
`"level":50` with that route's `requestId`s.

## Emergency procedures (#23, ADR-0008)

Both are exercised in CI (`CampaignManager.t.sol` and the local-chain E2E).

### Emergency pause

1. Owner (multisig in production) calls `CampaignManager.pause()`:
   `cast send $CAMPAIGN_MANAGER_ADDRESS "pause()" --account <owner>`.
2. Effect: every `claim`, `fundCampaign` and `refundUnusedBudget` reverts
   with `Paused`. Nothing can move funds out — the owner has no withdrawal.
3. Verify: `cast call $CAMPAIGN_MANAGER_ADDRESS "paused()(bool)"` → `true`;
   the indexer logs a `PausedStateChanged` event.
4. Investigate, fix, then `unpause()`. Authorizations that expired during the
   pause are reissued on the participant's next request.

### Signer rotation

1. Create the new key in the KMS and add it to the signing service.
2. Owner calls `setAuthorizedSigner(<new address>)`. From that block, every
   signature of the old key fails with `InvalidSignature`, and the API
   returns `SIGNER_MISMATCH` until step 3.
3. Set `CLAIM_SIGNER_ADDRESS` to the new address and restart the API. The
   startup check confirms the signing service holds it.
4. Disable the old key in the KMS. Participants holding an old-key signature
   request a new one (same submission, reissued).

For local/testnet keys, step 1 is a new `CLAIM_SIGNER_PRIVATE_KEY`.

## Dashboard

No hosted dashboard yet (no deployment, #19). A Grafana board should chart:
request rate/5xx by route, each outcome counter, `vham_indexer_lag_blocks`,
`vham_rpc_up`, and the anomaly/violation counters. Link it here once deployed.
