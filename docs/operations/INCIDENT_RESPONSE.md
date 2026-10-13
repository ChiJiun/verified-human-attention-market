# Incident Response

> Issue #29. Runbook for individual alerts: [RUNBOOK.md](./RUNBOOK.md).

## Owner and on-call

| Role | Who |
| --- | --- |
| Service owner | _to be named by the project owner_ |
| On-call (primary / secondary) | _to be named_ |
| Contract owner signers (multisig) | _to be named_ (ADR-0008) |

Until these are filled in, the project owner is all roles.

## Severity

| Level | Examples | Response |
| --- | --- | --- |
| SEV1 | `UNBACKED_PAYOUT`, signer compromise suspected, accounting violation, funds at risk | Page now; pause the contract first, investigate second |
| SEV2 | Claims failing for everyone (`SIGNER_UNAVAILABLE`, RPC down), indexer stalled or stopped on reorg | Page; fix within hours |
| SEV3 | Elevated rejections, World ID provider errors, single-campaign issues | Next business day |

## First hour (SEV1/SEV2)

1. Open an incident issue with the **Incident** template; you are the
   incident lead until you hand over in the issue.
2. Contain: for SEV1, run [Emergency pause](./RUNBOOK.md#emergency-pause).
   Stop issuance by unsetting the signer if the API itself is suspect.
3. Preserve evidence: request ids, `alert` log lines, claim tx hashes,
   `pnpm --filter @vham/api reconcile` output. Do not delete data.
4. Diagnose with the runbook entry for the firing alert.
5. Recover: rotate the signer if needed, unpause, confirm
   `reconcile` is clean and alerts are resolved.
6. Communicate: post status to affected advertisers; never share wallet
   lists, participant data or key material.

## After the incident

Write a postmortem within 5 business days using
[POSTMORTEM_TEMPLATE.md](./POSTMORTEM_TEMPLATE.md), blameless, with
action items as issues. For every money or authorization bug, add a
regression test before or with the fix (AGENTS.md §15).
