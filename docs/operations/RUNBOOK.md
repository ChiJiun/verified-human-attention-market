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
2. If unexpected: pause the contract (`pause()` from the owner) — claims stop,
   budgets are preserved. Unset `CLAIM_SIGNER_PRIVATE_KEY` and restart the API
   to stop issuance (claims then return `503 AUTHORIZATION_UNAVAILABLE`).
3. If the key may be exposed: rotate with `setAuthorizedSigner` (old signatures stop
   verifying), update the API key, unpause.

### VhamSignerMismatch

The API key's address differs from `CampaignManager.authorizedSigner()`; every claim
returns 503. Usually a rotation applied on one side only. Align the API key
with the on-chain signer. Never "fix" by disabling the check.

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
rewrite confirmed settlement data. Do not just restart. Inspect the reported
block, then either raise confirmations and re-index from the deploy block, or
restore the cursor after a manual review.

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

## Dashboard

No hosted dashboard yet (no deployment, #19). A Grafana board should chart:
request rate/5xx by route, each outcome counter, `vham_indexer_lag_blocks`,
`vham_rpc_up`, and the anomaly/violation counters. Link it here once deployed.
