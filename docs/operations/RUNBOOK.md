# Operations Runbook (POC)

> Scope: NFR-005 / issue #21. Applies to the API (`apps/api/src/server.ts`) and
> the chain indexer worker (`apps/api/src/indexer-worker.ts`).

## Signals

| Where          | Endpoint                        | Notes                                                             |
| -------------- | ------------------------------- | ----------------------------------------------------------------- |
| API liveness   | `GET /health/live`              | Process only.                                                     |
| API readiness  | `GET /health/ready`             | Database + chain RPC; `indexerLagBlocks`, `chainHalted`. 503 on a failed check, not on a halt. |
| API metrics    | `GET /metrics`                  | Bearer `METRICS_TOKEN` when set.                                  |
| Worker metrics | `:INDEXER_METRICS_PORT/metrics` | Unset port = disabled.                                            |
| Logs           | stdout, JSON                    | `requestId` on every API line; worker lines carry `level`, `msg`. |
| Alert rules    | [`alerts.yml`](./alerts.yml)    | Prometheus rule file.                                             |

Scrape every API instance and the worker as its own target, not through a
load balancer: counters are per process, so a scrape that alternates between
instances sees each counter jump back and forth and reads it as resets.

Correlation: send `x-request-id` from the web app or proxy; the API reuses it
(when it matches `[A-Za-z0-9._-]{8,128}`), logs it as `requestId` and echoes it
in the response header. Search logs by that value.

Redaction: `authorization`/`cookie` request headers, the `set-cookie`
response header, and `idkitResponse`, `signalSalt`, `proof`, `signature`,
`privateKey` and `nullifier` fields are replaced by `[redacted]`
(`LOGGER_REDACT_PATHS` in `apps/api/src/observability/instrumentation.ts`);
request bodies are never logged.

## Metrics

API (`/metrics`):

| Metric                                                            | Labels                | Meaning                                                              |
| ----------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| `vham_http_requests_total`                                        | route, method, status | All requests (unknown routes = `unmatched`).                         |
| `vham_sign_ins_total`                                             | outcome               | SIWE verify.                                                         |
| `vham_campaign_creations_total`                                   | outcome               | Draft creation.                                                      |
| `vham_campaign_publishes_total`                                   | outcome               | Publish intent.                                                      |
| `vham_campaign_links_total`                                       | outcome               | On-chain create/fund link (`TX_REVERTED`, `PARAMETERS_MISMATCH`, …). |
| `vham_world_id_requests_total`                                    | outcome               | Signed World ID request (`WORLD_ID_NOT_CONFIGURED`, …).              |
| `vham_eligibility_verifications_total`                            | outcome               | World ID (`PROVIDER_UNAVAILABLE`, `VERIFICATION_FAILED`, …).         |
| `vham_submissions_total`                                          | outcome               | Engagement result (`accepted`, `rejected`, error codes).             |
| `vham_claim_authorizations_total`                                 | outcome               | Every attempt: `success` or a refusal code (`SIGNER_MISMATCH`, …).      |
| `vham_payout_anomalies_total`                                     | scope                 | Bursts of newly signed authorizations (campaign / global).           |
| `vham_rpc_up`, `vham_chain_head_block`, `vham_indexer_lag_blocks` | —                     | Refreshed on scrape and readiness.                                   |
| `vham_chain_halted`                                               | —                     | 1 while a deep-reorg halt is recorded, or while it cannot be read (read on scrape, RPC up or not). |

Worker (`INDEXER_METRICS_PORT`):

