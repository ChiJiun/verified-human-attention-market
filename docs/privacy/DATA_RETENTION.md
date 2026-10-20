# Privacy, Retention and Deletion Policy

> Status: accepted for the POC (#22). Covers NFR-006 and Threat Model T-012.
> Enforcement: `apps/api/src/privacy/retention.ts`.

## Principles

1. **Proof of Human is not an identity record.** World ID tells us "one human
   per campaign". We never keep the proof, the nullifier, or anything that
   lets two campaigns be joined by person.
2. **The chain is public and permanent.** A paid claim (`Claimed` event)
   reveals `wallet ↔ on-chain campaign` forever. We do not add anything to
   that link, and we remove every link the chain does not already reveal.
3. **Keep settlement facts, drop behavior detail.** Campaign rows, accepted
   submissions, claim nonces and chain events back reconciliation, analytics
   and disputes. Answers and identity-derived keys go once they stop serving
   a purpose.
4. **No cross-campaign behavior graph** may be exposed by any API, export,
   analytics view or future reputation system (see "Reputation" below).

## Data inventory

| Data | Where | Class | Retention | Enforced by |
| --- | --- | --- | --- | --- |
| World ID proof (`idkitResponse`) | request only | Identity proof | Not stored; forwarded to World and dropped | Code (never persisted, logs redact `idkitResponse`/`proof`) |
| World ID nullifier | memory only | Identity | Not stored | Code (only the HMAC below is stored) |
| World ID signal (HMAC of campaign + wallet, #71) | request and response only | Pseudonymous, campaign-scoped | Not stored; World sees only its hash inside the proof | Code (derived on each request) |
| Participant key | `eligibility.participant_key` | Pseudonymous, campaign-scoped | Campaign end + 30 days, then replaced by a value derived from the row id | `applyRetention` |
| Payout wallet, unpaid (rejected / never accepted) | `eligibility`, `submissions` `claimant_address` | Personal data | Campaign end + 30 days, then replaced by an unlinkable placeholder address | `applyRetention` |
| Payout wallet, paid (accepted) | same | Personal data, also public on-chain | Life of the campaign record (settlement, disputes) | — |
| Mission answers | `answers` | Behavior | Campaign end + 30 days, then deleted | `applyRetention` |
| Submission result, rejection code, claim nonce/signature | `submissions` | Settlement / aggregate | Life of the campaign record | — |
| Quality reason codes (#25) | `submissions.quality_flags` | Behaviour-derived, campaign-scoped, no identity | Life of the campaign record; shown to advertisers only as aggregates | — |
| Advertiser wallet, campaign content | `campaigns`, `missions` | Business record | Life of the campaign record | — |
| SIWE nonces | `auth_nonces` | Security | Expiry + 1 day | `applyRetention` |
| SIWE sessions (address, `sha256(token)`) | `auth_sessions` | Security / personal | Expiry or revocation + 30 days | `applyRetention` |
| Chain events | `chain_events` | Public chain data | Indefinite | — |
| API / worker logs | stdout → log store | Operational | ≤ 30 days in the log store | Operator (log store config) |
| Metrics | Prometheus | Aggregate, no identifiers | Prometheus default | — |

"Campaign end" is `campaigns.end_at`. All windows start after end + 15 min
(`MAX_AUTHORIZATION_TTL`): claim authorizations cannot be issued after end and
expire within that TTL, so nothing needs the scrubbed data afterwards.

## Participant keys

`participantKey = HMAC-SHA256(PARTICIPANT_KEY_SECRET, "vham:participant-key:v1" ‖ campaignId ‖ nullifier)`
(`apps/api/src/privacy/participant-key.ts`).

- Combined with one World ID action per campaign (ADR-0007), keys for the
  same human differ across campaigns, so the eligibility table cannot be
  joined by person.
- Without the secret, a database leak reveals no nullifiers. The secret lives
  only in the API environment; rotating it breaks duplicate detection for
  campaigns that are still open, so rotate between campaigns.
- After retention the key is replaced by `sha256("vham:retired-participant:" ‖ row id)`:
  even the secret holder can no longer link the row to a human.

## Logs

- Request bodies are never logged. Pino redacts `authorization`/`cookie`
  headers and any `idkitResponse`, `proof`, `signature`, `privateKey` or
  `nullifier` field (`apps/api/src/observability/instrumentation.ts`).
- Critical-path rejections log the route outcome and campaign id only — no
  wallet, no answers.
- Log store retention: 30 days maximum; access limited to operators.

## Access boundaries

- Participants see only their own submission result (no answer-level
  feedback).
- Advertisers (SIWE) see aggregates for their own campaigns: counts and
  reconciled settlement. No wallet lists, no answers, no participant keys.
- Operators have database access; there is no admin API that exports
  per-person data.

## Enforcement

Scheduled (idempotent):

```bash
pnpm --filter @vham/api retention          # one-shot, e.g. daily cron
```

The indexer worker also runs it every `RETENTION_INTERVAL_MS` (default 1 h;
`0` disables). Output contains counts only.

Erasure request for a wallet:

```bash
pnpm --filter @vham/api retention --erase-wallet 0x…
```

- Applies the scrubbing at once for campaigns whose claim issuance has
  settled, and deletes the wallet's SIWE sessions.
- Campaigns still issuing claims are reported (`campaignsStillOpen`) and are
  covered by the scheduled run after they end: until then the record is what
  stops the same wallet from claiming twice.
- Paid-wallet rows stay (settlement record) and on-chain data cannot be
  erased; tell the requester this.

Both paths are covered by PostgreSQL integration tests
(`apps/api/test/postgres.integration.test.ts`, "retention (#22)").

## Reputation and future features

Any reputation, fraud-scoring or analytics feature must, before it ships:

1. stay campaign-scoped, or get an ADR that justifies a cross-campaign key
   and its privacy review;
2. never key on the World ID nullifier or on a wallet across campaigns;
3. add its data to the inventory above with a retention period and an
   enforcement path;
4. update Threat Model T-012.
