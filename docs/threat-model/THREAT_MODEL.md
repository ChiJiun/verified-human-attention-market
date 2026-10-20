# Threat Model v0 / 威脅模型初版

> Scope: POC → MVP  
> Status: Draft  
> This is not a security audit.
>
> Implementation status reviewed: 2026-10-19

## Assets

需要保護的核心資產：

- advertiser USDC；
- campaign liabilities；
- user reward entitlement；
- claim signer key；
- World ID verification flow；
- campaign completion data；
- pseudonymous reputation；
- admin privileges。

## Trust Boundaries

1. Browser ↔ Backend
2. Browser ↔ World ID / external identity provider
3. Backend ↔ RPC / blockchain
4. Backend signer ↔ Reward contract
5. Backend ↔ Database
6. Smart contracts ↔ USDC token contract
7. Future publisher / agent ↔ Public API

# Threats

## T-001 Sybil Farming

**Threat:** 同一操作者利用多個 wallet 重複領取。

**Mitigation baseline:**

- World ID unique-human eligibility；
- campaign/action-specific replay rules；
- behavioral fraud signals later。

**Implemented (#9, ADR-0007):** one World ID action per campaign, World ID 4.0 proofs only (one person's 3.0 and 4.0 nullifiers differ, so the API refuses 3.0 results), backend verification against the v4 API, `UNIQUE(campaign_id, participant_key)` and `UNIQUE(campaign_id, claimant_address)`, one accepted completion per human (partial unique index), one paid claim per wallet on-chain.

**Residual risk:** 真人帳號出租、多人協同、verification market。

## T-002 Proof Replay

**Threat:** 重複使用 World ID proof 或 eligibility evidence。

**Mitigation:**

- follow current World ID action/nullifier semantics；
- server-side verification；
- campaign-specific policy；
- never issue claim solely from client assertion。

**Implemented:** the IDKit result is forwarded unchanged to World's verify endpoint and only a nullifier that World verified is accepted; replaying the same proof returns the same eligibility (idempotent) and can never bind a second wallet. Since 2026-10-20 (#71) the proof is also bound to the claimant wallet: IDKit is opened with a server-derived salted `signal` for that wallet, and a result whose credentials do not all carry its hash is refused before World is called (`403 SIGNAL_MISMATCH`, ADR-0007 update 2026-10-20). A proof relayed from another wallet, or produced without a signal, therefore cannot create eligibility, provided World's verifier refuses a proof whose `signal_hash` was altered; the official docs do not state this for 4.0 proofs, and the #13 Base Sepolia run must confirm it (ADR-0007). The signal is an HMAC rather than the address so that World cannot match `signal_hash` against public on-chain claimants.

## T-003 Claim Replay

**Threat:** 同一 reward authorization 多次領取。

**Mitigation:**

- unique nonce；
- on-chain consumed nonce mapping；
- signed campaign + claimant + amount + expiry；
- tests for replay。

**Implemented:** `consumedNonces`, `claimedWallet`, EIP-712 domain binding, `issuedAt`/`expiresAt` with `MAX_AUTHORIZATION_TTL`, and `draftRef` (ADR-0011) so an authorization cannot be redeemed against a campaign another draft obtained under the same id after a deep reorg. Tests: `test_DuplicateNonceRejected`, `test_OneWalletCannotClaimTwice`, `test_ClaimRejectsAnotherDraftsAuthorization`, `test_AuthorizationForReorgedDraftCannotClaimTheNewCampaign`.

## T-004 Backend Signer Compromise

**Threat:** attacker 取得 signing key，偽造 claim。

**POC mitigation:**

- low funding caps；
- signer key outside repository/client；
- contract pause；
- per-campaign budget bound；
- payout limits。

**Implemented (#23, ADR-0008):**

- Production key in a KMS/HSM behind a signing service; the API never holds it, verifies every signature it gets back, and refuses plaintext keys off local/Base Sepolia.
- Rotation (`setAuthorizedSigner`) revokes all old signatures; API fails closed on mismatch. Tested in Foundry and drilled in E2E with pause.
- Loss bounded by immutable on-chain caps; liability rate bounded by the 24 h API limit; alerts on bursts, signer mismatch/unavailability and the daily limit.

**Production requirement:**

- stronger key custody；
- rotation；
- alerting；
- potentially threshold/multisig or scoped authorizers。

## T-005 Budget Accounting Bug

**Threat:** payouts/refunds exceed funded budget。

**Mitigation:**

- explicit accounting invariant；
- Foundry invariant/fuzz tests；
- simple contract state machine；
- avoid duplicate source of truth。

**Implemented:** `invariant_BudgetIsConserved`, `invariant_PaidRewardsNeverExceedFunding`, `invariant_CompletionsStayWithinCap` (stateful, 128 runs × 64 calls in CI); refund waits one authorization TTL after the issuance deadline; `checkReconciliation` compares contract state, indexed events and issued authorizations and alerts on any mismatch.

## T-006 Reentrancy / Token Interaction Bug

**Threat:** malicious or unexpected token behavior around transfers。

**Mitigation:**

- support only approved USDC contract in MVP；
- Checks-Effects-Interactions；
- standard audited primitives where appropriate；
- reentrancy protection if contract flow requires it。

**Implemented:** one immutable `rewardToken`; `claim` and `refundUnusedBudget` update state (nonce, wallet, accounting, status) before the external token call (checks-effects-interactions); transfers use a low-level call that tolerates tokens returning no data but reverts on `false`. There is no reentrancy guard; a reentrant USDC call would find the nonce already consumed and the wallet already marked. Residual: the token is trusted (official USDC only).

## T-007 Engagement Automation

**Threat:** bot can mechanically complete content/quiz after obtaining access through a human identity.

**Mitigation:**

- do not equate World ID with engagement quality；
- randomized/comprehension checks；
- rate limits；
- behavior signals；
- advertiser acceptance / fraud analytics。

**Implemented:** two attempts per verified human per campaign, answer key never served, deterministic grading, campaign-scoped quality flags (`FAST_COMPLETION`, `PASSED_ON_RETRY`, `CAMPAIGN_BURST`, ADR-0009) shown only to the advertiser. Residual: a bot driven by a verified human still passes a short quiz; see T-017.

## T-008 Human Farming

**Threat:** genuine humans mass-farm low-effort missions.

**Mitigation:**

- reputation；
- mission-specific quality gates；
- pricing / reward design；
- campaign targeting；
- anomaly review。

## T-009 Telemetry Forgery

**Threat:** client fabricates dwell time or event telemetry。

**Mitigation:**

- treat client telemetry as untrusted；
- server-issued session/challenge；
- cross-check multiple signals；
- never authorize payment on dwell time alone。

**Implemented:** the API accepts no client telemetry at all; the only engagement evidence is the server-graded answers plus server-side timestamps (`verifiedAt`, `createdAt`).

## T-010 Advertiser Malicious Content

**Threat:** phishing, malware, scam links, harmful redirects。

**Mitigation:**

- campaign moderation；
- URL/content policy；
- allowlist during early beta；
- warning/interstitial rules；
- report/takedown path。

**Implemented (#24, `docs/operations/MODERATION.md`):**

- Review gate: campaigns are not published or served until an operator approves them (allowlisted advertisers excepted); enforced by the API, `MODERATION_MODE=open` refused off anvil.
- URL policy at creation: https only, no credentials, IP literals, internal hosts or custom ports; optional domain allowlist.
- Anonymous reports, take-down (410 for new participants) and reinstate, all with reasons in an append-only audit trail.

**Residual risk:** a reviewed page can change after approval (bait-and-switch); mitigated by reports and take-down, not prevented. A campaign created directly on the contract cannot be served, but its on-chain existence cannot be prevented.

## T-011 Publisher Attribution Fraud

**Threat:** future publisher fakes referrals/completions to increase revenue share。

**Mitigation:**

- server-side attribution；
- signed publisher IDs / sessions；
- anomaly detection；
- settlement delay for suspicious traffic。

## T-012 Privacy Linkage

**Threat:** World ID-related identifier + wallet + behavior creates a persistent identity graph。

**Mitigation:**

- data minimization；
- campaign-scoped identifiers where possible；
- avoid public raw behavior history；
- separate identity verification records from analytics；
- retention policy；
- privacy review before reputation expansion。

**Implemented (#22, `docs/privacy/DATA_RETENTION.md`):**

- Proofs and nullifiers are never stored; only a campaign-scoped HMAC participant key, retired 30 days after campaign end.
- Unpaid wallet ↔ campaign links are pseudonymized 30 days after campaign end; paid wallets stay only because the chain already publishes them.
- Answers are deleted 30 days after campaign end; SIWE nonces/sessions are purged.
- Logs never contain request bodies and redact proofs, signatures, keys and nullifiers.
- Advertisers get aggregates only; no API exports per-person data.
- Wallet erasure command; reputation/analytics features must pass the policy's checklist.

**Residual risk:** paid claims are public on-chain (`wallet ↔ campaign`) and cannot be erased; a database leak before retention runs exposes wallet ↔ campaign links (but not World ID identifiers).

## T-013 RPC Failure / Reorg

**Threat:** backend misclassifies chain state after timeout/reorg。

**Mitigation:**

- event reconciliation；
- confirmation policy；
- idempotency；
- never treat timeout as definitive failure without reconciliation。

**Implemented (#16, #17, ADR-0011):** events are confirmed only `INDEXER_CONFIRMATIONS` deep; the unconfirmed tail is re-read every pass and reorged events are orphaned; logs read across a reorg are never committed; a reorg deeper than the confirmation depth halts the deployment (`indexer_halts`) so no participation or signing continues on stale links, and `reorg:recover` re-verifies every link against the contract before the index is rebuilt; drafts link by `draftRef` so a lost RPC response never leads to a second creation; the API reads the contract live before accepting a completion or signing. Residual: recovery is manual and the API is unavailable to participants during a halt.

## T-014 Admin Abuse

**Threat:** privileged operator changes campaign or drains funds。

**Mitigation:**

- minimize admin powers；
- emit events；
- timelock/multisig where appropriate for production；
- document emergency powers；
- separate pause from withdrawal authority。

**Implemented (#23):** the owner can only pause/unpause, rotate the signer and transfer ownership — no withdrawal path and no adjustable limits; production owner is a multisig separate from signer and operators (ADR-0008).

**Implemented (#24):** moderation operators are a separate SIWE role with no access to funds or settlement data; every action needs a reason and is appended to `moderation_actions` (UPDATE/DELETE rejected by trigger); submission results cannot be rewritten or deleted (trigger); settlement amounts are re-derived from chain events. Permissions are documented in `docs/operations/MODERATION.md`. Owner/signer custody remains #23.

## T-015 Wallet Impersonation / Session Theft

**Threat:** someone creates campaigns or reads analytics as another advertiser by claiming their address, replays a captured sign-in message, or steals a session token.

**Mitigation (implemented, #37):**

- EIP-4361 Sign-In with Ethereum. Messages are bound to `SIWE_DOMAIN`, the configured chain ID and a time window.
- Server-issued nonces are consumed atomically on success, so a captured message cannot be replayed.
- Signatures are verified as EOA signatures, or via ERC-1271/6492 through RPC.
- Bearer sessions expire after at most 12 h and can be revoked. Only `sha256(token)` is stored, so a database leak does not yield usable tokens.
- Advertiser-only endpoints require the session wallet to equal the campaign advertiser.
- Fail closed: without `SIWE_DOMAIN`, nobody can sign in.

**Residual risk:** the bearer token lives in browser memory and is exposed to XSS. Before beta, keep a strict CSP and consider HttpOnly cookies with CSRF protection. Participant endpoints rely on World ID wallet binding plus the contract's `msg.sender == claimant` check rather than a session.

## T-016 API Key Abuse / Scraping

**Threat:** a leaked or abused integration key creates campaigns or reads analytics as the advertiser; anonymous clients flood sign-in, eligibility or report endpoints.

**Mitigation (implemented, #26):**

- Keys are scoped (`campaigns:write`, `analytics:read`), bound to one advertiser and environment, stored as `sha256` only, and can never reach admin, key-management or session endpoints.
- Owner and operator revocation take effect on the next request; creation and revocation are audit-logged.
- Per-key, per-IP and stricter per-route (sign-in, eligibility, reports) rate limits with metrics.

**Residual risk:** limits are per instance and per IP; distributed abuse needs an edge/WAF limit in front of the API.

## T-017 Quality-Signal and Reputation Manipulation

**Threat:** farmers learn the quality rules and pace themselves (wait out `FAST_COMPLETION`, never retry, spread across time to avoid `CAMPAIGN_BURST`); wash behaviour builds a good score to be cashed out later; a competitor floods a campaign to make its completions look flagged.

**Mitigation (#25, ADR-0009):**

- Flags are never shown to participants and do not change payout, so there is nothing to win by gaming them in the MVP.
- Signals are derived from stored facts and are re-derivable; thresholds are configuration, not code.
- No cross-campaign reputation exists, so there is no score to farm or wash; one requires its own ADR with a manipulation model.
- A flood still needs a verified human per submission (World ID) and is visible as `CAMPAIGN_BURST` plus rate-limit metrics.

**Residual risk:** careful farmers are not detected; the signals are a baseline, not proof of attention.

# POC Risk Limits

Before production:

- cap campaign funding；
- cap daily payout；
- use testnet first；
- no arbitrary ERC-20 reward tokens；
- no cross-chain；
- no unaudited upgrade complexity；
- maintain emergency pause path。

# Security Exit Gate for Mainnet Beta

Status 2026-10-19 (details in `docs/operations/PRODUCTION_READINESS.md`, #29):

- [x] Contract unit tests pass (CI job `solidity`).
- [x] Invariant/fuzz tests pass (CI).
- [x] Replay tests pass (Foundry + API).
- [x] Access control review complete for the current contract (owner: pause/unpause, signer rotation, ownership transfer only; ADR-0008). To be repeated by the independent reviewer.
- [x] Signer/key handling documented (ADR-0008, RUNBOOK).
- [x] Monitoring alerts exist (`docs/operations/alerts.yml`).
- [x] Pause and incident runbook tested (Foundry, e2e drill; INCIDENT_RESPONSE.md).
- [x] Financial exposure is capped (immutable limits, 24 h payout limit; Base mainnet not configurable).
- [ ] Independent review/audit performed when fund exposure justifies it.
- [ ] Named operational owner / on-call.
