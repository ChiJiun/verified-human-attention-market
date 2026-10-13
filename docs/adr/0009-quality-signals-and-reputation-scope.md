# ADR-0009: Completion-Quality Signals and Reputation Scope

- **Status:** Accepted
- **Date:** 2026-10-13
- **Issue:** #25 (privacy policy #22, Threat Model T-012, T-017)

## Context

World ID proves a unique human per campaign, not careful attention
(ADR-0002). Advertisers need to see how much of what they pay for looks like
genuine engagement. A cross-campaign reputation score would help, but it is
exactly the "wallet + identity + behavior" linkage the privacy policy
forbids without a dedicated decision.

## Decision

### 1. Campaign-scoped quality signals now

Each submission stores machine-readable reason codes (`quality_flags`),
computed deterministically at submission time from facts stored with it:

| Code | Rule (defaults) |
| --- | --- |
| `FAST_COMPLETION` | submitted < 15 s after World ID verification |
| `PASSED_ON_RETRY` | accepted after a rejected attempt by the same human |
| `CAMPAIGN_BURST` | ≥ 20 submissions to the campaign within 60 s |

- Flags are **not** shown to participants (no tuning against them) and
  **do not change payout** in the MVP: an accepted completion is paid.
- Advertiser analytics show raw `accepted`, `flaggedAccepted`,
  `adjustedAccepted = accepted − flaggedAccepted` and counts per reason.
- Thresholds are configuration (`QualityConfig`); changing them affects only
  new submissions, and the stored flags record what was decided at the time.

### 2. No cross-campaign reputation yet

There is no score that follows a person or wallet across campaigns. Before
one is built, a new ADR must decide:

- the key (never the World ID nullifier; never a raw wallet; e.g. a
  user-held credential or an opt-in pseudonym);
- what the score may be used for (ranking, eligibility, payout) and the
  appeal path;
- retention and deletion (DATA_RETENTION.md);
- the manipulation model (T-017).

### 3. Path to payout effects

If flags should one day reduce or withhold payouts, that is a change to the
claim trust model and requires its own ADR (AGENTS.md §16), a participant
-facing explanation, and a dispute path (#24).

## Consequences

- Advertisers can distinguish raw from fraud-adjusted completions today.
- Signals are weak by design (cheap to compute, explainable); they will
  miss careful farmers and flag some honest fast readers. That is acceptable
  while they are informational.
- `quality_flags` are behaviour-derived but carry no identity; they follow
  the submission's retention (kept with settlement facts, no wallet link
  after the retention window for unpaid participants).
