# Backup and Restore

> Issue #29. The chain is authoritative for settlement; the database holds
> what the chain does not: campaigns and missions, eligibility (participant
> keys), submissions and issued authorizations, moderation audit, API
> clients. Losing it does not lose funds, but it does lose the ability to
> issue claims for accepted work and the audit trail.

## What to back up

| Data | Recoverable without backup? |
| --- | --- |
| `chain_events`, `reconciliation_state` | Yes — re-index from the deploy block |
| campaigns, missions, eligibility, submissions, answers | No |
| moderation_actions, campaign_reports, api_clients | No |
| auth_nonces, auth_sessions | Not needed (users sign in again) |

## Production setup

- Managed PostgreSQL with point-in-time recovery (PITR), 7-day window
  minimum, plus a daily logical dump (`pg_dump --format=custom`) to separate
  storage, kept 30 days (aligned with the retention policy, #22).
- Backups are encrypted at rest and readable only by the operations role.

## Drill

`scripts/db/backup-restore-check.sh <database-url>` dumps the database,
restores it into a fresh database, and compares every table's row count and
content hash. It fails if anything differs or if the financial tables are
empty. CI runs it after the end-to-end test on the populated database.

Run it against a staging copy before each release and after any migration:

```bash
scripts/db/backup-restore-check.sh "$DATABASE_URL" vham_restore_check
```

## Restore procedure

1. Stop the API and the indexer worker (no writes during restore).
2. Restore the latest backup (PITR to just before the incident, or
   `pg_restore --no-owner -d <new-db> backup.dump`).
3. Run migrations: `pnpm --filter @vham/api db:migrate`.
4. Start the indexer: it resumes from the restored cursor and re-indexes
   anything newer; reorg checks still apply.
5. Run `pnpm --filter @vham/api reconcile` — it must report no findings
   before the API is started again.
6. Authorizations issued after the backup point are missing from the
   restored database but may be redeemed on-chain; reconciliation reports
   them as `UNBACKED_PAYOUT` with the claim tx. Verify each against the API
   logs (`claim_authorizations` outcome, request id) and record the result
   in the incident.
