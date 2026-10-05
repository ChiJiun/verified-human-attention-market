# Test Plan v0

> Status: System Design  
> Goal: make acceptance criteria executable before mainnet exposure.

# Contract Tests

## Unit

- campaign creation validation;
- funding;
- lifecycle transitions;
- valid claim;
- invalid signer;
- expired authorization;
- wrong claimant;
- wrong reward amount;
- consumed nonce;
- max completions reached;
- close/expiry;
- refund.

## Fuzz

Fuzz:

- funding amounts;
- reward amount boundaries;
- campaign timestamps;
- completion counts;
- claim order;
- close/refund timing.

## Invariants

At minimum:

1. paid + reserved + refundable never exceeds funded;
2. consumed nonce cannot become reusable;
3. paid completions never exceed max completions;
4. only advertiser receives campaign refund;
5. paused state prevents financial claim mutations as designed.

# API Tests

- create campaign input validation;
- invalid/expired campaign submission;
- idempotency same request;
- idempotency conflict;
- World ID verification failure;
- engagement rejection;
- signer failure;
- database retry behavior;
- analytics reconciliation.

# Integration Tests

## E2E-001 Happy Path

```
create → fund → verify human → submit → authorize → claim → index → analytics
```

## E2E-002 Duplicate Human

Second completion for same campaign/person policy is rejected before a second authorization.

## E2E-003 Duplicate Claim

Same authorization submitted twice; second transaction fails.

## E2E-004 Expired Campaign

No new accepted completion after expiry.

## E2E-005 Refund

After liabilities resolve, correct remainder returns to advertiser.

# Failure Injection

- RPC timeout after transaction broadcast;
- database transaction retry;
- World ID provider unavailable;
- signer unavailable;
- indexer restart;
- stale chain state.

# CI Gate

Implementation PRs should not merge if:

- contract tests fail;
- API unit/integration tests fail;
- typecheck fails;
- lint fails;
- generated schema/ABI changes are unreviewed.

# Mainnet Beta Gate

Mainnet financial exposure remains capped until:

- contract unit + fuzz + invariant tests pass;
- E2E critical paths pass;
- signer handling is reviewed;
- observability exists;
- emergency pause is tested;
- independent security review is appropriate for the planned exposure.
