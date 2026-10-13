# Production-Readiness Gate

> Issue #29. This is a hard gate: no meaningful real funds (anything beyond
> test USDC) until every exit criterion is ✅. Status as of 2026-10-13.

## Exit criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| No known P0 financial/security findings open | 🟡 | Track with the `P0` label; none known in code today, but the external review below has not happened |
| Backup and restore tested | ✅ | CI `e2e` job: `scripts/db/backup-restore-check.sh` restores the populated database and compares every table ([BACKUP_RESTORE.md](./BACKUP_RESTORE.md)) |
| Emergency pause procedure tested | ✅ | Foundry tests + E2E drill (pause → claim fails → unpause; signer rotation) — [RUNBOOK.md](./RUNBOOK.md#emergency-procedures-23-adr-0008) |
| Financial reconciliation detects mismatches | ✅ | `checkReconciliation`: contract ↔ indexed events ↔ issued authorizations; unit tests for each finding, E2E asserts a clean report; worker gauge + alert |
| Independent security review completed | ⬜ | Needs an external reviewer; scope below |
| Operational owner and incident process documented | 🟡 | Process in [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md); the named owner/on-call rota must be filled in by the project owner |

## Workstreams

### Smart-contract security

- [x] Access-control review: owner can only pause/unpause, rotate the signer,
      transfer ownership; no withdrawal; immutable exposure limits
      (ADR-0006, ADR-0008).
- [x] Replay/accounting: nonce + one wallet per campaign, EIP-712 domain
      binding, refund delay; stateful invariants for budget conservation.
- [x] Fuzz/invariant suite in CI.
- [ ] Independent review/audit sized to the planned TVL. Scope:
      `packages/contracts/src/CampaignManager.sol`, claim issuance
      (`apps/api/src/claims/*`), signer custody (ADR-0008).

### Infrastructure

- [x] Signer key in KMS behind a signing service; plaintext keys refused off testnets (ADR-0008).
- [x] Database backup/restore drill (CI).
- [ ] Production backup schedule and retention configured (managed
      PostgreSQL PITR recommended) — deployment task.
- [x] RPC failure strategy: reads fail closed (`CHAIN_UNAVAILABLE`),
      indexer retries with backoff, readiness reports RPC state. A second RPC
      provider should be configured at deployment.
- [x] Retry strategy: idempotent mutations, `retryable` error flag,
      authorization reissue after expiry (no queue needed at MVP volume).
- [x] Reconciliation checks and structured logging/metrics (#21).

### Risk controls

- [x] Per-campaign caps on-chain; outstanding-authorization cap; 24 h payout limit.
- [x] Suspicious payout and signer alerts (`alerts.yml`).
- [x] Emergency pause runbook, exercised in CI.

### Incident response

- [x] Severity levels, roles, first-hour checklist, communication rules.
- [x] Incident issue template and postmortem template.
- [ ] Named owner and on-call rota (project owner).
