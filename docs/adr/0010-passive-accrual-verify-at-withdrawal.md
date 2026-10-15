# ADR-0010: Passive Accrual with World ID at Login and Withdrawal

- **Status:** Proposed (not accepted; does not change M1)
- **Date:** 2026-10-14
- **Affects if accepted:** ADR-0002 (first mission), ADR-0003 (gas UX), ADR-0004 (claim authorization), ADR-0005 (economics), ADR-0007 (World ID scope), ADR-0009 (quality signals)
- **Owner decisions:** 2026-10-14 and 2026-10-15 (see below)
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

## Owner decisions (2026-10-15)

- **D5. Absolute guarantee for credited rewards.** Once credited, a reward can never be lost because the platform failed to commit it. The advertiser refund waits for the operator's final commitment with no timeout. Accepted cost: if the platform stops for good, the advertiser's unused budget stays locked (§5).
- **D6. Emergency path accepted for testing only.** If the platform stops, users can force their credits on-chain (paying gas) but cannot withdraw on their own. An operator-independent withdrawal is a **required gate before real funds** (#29).
- **D7. Cross-campaign account record accepted, minimized.** The platform may keep which campaigns one pseudonymous account was credited for, under the rules in "Privacy and minimal disclosure". This changes the privacy policy (`docs/privacy/DATA_RETENTION.md`, principle 1) and needs the #22 review before acceptance.
- **D8. Privacy first on-chain.** The contract verifies aggregates only; per-campaign allocation of a payout lives in the platform ledger and is audited off-chain (§5).

## Proposed decision

### 1. Off-chain accrual ledger

- The platform's own pages report engagement for a logged-in session (D1). The session comes from the World ID login, not from per-event signatures (R2).
- The API credits a campaign once the reported active, visible dwell time reaches the campaign's threshold (D2). The server enforces the threshold; the client only reports. `UNIQUE(account, campaign)` makes a second credit impossible.
- Stored per account: which campaigns were credited and the amount. No URL-level browsing history, no raw event stream after crediting (AGENTS.md §13, #22).
- The comprehension check becomes an optional, higher-reward campaign type instead of the default (R1).

### 2. Budget reserved at accrual time

Each credit reserves the campaign's funded budget immediately. Invariant: for every campaign, `reserved + paid ≤ funded`. Credits that exceed the remaining budget are not granted. This generalizes the existing cap on outstanding authorizations (#10).

An off-chain reservation alone cannot stop an advertiser refund, because the contract does not know about it. §5 makes reservations enforceable on-chain before any refund.

### 3. World ID at login and withdrawal (R4, D4)

Per the official session-proof docs (checked 2026-10-14): a session must first be **created** and verified by the backend before its `session_id` is saved; later checks **prove** that saved session; `session_nullifier` only prevents replay and is not an account identifier; and a World ID session is **not** a login credential. Linking or replacing an account's session is an account-security operation.

| Flow | World ID step | Backend |
| --- | --- | --- |
| **Enrollment** (first visit) | 1. uniqueness proof for the app-wide action (for example `vham-account-v1`); 2. create a session | Verify both. Account key = `HMAC(secret, nullifier)` (ADR-0007), so one human has one account. Save `session_id` only after verification succeeds |
| **Login** | prove the saved session | Verify; require `session_id` to equal the saved one; reject a reused `session_nullifier`. Then issue our own short-lived, HTTP-only app session. Credits accrue only under that app session |
| **Withdrawal** | prove the saved session again, bound to the withdrawal (§3a) | As login, plus the binding checks in §3a |
| **Recovery** (new phone, lost session) | uniqueness proof again, then create a new session | The same human yields the same nullifier, so the same account. Replace `session_id`, revoke all app sessions, and hold withdrawals for a cooling-off period (for example 24 h) |

Because only verified humans can log in, there are no unverified balances, which is why D3 can drop caps and expiry.

### 3a. Withdrawal authorization

A withdrawal must be bound to the account, destination, amount and a one-time identifier, so that a stolen app session or a tampered request cannot redirect funds.

1. The logged-in user requests `{ destination, amount }`. The backend creates a withdrawal record `W = { withdrawalId, accountKey, destination, amount, expiresAt }` with status `pending`.
2. The destination wallet signs an EIP-712 `WithdrawalRequest(withdrawalId, destination, amount, expiresAt)` off-chain. This costs no gas, proves control of the destination and rules out typos. It is one signature per withdrawal, not per view, so R2 still holds.
3. The backend signs the World ID RP request with `nonce = hash_to_field(keccak256(W))` instead of a random nonce, and the user proves the saved session. The backend accepts the proof only if it echoes that nonce, so the proof is bound to this exact withdrawal and cannot be reused (World also rejects duplicate RP nonces).
4. Only then is `W` marked `approved`. The payout carries `withdrawalId`; the contract stores used ids and rejects a second payout for the same id.
5. A destination the account has never used before is held for a cooling-off period, matching recovery.

### Privacy and minimal disclosure

World ID is a zero-knowledge system: a proof shows "a unique human, nullifier X for this app and action" and reveals nothing else (no name, no biometric data, no identity across other apps). Nullifiers differ per app and per action, so World ID does not let other apps link this account.

What this design does create is a **pseudonymous account inside our platform** that links the campaigns one human was credited for. That is a new data asset, not a World ID leak. Rules to keep it minimal:

- store only the HMAC account key, `session_id`, credited campaigns, balances and the withdrawal wallet; no name, email, IP history, device fingerprint or URL history;
- advertisers see aggregates per campaign only, never account-level rows;
- payouts are aggregated across campaigns, so the chain shows "the platform paid wallet W", not which campaigns W viewed. This is **more private on-chain than M1**, where each `RewardClaimed` publicly links a wallet to a campaign;
- users may withdraw to a fresh wallet each time;
- retention: drop per-campaign credit rows once paid and the campaign is settled, keep only totals (#22).

Residual risk: whoever operates the database can see one pseudonymous account's campaign history. The owner accepted this data use (D7); retention periods and safeguards are set by the #22 review, which must also change principle 1 of `docs/privacy/DATA_RETENTION.md` ("nothing that lets two campaigns be joined by person") for this model.

### 4. Gasless settlement: platform-pushed payouts (R3)

Recommended for the MVP: **option A**.

| Option | User signs | Who pays gas | Notes |
| --- | --- | --- | --- |
| **A. Operator batch payout** | one gas-free EIP-712 signature per withdrawal, from the destination wallet (§3a); nothing per view | platform | New settlement contract; operator submits batched payouts from the committed liability pool within daily caps |
| B. User claim via paymaster (ERC-4337) | one signature per withdrawal | paymaster | Keeps user-initiated claims; adds smart accounts and a paymaster provider |
| C. Merkle root per epoch | one signature, relayed | relayer | Good for many recipients; more operational complexity |

Gas becomes a platform cost, funded by a protocol fee (ADR-0005 currently sets 0%) or a minimum withdrawal amount. Paymaster and relayer availability on Base must be re-checked against official docs before option B or C is chosen (AGENTS.md §19).

### 5. New settlement contract

A new contract, not an in-place change to `CampaignManager` (no proxy upgradeability). It must keep:

- budget conservation, verified on aggregates (D8): per campaign `committed ≤ funded`, and in total `paid ≤ Σ committed` (the `userLiability` pool). A payout names no campaign, so the chain never links a wallet to the campaigns it was credited for;
- per-recipient cumulative paid amount is monotonic, so a payout cannot be replayed;
- operator payouts limited by on-chain daily caps (ADR-0006, ADR-0008 style);
- payouts identified by a one-time `withdrawalId` (§3a);
- **reservations enforced on-chain before any refund** (see below).

**Credit receipts.** Every credit gets a sequential index per campaign. With each credit the backend issues the user a signed EIP-712 receipt `CreditReceipt(campaignId, index, cumulativeAmount)`, where `cumulativeAmount` is the campaign's total credited amount up to and including that credit. The receipt names no account or wallet, so revealing it discloses nothing about the user beyond one campaign's running total.

**Liability commitment.** The contract keeps, per campaign, `committedIndex`, `committed` (moved into a platform-wide `userLiability` balance) and `paid`. `commitThrough(campaignId, index, cumulativeAmount, signature)`:

- verifies the operator's receipt signature;
- requires `index > committedIndex` and `committed ≤ cumulativeAmount ≤ funded`;
- sets `committedIndex = index` and moves `cumulativeAmount − committed` into `userLiability`.

**Anyone can call it.** The operator calls it at least daily and once after the campaign ends. A user, or a watchtower acting for users, can call it with their own receipt at any time: one receipt commits every earlier credit of that campaign too, without other users' receipts, and a receipt can never be counted twice.

**Final commitment and refund (D5).** After the campaign ends, the operator calls `finalize(campaignId, index, cumulativeAmount, signature)` with the receipt of the **last** credit it issued; this commits it like `commitThrough` and starts a challenge window (for example 7 days). During the window anyone may still call `commitThrough` with a receipt of a higher index, which raises `committed`. The advertiser can refund `funded − committed` only after the window ends, and refunding closes the campaign. There is **no timeout**: without a final commitment the advertiser can never refund, so no credit can be lost to a refund because the platform failed to commit it.

**Balance rule.** A credit is owed from the moment its receipt is issued, and it never expires (D3):

- normal operation: the operator commits daily and finalizes after the end;
- platform omission: the refund cannot happen, so the credit stays enforceable; the holder (or a watchtower) can commit it at any time;
- operator error or fraud (a final commitment below an issued receipt): the user's client checks the finalized index against its receipts and submits any higher one during the challenge window automatically. A receipt above a finalized-and-refunded campaign's index is cryptographic evidence of operator misconduct.

Submitting a receipt costs gas, paid by the submitter or a watchtower: the one exception to R3, for emergencies only.

**Accepted costs.** If the platform stops for good, (a) the advertiser's unused budget stays locked, because no final commitment will come, and (b) committed user funds stay in `userLiability` because only the operator pays out (D6). Both are acceptable on testnet. Before real funds (#29), an operator-independent exit must exist, for example receipts bound to a user key that can withdraw after a long operator inactivity period, plus a matching advertiser exit.

Bound on operator power: it can only commit what it signed receipts for, never more than was funded, and it cannot finalize below a receipt without that being challengeable and provable. It still decides who is paid out of `userLiability` (see Trust model change).

**Per-campaign allocation (D8).** The contract does not know which campaigns a payout comes from. The platform ledger allocates each payout to the account's credits; with each daily commitment the operator publishes a Merkle root of account balances, so an account can verify its own balance and an auditor can check that allocations sum to the committed totals, without the chain linking wallets to campaigns.

## Trust model change

In M1 the user holds a signed authorization and settles it alone. Under option A the user trusts the platform to pay out accrued balances. Funds stay escrowed on-chain and the operator is bounded by funded budgets, signed receipts, one-time withdrawal ids and daily caps, but within those limits it decides who is paid. Users can force their credits into `userLiability` without the operator, but cannot withdraw without it (D6). The published Merkle root of balances (§5) makes the platform's ledger auditable.

## Rejected alternatives

- **World ID only at registration:** an account verified once can later be rented or automated, while still accruing. Verification must gate money leaving the platform.
- **Signed event per view:** violates R2 and adds no real security; a farmed account can sign as easily as it can browse.
- **User-paid claims:** violates R3. Small rewards are irrational if users need native gas first (ADR-0003 already flagged this).

## Open questions for the product owner

Decided: browsing location (D1), credited unit (D2), caps and expiry (D3), when World ID is required (D4), reward guarantee (D5), platform-stop behaviour (D6), cross-campaign record (D7), on-chain verification scope (D8).

Still open:

1. Minimum withdrawal amount.
2. How gas and operations are paid for (fee percentage, minimum withdrawal, or absorbed during testing).
3. Whether the Proof of Human credential works with session proofs: the official session examples use Selfie Check. Must be verified before acceptance; if not, login and withdrawal need a different World ID check.
4. Whether enrollment can run the uniqueness proof and session creation in one World App interaction or needs two.
5. Whether a session-proof result echoes the RP `nonce` (needed for §3a step 3). If not, bind the withdrawal through the proof `signal` instead, if session proofs support one.
6. How dwell time is measured robustly on the client (visibility, focus, idle detection) and which anomalies the server rejects.
7. Whether dormant balances should eventually expire after all (D3), since committed liabilities otherwise stay in the contract indefinitely.
8. Length of the challenge window after the final commitment, and whether the platform runs an independent watchtower.
9. Design of the operator-independent exit required before real funds (D6).

## Sequencing

Only after M1 closes (#12, #13, #19). This changes the identity model, claim trust model, gas sponsorship and economics, so it needs acceptance here plus the #22 privacy review before code. It does not touch x402 or multi-chain.
