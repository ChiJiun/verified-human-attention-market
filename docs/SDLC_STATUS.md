# SDLC Status / 軟體開發生命週期狀態

> Last reviewed: 2026-10-13

Milestone 0 的 working decisions 與 System Design baseline 已收斂，目前正式進入 **Implementation**。本文件是 SDLC 執行狀態頁；README 的 roadmap 則追蹤產品成熟度。

## Current Phase

```
Planning        ✅ Complete
Requirements    ✅ Baseline complete
System Design   ✅ Baseline complete
Implementation 🟡 Active
Testing        🟡 Active
Deployment     ⬜ Not started
Operations     ⬜ Not started
```

## Working Product Decision

目前採用以下 **可逆的 working assumptions**，避免因輕微未決事項阻塞開發。正式進入 Implementation 前仍可由專案 owner 修改。

| Decision | Working choice | Status |
| --- | --- | --- |
| First buyer | Advertiser / creator | Working assumption |
| First mission | Sponsored article/content + short comprehension check | Working assumption |
| Settlement | USDC | Working assumption |
| MVP chain | Base | Accepted in ADR-0001 |
| Identity | World ID external integration | Accepted baseline |
| Proof of engagement | Off-chain verifier + EIP-712 claim authorization | Accepted in ADR-0004 |
| POC gas UX | User pays testnet gas | Accepted in ADR-0003 |
| POC economics | 1 test USDC × max 10, 0% fee | Accepted in ADR-0005 |
| Agent payment | x402, later milestone | Deferred |
| Multi-chain | None in MVP | Accepted principle |
| AARC | Only after multi-chain decision gate | Deferred |
| Native token | None | Out of scope |

## Why Base is the current default

As of 2026-10-05:

- Circle lists **Base** and **World Chain** among networks with native USDC support.
- World documentation supports **external integrations**, so the website does not have to live on World Chain merely to use World ID.
- x402 v2 supports EVM networks, and the reference specification includes Base Sepolia (`eip155:84532`) examples.

This makes Base a practical POC/MVP default while keeping World Chain as a credible alternative.

Official references:

- World Developer Docs: https://docs.world.org/
- World API reference: https://docs.world.org/reference/api
- Circle USDC: https://www.circle.com/usdc
- x402 protocol: https://github.com/x402-foundation/x402

## SDLC Artifacts

