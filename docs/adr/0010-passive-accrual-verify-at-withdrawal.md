# ADR-0010: Passive Accrual with Verification at Withdrawal

- **Status:** Proposed (not accepted; does not change M1)
- **Date:** 2026-10-14
- **Affects if accepted:** ADR-0002 (first mission), ADR-0003 (gas UX), ADR-0004 (claim authorization), ADR-0005 (economics), ADR-0007 (World ID scope), ADR-0009 (quality signals)
- **Related issues:** #22 privacy, #23 signer custody, #27 publisher SDK, #29 production readiness
- **External sources (checked 2026-10-14):** https://docs.world.org/world-id/idkit/session-proofs, https://docs.world.org/world-id/idkit/integrate

## Context

M1 proved the trust chain on Base Sepolia on 2026-10-14: a real World ID proof, an off-chain engagement check, an EIP-712 authorization and an on-chain USDC claim (see `docs/DEMO.md`). Its user experience is a one-off task per campaign: verify with World ID, answer questions, then send a claim transaction and pay gas.

The product owner's target is different:

- **R1.** Verified users earn while they browse. No questionnaire by default.
- **R2.** No wallet signature per page view or per event.
- **R3.** Users never pay gas.
- **R4.** World ID is required only to bind an account and to withdraw, not on every campaign.

The current design conflicts with all four: the comprehension check is the engagement evidence (R1), each campaign needs its own proof and authorization (R2, R4), and the claimant sends the claim transaction (R3, ADR-0003).

Constraint that does not go away: **Proof of Human is not Proof of Engagement** (AGENTS.md §13). Passive browsing is weaker evidence than an answered question, so the risk moves from bots to humans who farm or automate their own verified account.

## Proposed decision

### 1. Off-chain accrual ledger

- A publisher SDK or browser extension (#27) reports engagement events for an authenticated session. The session comes from one sign-in (SIWE or app login), not from per-event signatures (R2).
- The API turns events into credited units with server-side rules: viewability, active dwell time, per-campaign and per-day caps, rate limits.
- Storage is aggregated per `(account, campaign, day)`. No URL-level browsing history is kept (AGENTS.md §13, #22).
- The comprehension check becomes an optional, higher-reward campaign type instead of the default (R1).

### 2. Budget reserved at accrual time

Each credit reserves the campaign's funded budget immediately. Invariant: for every campaign, `reserved + paid ≤ funded`. Credits that exceed the remaining budget are not granted. This generalizes the existing cap on outstanding authorizations (#10).

### 3. World ID at account binding and withdrawal (R4)

- **First withdrawal:** a uniqueness proof for one app-wide action (for example `vham-account-v1`). The nullifier is turned into an HMAC account key, as in ADR-0007, so one human has one earning account.
- **Later withdrawals:** a World ID **session proof**. Per the official docs, a session lets the same user prove continuity across checks without repeating a uniqueness proof; the backend stores `session_id` against the account and rejects reused `session_nullifier` values.
- **Unverified balances** are capped (for example 5 USDC) and expire (for example after 30 days). Expiry releases the reservation back to the campaign. This bounds the liability created by accounts that never verify.

**Privacy trade-off:** ADR-0007 deliberately makes identities unlinkable across campaigns. An earning account is cross-campaign by construction. Mitigations: keep only aggregates, never publish the account key on-chain, show advertisers only per-campaign aggregates. Payouts to a wallet remain publicly visible on-chain. This needs the #22 review before acceptance.

### 4. Gasless settlement: platform-pushed payouts (R3)

Recommended for the MVP: **option A**.

| Option | User signs | Who pays gas | Notes |
| --- | --- | --- | --- |
| **A. Operator batch payout** | nothing | platform | New settlement contract; operator submits batched payouts within on-chain per-campaign budgets and daily caps |
| B. User claim via paymaster (ERC-4337) | one signature per withdrawal | paymaster | Keeps user-initiated claims; adds smart accounts and a paymaster provider |
| C. Merkle root per epoch | one signature, relayed | relayer | Good for many recipients; more operational complexity |

Gas becomes a platform cost, funded by a protocol fee (ADR-0005 currently sets 0%) or a minimum withdrawal amount. Paymaster and relayer availability on Base must be re-checked against official docs before option B or C is chosen (AGENTS.md §19).

### 5. New settlement contract

A new contract, not an in-place change to `CampaignManager` (no proxy upgradeability). It must keep:

- budget conservation: total payouts per campaign ≤ funded budget;
- per-recipient cumulative paid amount is monotonic, so a payout cannot be replayed;
- operator payouts limited by on-chain daily caps (ADR-0006, ADR-0008 style);
- advertiser refund only after campaign end plus a settlement window, the same reasoning as the current refund delay.

## Trust model change

In M1 the user holds a signed authorization and settles it alone. Under option A the user trusts the platform to pay out accrued balances. Funds stay escrowed on-chain and the operator is bounded by budgets and caps, but within those limits it decides who is paid. Mitigation for later: publish per-epoch payout totals, or a Merkle commitment of balances.

## Rejected alternatives

- **World ID only at registration:** an account verified once can later be rented or automated, while still accruing. Verification must gate money leaving the platform.
- **Signed event per view:** violates R2 and adds no real security; a farmed account can sign as easily as it can browse.
- **User-paid claims:** violates R3. Small rewards are irrational if users need native gas first (ADR-0003 already flagged this).

## Open questions for the product owner

1. Where does browsing happen: the platform's own site, third-party publishers (SDK), or a browser extension?
2. What is one credited unit (for example an impression with ≥ N seconds of active, visible dwell)?
3. Cap and expiry for unverified balances, and the minimum withdrawal.
4. How gas and operations are paid for (fee percentage or minimum withdrawal).
5. Whether the Proof of Human credential works with session proofs: the official session examples use Selfie Check. Must be verified before acceptance.

## Sequencing

Only after M1 closes (#12, #13, #19). This changes the identity model, claim trust model, gas sponsorship and economics, so it needs acceptance here plus the #22 privacy review before code. It does not touch x402 or multi-chain.
