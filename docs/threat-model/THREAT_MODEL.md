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
