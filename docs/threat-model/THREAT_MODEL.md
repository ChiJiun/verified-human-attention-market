# Threat Model v0 / 威脅模型初版

> Scope: POC → MVP  
> Status: Draft  
> This is not a security audit.

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

**Residual risk:** 真人帳號出租、多人協同、verification market。

## T-002 Proof Replay

**Threat:** 重複使用 World ID proof 或 eligibility evidence。

**Mitigation:**

- follow current World ID action/nullifier semantics；
- server-side verification；
- campaign-specific policy；
- never issue claim solely from client assertion。

## T-003 Claim Replay

**Threat:** 同一 reward authorization 多次領取。

**Mitigation:**

- unique nonce；
- on-chain consumed nonce mapping；
- signed campaign + claimant + amount + expiry；
- tests for replay。

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

## T-006 Reentrancy / Token Interaction Bug

**Threat:** malicious or unexpected token behavior around transfers。

**Mitigation:**

- support only approved USDC contract in MVP；
- Checks-Effects-Interactions；
- standard audited primitives where appropriate；
- reentrancy protection if contract flow requires it。

## T-007 Engagement Automation

**Threat:** bot can mechanically complete content/quiz after obtaining access through a human identity.

**Mitigation:**

- do not equate World ID with engagement quality；
- randomized/comprehension checks；
- rate limits；
- behavior signals；
- advertiser acceptance / fraud analytics。

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

- [ ] Contract unit tests pass.
- [ ] Invariant/fuzz tests pass.
- [ ] Replay tests pass.
- [ ] Access control review complete.
- [ ] Signer/key handling documented.
- [ ] Monitoring alerts exist.
- [ ] Pause and incident runbook tested.
- [ ] Financial exposure is capped.
- [ ] Independent review/audit performed when fund exposure justifies it.