| Metric                                                                               | Meaning                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `vham_indexer_head_block`, `vham_indexer_confirmed_block`, `vham_indexer_lag_blocks` | Progress per pass.                                        |
| `vham_indexer_last_success_timestamp_seconds`                                        | Stalls. Before the first successful pass: when the worker took the deployment lock. |
| `vham_indexer_passes_total{result}`                                                  | `success`, `failure`, `inconsistent_read`, `reorg_beyond_confirmations`, `halted`, `lock_lost`. |
| `vham_indexer_inconsistent_read_streak`                                              | Consecutive passes ending in `inconsistent_read`; 0 after a success. |
| `vham_indexer_rpc_requests_total{method}`                                            | Every RPC request of the worker by JSON-RPC method, counted when sent, so failed passes and failed requests are included. `eth_getBlockReceipts` is the completeness check (#102). See [request cost](#indexer-request-cost). |
| `vham_reconciliation_accounting_violations`                                          | Must always be 0.                                         |
| `vham_reconciliation_ambiguous_campaigns`                                            | On-chain campaigns needing a manual `POST /onchain` link. |

Prometheus derives `increase()` from the samples it scrapes: an event counts
only once Prometheus holds an earlier sample of the same series within the
rule's range. So every counter series that a rule in [alerts.yml](alerts.yml)
watches with `increase()`, except the 5xx series below, is exported at 0 from
startup (`apps/api/src/observability/alerted-series.ts`;
`alert-series.test.ts` checks the list against the rules). Without the zeros,
every signer mismatch, signer outage, daily limit or payout anomaly counted
before the series' first scrape would be lost, so the first of them would not
alert, and VhamWorldIdUnavailable would lose the failures before its first
scrape.

What every `increase()` rule still misses:

- Events before Prometheus first scrapes a newly started API or worker. After
  a restart they count only when a sample from before it is still within the
  range and the restarted series has the same labels (instance, pod).
  Prometheus then reads a lower value as a reset and counts all of it, a
  higher value only by its difference, and the same value as no change.
- Events a process counts after its last scrape, when it stops before the
  next one.
- Counts per instance: a rule without `sum` (VhamWorldIdUnavailable) applies
  its threshold to each API instance separately.

What single rules miss:

- VhamReorgBeyondConfirmations: the worker's `reorg_beyond_confirmations`
  series starts at 0 too, but the worker exits right after counting a deep
  reorg, so the alert fires only if a scrape lands in between. Rely on
  VhamChainHalted, which the API raises for as long as the halt lasts.
- VhamServerErrors: `vham_http_requests_total` is not listed, so that its
  series (one per route, method and status) exist only once they occur. The
  5xx responses a new series counts before its first scrape are not seen as
  an increase, whenever that series first appears: a burst of errors on routes
  or statuses with none so far can pass without this warning. Check the logs
  for `"level":50` when 5xx responses are reported.

`vham_claim_authorizations_total` counts each call of the claim service, whichever
route made it: acceptance in `POST .../submissions` (a refusal there answers
503/409 and records nothing), a `POST .../submissions` replay (a refusal answers
200 with `claim.code`), and `POST .../authorization`. Requests rejected before the
service runs (invalid body, rate limit) appear only in `vham_http_requests_total`.
`success` covers new and stored authorizations; only newly signed ones feed
`vham_payout_anomalies_total`.
Each refusal that points at an operator problem is logged once at error level
with the request id (`event="submissions"` or `event="claim_authorizations"`),
and so is the anomaly line.

Claim transaction failures happen in the participant's wallet, not the API;
they surface as authorizations that expire unredeemed (reissued on retry), i.e.
`submissions.accepted` in advertiser analytics growing faster than
`settlement.confirmed.paidCompletions`.

### Indexer request cost

For each confirmed batch of N blocks (`INDEXER_MAX_BLOCK_RANGE` during a
backfill, a few once caught up) the worker makes:

- one `eth_getLogs` for the range;
- N + 1 `eth_getBlockByNumber`: every header, to link them by hash, and the
  range end a second time (issue #76);
- one `eth_getBlockReceipts` by block hash for each block whose header
  `logsBloom` may hold a CampaignManager event, i.e. the blocks with events
  plus bloom false positives, never more than N (issue #102). Its answer is
  every receipt of the block, since the receipts must rebuild the header's
  bloom to prove the block complete. The bloom test, and rebuilding the bloom
  from the receipts, run locally; up to 8 of these requests run at once.

Each pass adds `eth_blockNumber`, the cursor block's header and one
`eth_getLogs` for the unconfirmed tail. How often a bloom says "may hold"
depends on how full the chain's blooms are. Measured on 2026-11-02 at 18:14
UTC over the latest 200 blocks of each chain, through the public RPCs
(read-only), testing every header's bloom for the 2026-10-14 CampaignManager
address and the nine indexed event topics, and sizing `eth_getBlockReceipts`
answers for 5 of those blocks:

| Chain        | Bits set (median, range) | Blocks flagged | Receipts per block |
| ------------ | ------------------------ | -------------- | ------------------ |
| Base Sepolia | 1.3 % (0–12.9 %)         | 0 of 200       | 2–79 kB            |
| Base mainnet | 59 % (42–88 %)           | 21 of 200      | 470 kB–1 MB        |

On Base Sepolia the receipts requests are about one per block with campaign
events and small. On Base mainnet about one block in ten is flagged by chance,
so a 2,000-block backfill batch reads roughly 200 blocks' receipts, some
100–200 MB; a caught-up worker reads one such block about every 20 s. The flag
rate depends on the address (its bits), so measure again for a new deployment.
Compare `vham_indexer_rpc_requests_total{method="eth_getBlockReceipts"}` with
the growth of `vham_indexer_confirmed_block` for the actual rate.

The RPC must serve `eth_getBlockReceipts` with a block hash: the public Base
Sepolia and Base mainnet RPCs did in that measurement (an unknown hash
answers `null`), and the anvil e2e in CI uses it. If it does not, the
first block that may hold an event fails every pass with `inconsistent_read`
and a `reason` naming `eth_getBlockReceipts`: the worker stalls there
(VhamIndexerInconsistentReads, then VhamIndexerStalled) until it points at an
RPC that does.

## Alerts and responses

### VhamPayoutAnomaly

More than `perCampaign` (10) authorizations for one campaign, or `global` (50)
overall, within 5 minutes. Possible signer abuse or a fraud wave.

1. Check `vham_submissions_total` (accepted completions) and logs (`alert="payout_anomaly"`, `campaignId`).
2. If unexpected: run [Emergency pause](#emergency-pause). To also stop
   issuance, unset the signer (`CLAIM_SIGNER_URL` / `CLAIM_SIGNER_PRIVATE_KEY`)
   and restart the API (claims then return `503 AUTHORIZATION_UNAVAILABLE`).
3. If the key may be exposed: run [Signer rotation](#signer-rotation).

### VhamSignerMismatch

The API key's address differs from `CampaignManager.authorizedSigner()`; every claim
returns 503. Usually a rotation applied on one side only. Align the API key
with the on-chain signer. Never "fix" by disabling the check.

The API reads `authorizedSigner()` while it prepares a claim, after the live
campaign read: on the authorization route, on a replay of an accepted
submission (which reads its authorization again), and for a new submission
that passed the verifier's campaign and answer-shape checks (an indexed
`active` campaign inside its window, well-formed answers, whatever they score).
A mismatch therefore raises this alert on the first such request once
Prometheus has scraped the API (the series starts at 0), not on
submissions refused before it, such as one sent before the campaign starts.
Those requests sign nothing.

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

VhamIndexerStalled counts from the worker's last successful pass or, before
its first one, from when it took the deployment lock: a worker whose passes
fail from its start raises it after 5 minutes. A pass runs until the index
reaches the confirmed head, so a pass that catches up for more than 5 minutes
raises it too, the first one included: after a long stop, or the rebuild
after `reorg:recover --apply`. Catching up, the worker logs no
`indexer pass failed`, `vham_indexer_rpc_requests_total` keeps growing and the
API's `vham_indexer_lag_blocks` keeps falling as each range commits; stuck, it
logs the failure and the lag grows. A worker that keeps restarting starts the
clock again each time; VhamIndexerLag, which the API computes from the stored
cursor, still fires then, once the worker has committed a range (the API
exports no lag before that).

Check worker logs (`indexer pass failed; retrying` with backoff up to 60 s) and
RPC health ([request cost](#indexer-request-cost)). Raise
`INDEXER_MAX_BLOCK_RANGE` only if the RPC allows it. Status
sync (`active`, `closed`, `settled`, `cancelled`) and analytics lag behind until it recovers;
claim issuance still reads the contract directly. Linking a new campaign
(`POST /v1/campaigns/:id/onchain`) also waits for the worker: it reads the
contract at the worker's latest confirmed block, so advertisers get
`202 reconciling` until the worker has indexed their creation (issue #76).
That read is pinned to the block's hash and needs its state: a full node
keeps only about 128 recent blocks of state (some 4 minutes on Base), so once
the worker is further behind, linking answers `503 RPC_UNAVAILABLE` until it
catches up. Fix the worker first; an archive RPC removes this limit.

At startup the API and the worker check the chain, the contract code and the
contract version. An unreachable or failing RPC is retried with backoff up to
60 s (`startup chain check failed; retrying`) instead of crash-looping; a
wrong chain id, missing code or a pre-ADR-0011 contract stops the process at
once. No metrics exist until that check passes, so a worker stuck there shows
up as VhamRpcDown on the API or as a missing worker scrape target, not as a
stall, and an API stuck there does not listen yet, so its health checks fail.
A worker that logs `waiting for the deployment lock` is waiting for another
worker or a `reorg:recover --apply` on the same deployment to finish. A
worker that logs `deployment lock lost; stopping` exits with code 1 so its
supervisor restarts it: its database session ended (restart, failover,
network, `idle_session_timeout`) and the server released the lock with it.
If it repeats, check that `DATABASE_URL` is a direct or session-mode
connection ([Running the built API](#running-the-built-api)).

### VhamIndexerInconsistentReads

Five or more passes in a row ended in `inconsistent_read`: the worker reads a
range, the range's block headers (linked by hash), the logs and the range end
again, and refuses to commit when they disagree (issue #76). It also reads
the receipts of every block whose `logsBloom` may hold an event and refuses a
range whose `eth_getLogs` answer left an event out, holds one the receipts do
not, or holds one twice, and a block whose receipts are missing, incomplete
or do not rebuild its bloom (issue #102). Usually the RPC is load-balanced
over nodes on different forks or heights, a node lags (or is still syncing
receipts), or the provider's log index lags behind its blocks.
Nothing past the failing range is committed and no halt is recorded, so the
index, status sync and linking stay behind while participation continues
(the API's live contract checks still apply). The log line
`indexer pass failed; retrying` names the `block` and the `inconsistentStreak`,
and a `reason` for the completeness check, e.g. `eth_getLogs for blocks A-B
omitted 1 event(s) of this block that its receipts hold`.

1. Check the RPC provider: pin the worker (and the API) to one endpoint or a
   provider with sticky sessions, or remove the lagging node. A `reason` that
   names omitted events points at a lagging node or log index; one about the
   receipts at a node without them, or (`eth_getBlockReceipts by block hash
   failed`) at an RPC that does not serve them
   ([request cost](#indexer-request-cost)).
2. If the same block keeps failing on a single consistent endpoint, compare
   that block's hash and its logs across two providers; a provider serving
   another fork means a deep reorg may be under way (see
   VhamReorgBeyondConfirmations).
3. The alert clears on the next successful pass.

### VhamChainHalted

`vham_chain_halted` is 1: a halt is recorded for the configured deployment
(`indexer_halts`), so the API answers World ID requests, eligibility,
completions and claim authorizations with `503 CHAIN_HALTED`. It stays 1 until
the worker clears the halt after a verified recovery, so it fires on any scrape
and does not depend on catching the worker's counter (which exits right after
recording the halt). Follow [VhamReorgBeyondConfirmations](#vhamreorgbeyondconfirmations).

`/health/ready` reports `"chainHalted": true` but stays 200 on purpose: the
instance can still serve sign-in, drafts, analytics and a retryable
`CHAIN_HALTED` to participants, and a 503 would make the load balancer drop
every API instance at once. Alert on the gauge, not on readiness.

The gauge fails closed: it is also 1 while the API cannot read the halt
(database unreachable), including on an instance that started during a
database outage, so a failed read never leaves a stale 0 or no series. That
page is right, not noise: every participation route reads the halt first, so
participation fails then too. Readiness tells the two apart: a database
outage answers 503 with `"database": "error"` and no `chainHalted` field; a
real halt answers 200 with `"chainHalted": true`. An `absent()` rule was not
used: it cannot see one stale instance among several that still report.

### VhamReorgBeyondConfirmations

The worker stopped on purpose: a reorg deeper than `INDEXER_CONFIRMATIONS` would
rewrite confirmed settlement data. It recorded a halt, so the API already
refuses new World ID requests, eligibility, completions and claim
authorizations for this deployment with `503 CHAIN_HALTED` (ADR-0011). The
worker also refuses to start while the halt is recorded. Do not just restart.

The steps below use the built API ([Running the built API](#running-the-built-api)).
From a source checkout, `reorg:recover` (without `:start`) runs the same code
with `tsx`. Both need `DATABASE_URL` (a direct or session-mode connection),
the chain variables (`EVM_CHAIN_ID`, `EVM_RPC_URL`, `USDC_ADDRESS`,
`CAMPAIGN_MANAGER_ADDRESS`, `CAMPAIGN_MANAGER_DEPLOY_BLOCK`) and the same
`INDEXER_CONFIRMATIONS` as the API and the worker.

1. Inspect the reported block on a block explorer.
2. Make sure no indexer worker runs for this deployment: after a detected
   reorg it has exited by itself; for a recovery you start yourself, stop it
   and anything that restarts it (systemd unit, container restart policy).
3. Dry run: `pnpm --filter @vham/api reorg:recover:start`. It checks every
   linked campaign against the contract's own `campaignIdByDraft` at the
   confirmed head and prints which links it would keep and release
   (`creation_missing`, `id_changed`: the id now belongs to another draft, or
   `parameters_changed`: same id, different reward, cap or window). A
   `warning` field means a worker (or another `--apply`) still holds the
   deployment. The dry run only looks at `pg_locks`; it never takes the lock.
4. Review the plan, then
   `pnpm --filter @vham/api reorg:recover:start -- --apply`. It first records
   the halt again (or records one, if you start recovery without a detected
   reorg), so the API refuses participation before anything changes; then
   released campaigns return to `draft`, the index is dropped and the halt is
   marked *recovery applied*. **The halt stays**; the API keeps refusing.
   `--apply` takes the deployment lock (a PostgreSQL session advisory lock
   that every running worker holds, and checks before each pass) and refuses
   with `mode: "refused"` and exit code 1 while a worker holds it: go back to
   step 2. A worker whose session dropped notices before its next pass and
   exits; whatever it was writing meanwhile is refused by the cursor check.
5. Start the worker (`pnpm --filter @vham/api indexer:start`). It rebuilds the
   index from the deploy block, links canonical creations and re-syncs
   statuses. It clears the halt itself
   (`reorg recovery verified; participation resumes`) only when the stored
   index has caught up to the confirmed head, every link verifies, and every
   link's indexed funding and payouts equal the contract's. Until then it logs
   why it is waiting (`reorg recovery not verified yet`); VhamChainHalted
   resolves when the halt is gone. A rebuild that takes more than 5 minutes
   also raises VhamIndexerStalled until its first pass ends
   ([VhamIndexerLag / VhamIndexerStalled](#vhamindexerlag--vhamindexerstalled)
   tells catching up from stuck).
6. Run `pnpm --filter @vham/api reconcile:start` afterwards.

If `--apply` is run again during a rebuild (the worker must be stopped for
that), the rebuild that was running can no longer clear the halt; the
restarted worker rebuilds again. Index writes that would land on a reset index
are refused (`Index cursor moved`), so a halt is never cleared over an index
with a gap.

Consider raising `INDEXER_CONFIRMATIONS` (used by both the API and the worker)
if this happens more than once.

### VhamRpcDown

Readiness returns 503 and claim issuance returns `CHAIN_UNAVAILABLE`. Check the
RPC provider status and credentials (never paste RPC URLs with keys into issues).

### VhamWorldIdUnavailable

World ID's verify endpoint is failing (`PROVIDER_UNAVAILABLE`: check
https://status.world.org; users get 503 and can retry), or World ID is not
configured (`WORLD_ID_NOT_CONFIGURED`: set `WORLD_ID_RP_ID`, `RP_SIGNING_KEY`
and `WORLD_ID_APP_ID`; a retry does not help). Without the configuration,
`POST /world-id/request` already answers `503 WORLD_ID_NOT_CONFIGURED`, before
any verification (`vham_world_id_requests_total`). No eligibility is recorded
on failure. The rule counts each outcome, metric and instance separately (3
refused requests and 3 refused verifications do not add up), and
`increase()` extrapolates to the whole range, so it can fire on the third
failure.

### VhamServerErrors

Group `vham_http_requests_total{status=~"5.."}` by route, then search logs for
`"level":50` with that route's `requestId`s.

## Running the built API

A production image has no `tsx` (a dev dependency): build once with
`pnpm --filter @vham/api build` and run the `:start` scripts, which run
`node dist/...`. The image needs `apps/api/dist`, `apps/api/drizzle` (the
migrations) and the production dependencies.

| Script                | Runs                                                       |
| --------------------- | ---------------------------------------------------------- |
| `db:migrate:start`    | Drizzle migrations from `apps/api/drizzle`; run before `start`. |
| `start`               | The API.                                                   |
| `indexer:start`       | The chain indexer worker (one per deployment).             |
| `reconcile:start`     | One-shot settlement reconciliation; exit 1 on findings.    |
| `retention:start`     | One-shot retention, if the worker's is disabled.           |
| `reorg:recover:start` | Reorg recovery: dry run, `-- --apply` to apply.            |

Example: `pnpm --filter @vham/api db:migrate:start`, or
`node apps/api/dist/db/migrate.js` without pnpm.

**Database connection.** The worker and `reorg:recover` hold a PostgreSQL
session advisory lock on a reserved connection for the deployment, so their
`DATABASE_URL` must be a direct connection or a session-mode pooler. A
transaction-mode pooler (PgBouncer `pool_mode=transaction`) hands the session
to other clients between transactions; the lock would not mean "this worker"
and the worker would stop with `deployment lock lost`. (`prepare: false` in
`db/client.ts` does not make the worker safe behind such a pooler.) The lock's
connection is idle between lock checks (one per pass), so leave
`idle_session_timeout` unset or well above the longest pass plus the 60 s
maximum backoff.

**Stopping.** On SIGTERM or SIGINT the worker finishes the current pass,
cuts any backoff sleep short, releases its lock and exits, well within a 30 s
grace period unless a single pass takes longer.

## Client addresses behind the web app (#75)

Per-IP rate limits ([API_CONTRACT.md](../architecture/API_CONTRACT.md)) key on
the client address. The API reads it from `X-Forwarded-For`, counting
`TRUST_PROXY_HOPS` entries from the end; entries further left are set by the
caller and ignored.

Browsers reach the API through the web app's `/api/*` rewrite. The rewrite
forwards `X-Forwarded-For` exactly as it arrived and adds no entry of its own
(Next 16.4.5; `pnpm --filter @vham/web smoke:forwarded-for` checks this in
CI). Next's middleware cannot see the peer address, so the web app cannot add
it itself. With `TRUST_PROXY_HOPS=0`, the default for local development, every
browser shares the web server's address: one anonymous bucket and one
sensitive bucket (sign-in, World ID requests, eligibility, reports) for all
participants.

Production topology:

- A reverse proxy or load balancer in front of the web app appends the client
  address to `X-Forwarded-For` (or sets it). Direct API clients (API keys)
  reach the API through a proxy that does the same.
- The web app's `API_URL` points at the API directly (an internal address),
  not through the API's proxy, so both paths reach the API with exactly one
  appended entry. Set `TRUST_PROXY_HOPS` to the number of proxies that append
  on the way in: `1` in this topology.
- The web app and the API accept connections only from those proxies. A
  client that reaches either one directly chooses the last entry itself and
  with it its own rate-limit bucket.
- `API_URL` is fixed when the web app is built (the rewrite is written to
  `.next/routes-manifest.json`); rebuild after changing it.

Check after a deploy: from two different networks, call
`GET /api/v1/campaigns/00000000-0000-4000-8000-000000000000` through the web
origin a few times and compare `RateLimit-Remaining`. Each client must count
down on its own; a shared count means the proxy does not set the header or
`TRUST_PROXY_HOPS` is wrong.

## Emergency procedures (#23, ADR-0008)

Both are exercised in CI (`CampaignManager.t.sol` and the local-chain E2E).

### Emergency pause

1. Owner (multisig in production) calls `CampaignManager.pause()`:
   `cast send $CAMPAIGN_MANAGER_ADDRESS "pause()" --account <owner>`.
2. Effect: every `createCampaign`, `fundCampaign`, `claim` and
   `refundUnusedBudget` reverts with `Paused`; `closeCampaign` and
   `cancelCampaign` still work
   ([CONTRACT_SPEC.md](../architecture/CONTRACT_SPEC.md)). Nothing can move funds
   out — the owner has no withdrawal.
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

No hosted dashboard yet: the API has no hosted deployment, and production is
gated by #29. A Grafana board should chart:
request rate/5xx by route, each outcome counter, `vham_indexer_lag_blocks`,
`vham_rpc_up`, and the anomaly/violation counters. Link it here once deployed.
