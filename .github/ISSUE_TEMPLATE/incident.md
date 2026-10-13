---
name: Incident
about: Production or testnet incident (see docs/operations/INCIDENT_RESPONSE.md)
title: "[INCIDENT][SEV?] "
labels: incident
---

## Status

- **Severity:** SEV1 / SEV2 / SEV3
- **Incident lead:**
- **State:** investigating / contained / recovered / closed

## Detection

Alert or report that triggered this, with time (UTC).

## Containment

- [ ] Contract paused (tx: )
- [ ] Claim issuance stopped (signer unset)
- [ ] Campaign taken down (id: )

## Evidence

Request ids, claim tx hashes, `pnpm --filter @vham/api reconcile` output.
Never paste keys, RPC URLs with credentials, wallet lists or participant data.

## Recovery

- [ ] Root cause fixed
- [ ] Signer rotated (if needed)
- [ ] Contract unpaused
- [ ] Reconciliation clean
- [ ] Postmortem scheduled (docs/operations/POSTMORTEM_TEMPLATE.md)
