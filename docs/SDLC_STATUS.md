# SDLC Status / 軟體開發生命週期狀態

> Last reviewed: 2026-10-05

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
| CI | ✅ JavaScript + Foundry jobs |
| API persistence | ⬜ |
| World ID integration | ⬜ |
| Testnet deployment | ⬜ |

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

## Next SDLC Actions

1. Complete and merge/commit the CampaignManager + contract-test milestone.
2. Implement API schemas and PostgreSQL persistence (GitHub issue #8).
3. Implement the EIP-712 backend claim authorization service (#10).
4. Re-verify the current official World ID integration path, then implement eligibility verification (#9).
5. Build advertiser and verified-user flows (#11–#12).
6. Run end-to-end POC before public testnet demo (#13).

---

**Current gate:** Implementation is active. Deployment remains blocked until the local economic loop and testnet configuration are verified.
