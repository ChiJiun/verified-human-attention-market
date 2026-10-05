# ADR-0003: POC Gas UX

- **Status:** Accepted
- **Date:** 2026-10-05
- **Scope:** POC
- **Decision:** User pays gas on testnet for the first POC; sponsored gas is required to be reconsidered before real-money MVP.

## Context

The POC must validate the end-to-end flow with minimum infrastructure. Gas sponsorship adds relayer/paymaster design, abuse controls, and additional operational dependencies before the core reward loop is proven.

## Decision

For the first POC:

- deploy on a test environment;
- user submits the claim transaction;
- user pays testnet gas;
- the UI must estimate and display the transaction requirement;
- no relayer/paymaster is required.

For real-money MVP, this ADR must be revisited. Small USDC rewards can become irrational if users must separately obtain native gas.

## Consequences

### Positive

- smallest implementation surface;
- easiest transaction debugging;
- no relayer key custody;
- no sponsored-gas abuse vector in POC.

### Negative

- not representative of ideal consumer UX;
- cannot be assumed acceptable for production;
- World App / mobile users may experience friction.

## Upgrade Path

Evaluate, in order:

1. native smart-account / wallet sponsorship capability;
2. paymaster / account-abstraction flow;
3. application relayer with strict campaign and payout limits.

## Exit Criteria

POC is acceptable if the claim flow succeeds reliably on testnet. MVP design cannot be considered complete until gas sponsorship economics are reviewed.
