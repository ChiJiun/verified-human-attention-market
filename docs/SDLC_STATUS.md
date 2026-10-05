# SDLC Status / 軟體開發生命週期狀態

> Last reviewed: 2026-10-05

Milestone 0 的 working decisions 已收斂，目前正式進入 **System Design**。本文件是 SDLC 執行狀態頁；README 的 roadmap 則追蹤產品成熟度。

## Current Phase

```
Planning        ✅ Complete
Requirements    ✅ Baseline complete
System Design   🟡 Active
Implementation ⬜ Not started
Testing        🟡 Test plan drafted; no implementation yet
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
| Implementation skeleton | ⬜ |
| Test suite | ⬜ |
| CI | ⬜ |
| Testnet deployment | ⬜ |

## Remaining Gate Before Implementation

- [x] First buyer / use case selected.
- [x] Base selected as POC/MVP default.
- [x] POC gas UX selected.
- [x] Claim authorization trust model selected.
- [x] POC campaign economics selected.
- [ ] Confirm exact current testnet addresses and SDK/package versions immediately before scaffolding/deployment.

## Next SDLC Actions

1. Review the system-design artifacts for internal consistency.
2. Create Milestone 1 implementation issues.
3. Scaffold the monorepo: `apps/web`, `apps/api`, `packages/contracts`.
4. Implement contract state machine and tests first.
5. Implement API schemas and persistence.
6. Integrate World ID after the local economic loop works.
7. Run end-to-end test before any public testnet demo.

---

**Current gate:** System Design is active. The next transition is **System Design → Implementation**.
