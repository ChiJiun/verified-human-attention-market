# ADR-0002: Start with Sponsored Content + Comprehension Check

- **Status:** Proposed
- **Date:** 2026-10-05
- **Scope:** First POC/MVP mission

## Context

The platform can eventually support many human tasks:

- sponsored content;
- product research;
- dApp testing;
- surveys;
- AI human evaluation;
- structured feedback.

Trying to build a generic mission marketplace first would make engagement verification, UX, pricing, and fraud modeling too broad.

## Decision

Use **Sponsored Content + Short Comprehension Check** as the first mission.

Example:

1. Advertiser funds a campaign.
2. Verified user reads a page.
3. User answers 1–3 content-specific questions.
4. Backend evaluates the response.
5. Valid completion receives USDC claim authorization.

## Why

- Closest to the original advertising concept.
- Easy for a buyer to understand.
- Stronger engagement signal than raw click.
- Simple enough for deterministic POC verification.
- Allows World ID, escrow, completion verification, and reward settlement to be tested end to end.
- Can later evolve into richer missions without changing the core financial architecture.

## What This Does Not Prove

Passing a comprehension question does **not** prove deep attention or conversion.

It is a baseline mechanism to test whether buyers value a higher-quality, unique-human completion more than a raw impression/click.

## Alternatives

### Survey

Simple but shifts the product immediately toward research rather than attention advertising.

### dApp task

More Web3-native but adds wallet/action verification complexity before the core reward loop is validated.

### AI human evaluation

Potentially high-value long term, but requires structured task/result schemas and buyer integration before the basic marketplace exists.

## Exit Criteria

The mission is successful as an MVP primitive if:

- it can be completed on mobile;
- completion can be evaluated deterministically;
- duplicate reward farming is blocked at the claim layer;
- the buyer receives useful aggregate outcome data;
- at least one real buyer is willing to repeat the campaign.

## Acceptance Gate

- [ ] Project owner accepts this as the first mission or selects a replacement.