| Artifact | Status |
| --- | --- |
| Product Brief | ✅ Drafted |
| Requirements | ✅ Drafted |
| MVP Architecture | ✅ Drafted |
| ADR-0001 MVP Chain | ✅ Accepted |
| ADR-0002 First Use Case | ✅ Accepted |
| ADR-0003 POC Gas UX | ✅ Accepted |
| ADR-0004 Claim Authorization | ✅ Accepted |
| ADR-0005 POC Economics | ✅ Accepted |
| ADR-0006 On-chain Exposure Limits | ✅ Accepted |
| ADR-0007 World ID Integration | ✅ Accepted |
| ADR-0008 Signer Custody and Payout Limits | ✅ Accepted |
| ADR-0009 Quality Signals and Reputation Scope | ✅ Accepted |
| API Spec v0 | ✅ Drafted |
| Contract Spec v0 | ✅ Drafted |
| Data Model v0 | ✅ Drafted |
| Claim Authorization Design | ✅ Drafted |
| Threat Model v0 | ✅ Drafted |
| Test Plan v0 | ✅ Drafted |
| Implementation skeleton | ✅ Monorepo scaffold |
| CampaignManager contract | ✅ Baseline implemented |
| Contract test suite | ✅ Unit + fuzz + invariants |
| JavaScript test suite | ✅ API/shared baseline |
| CI | ✅ JavaScript + Foundry + local-chain E2E jobs; failures as annotations |
| API persistence | ✅ Campaigns, missions, eligibility, submissions (#8, #15) |
| Engagement verifier | ✅ Deterministic comprehension check (#15) |
| Submission endpoint | ✅ Eligibility + verifier + persistence, 2-attempt cap |
| On-chain exposure limits | ✅ ADR-0006 (#18) |
| Deployment tooling / canonical ABI | 🟡 Script + CI-checked ABI + fail-fast config; API and web both use the canonical ABI at runtime (#19); testnet record pending |
| Claim authorization service | ✅ EIP-712 signing, live on-chain checks, paid + outstanding cap, reissue after expiry (#10) |
| Wallet authentication (SIWE) | ✅ #37 |
| Chain indexer / reconciliation | ✅ Reorg-safe event worker and confirmed campaign state (#17, #16) |
| Advertiser analytics | ✅ Reconciled, advertiser-only via SIWE (#20, #37) |
| Observability | ✅ Request ids, redacted JSON logs, Prometheus metrics, payout anomaly alert, runbook (#21) |
| Privacy / retention | ✅ Policy, scheduled enforcement, wallet erasure (#22, docs/privacy/DATA_RETENTION.md) |
| Moderation / disputes | ✅ Review gate, URL policy, reports, take-down, append-only audit (#24, docs/operations/MODERATION.md) |
| Signer custody / payout limits | ✅ KMS signing service, rotation + pause drills, 24 h limit (#23, ADR-0008) |
| Public API contract | ✅ Scoped API keys, rate limits, retryable error model, versioning (#26, API_CONTRACT.md) |
| Production-readiness gate | 🟡 Reconciliation, backup/restore drill, incident process (#29); external review + named on-call pending |
| Quality signals | ✅ Campaign-scoped reason codes, fraud-adjusted analytics; cross-campaign reputation deferred (#25, ADR-0009) |
| Web flows | ⬜ #11, #12 |
| End-to-end POC | 🟡 Local anvil E2E in CI (`docs/DEMO.md`); Base Sepolia pending (#13) |
| World ID integration | 🟡 Backend verification (ADR-0007, #9), RP signature endpoint and `IDKitRequestWidget` in the mission page (#12, IDKit 4.4.0). Not yet exercised against a real World App / Developer Portal app: that happens in the Base Sepolia run (#13) |
| Testnet deployment | ⬜ Runbook ready (docs/deployment/TESTNET.md); needs owner keystore + RPC |
| Operations runbook / alerts | ✅ docs/operations/RUNBOOK.md, docs/operations/alerts.yml |

## Remaining Gate Before Implementation

- [x] First buyer / use case selected.
- [x] Base selected as POC/MVP default.
- [x] POC gas UX selected.
- [x] Claim authorization trust model selected.
- [x] POC campaign economics selected.
- [ ] Confirm exact current testnet addresses and external SDK/package versions immediately before testnet integration/deployment.

## Implementation Evidence

- Monorepo scaffold verified with `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm format:check`.
- `CampaignManager` implements campaign creation/funding, EIP-712 claims, close/refund, replay protection, completion caps, pause, signer rotation, and single-token settlement.
- Claim authorization now includes `issuedAt` + `expiresAt`; refunds wait until the issuance deadline plus maximum authorization TTL, eliminating the off-chain authorization/refund race in the original design.
- Foundry baseline currently passes 13 unit/fuzz tests plus 3 stateful invariants.
- Stateful invariant run: 128 runs × 64 depth = 8,192 handler calls with zero invariant failures.
- Claim issuance checks the contract signer via RPC, matches the contract's EIP-712 typehash, caps distinct authorizations by campaign completion limit, and returns the same unexpired signature on retry.

## Next SDLC Actions

1. Add wallet authentication for advertiser ownership and analytics (#37).
2. Build advertiser and verified-user flows (#11–#12).
3. Complete advertiser analytics access control (#20).
4. Run end-to-end POC before public testnet demo (#13).

---

**Current gate:** Implementation is active. Deployment remains blocked until the local economic loop and testnet configuration are verified.
