# ADR-0010: Passive Accrual with World ID at Login and Withdrawal

- **Status:** Proposed (not accepted; does not change M1)
- **Date:** 2026-10-14
- **Affects if accepted:** ADR-0002 (first mission), ADR-0003 (gas UX), ADR-0004 (claim authorization), ADR-0005 (economics), ADR-0007 (World ID scope), ADR-0009 (quality signals)
- **Owner decisions:** 2026-10-14 (see below)
- **Related issues:** #22 privacy, #23 signer custody, #27 publisher SDK, #29 production readiness
- **External sources (checked 2026-10-14):** https://docs.world.org/world-id/idkit/session-proofs, https://docs.world.org/world-id/idkit/integrate

## Context

M1 proved the trust chain on Base Sepolia on 2026-10-14: a real World ID proof, an off-chain engagement check, an EIP-712 authorization and an on-chain USDC claim (see `docs/DEMO.md`). Its user experience is a one-off task per campaign: verify with World ID, answer questions, then send a claim transaction and pay gas.

The product owner's target is different:

- **R1.** Verified users earn while they browse. No questionnaire by default.
- **R2.** No wallet signature per page view or per event.
- **R3.** Users never pay gas.
- **R4.** World ID is required to log in to the platform and to withdraw, not per campaign.

The current design conflicts with all four: the comprehension check is the engagement evidence (R1), each campaign needs its own proof and authorization (R2, R4), and the claimant sends the claim transaction (R3, ADR-0003).

Constraint that does not go away: **Proof of Human is not Proof of Engagement** (AGENTS.md §13). Passive browsing is weaker evidence than an answered question, so the risk moves from bots to humans who farm or automate their own verified account.

## Owner decisions (2026-10-14)

- **D1. Platform first.** Browsing happens on the platform's own site. No third-party publisher SDK or browser extension yet (#27 stays deferred).
- **D2. Unit = advertiser-set dwell time.** Each campaign sets the required active, visible dwell time. A human is credited **at most once per campaign content**; repeat visits never accrue again.
- **D3. No per-account cap and no expiry for now.** Acceptable because every accruing account is already World ID verified (D4) and accrual is bounded by funded budgets (§2). Revisit before real funds (#29).
- **D4. World ID at login and at withdrawal.**

## Proposed decision

### 1. Off-chain accrual ledger

- The platform's own pages report engagement for a logged-in session (D1). The session comes from the World ID login, not from per-event signatures (R2).
- The API credits a campaign once the reported active, visible dwell time reaches the campaign's threshold (D2). The server enforces the threshold; the client only reports. `UNIQUE(account, campaign)` makes a second credit impossible.
- Stored per account: which campaigns were credited and the amount. No URL-level browsing history, no raw event stream after crediting (AGENTS.md §13, #22).
- The comprehension check becomes an optional, higher-reward campaign type instead of the default (R1).

### 2. Budget reserved at accrual time

Each credit reserves the campaign's funded budget immediately. Invariant: for every campaign, `reserved + paid ≤ funded`. Credits that exceed the remaining budget are not granted. This generalizes the existing cap on outstanding authorizations (#10).

### 3. World ID at login and withdrawal (R4, D4)

- **Sign-up (first login):** a uniqueness proof for one app-wide action (for example `vham-account-v1`). The nullifier becomes an HMAC account key, as in ADR-0007, so one human has exactly one account.
- **Later logins and every withdrawal:** a World ID **session proof**. Per the official docs, a session proves continuity across checks without repeating a uniqueness proof; the backend stores `session_id` against the account and rejects reused `session_nullifier` values.
- Because only verified humans can log in, there are no unverified balances, which is why D3 can drop caps and expiry.

### Privacy and minimal disclosure

World ID is a zero-knowledge system: a proof shows "a unique human, nullifier X for this app and action" and reveals nothing else (no name, no biometric data, no identity across other apps). Nullifiers differ per app and per action, so World ID does not let other apps link this account.

What this design does create is a **pseudonymous account inside our platform** that links the campaigns one human was credited for. That is a new data asset, not a World ID leak. Rules to keep it minimal:

- store only the HMAC account key, `session_id`, credited campaigns, balances and the withdrawal wallet; no name, email, IP history, device fingerprint or URL history;
- advertisers see aggregates per campaign only, never account-level rows;
- payouts are aggregated across campaigns, so the chain shows "the platform paid wallet W", not which campaigns W viewed. This is **more private on-chain than M1**, where each `RewardClaimed` publicly links a wallet to a campaign;
- users may withdraw to a fresh wallet each time;
- retention: drop per-campaign credit rows once paid and the campaign is settled, keep only totals (#22).

Residual risk: whoever operates the database can see one pseudonymous account's campaign history. This must be accepted in the #22 review.

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

Decided on 2026-10-14: browsing location (D1), credited unit (D2), caps and expiry (D3), when World ID is required (D4).

Still open:

1. Minimum withdrawal amount.
2. How gas and operations are paid for (fee percentage, minimum withdrawal, or absorbed during testing).
3. Whether the Proof of Human credential works with session proofs: the official session examples use Selfie Check. Must be verified before acceptance; if not, later logins need another uniqueness proof or an app session instead.
4. How dwell time is measured robustly on the client (visibility, focus, idle detection) and which anomalies the server rejects.

## Sequencing

Only after M1 closes (#12, #13, #19). This changes the identity model, claim trust model, gas sponsorship and economics, so it needs acceptance here plus the #22 privacy review before code. It does not touch x402 or multi-chain.
