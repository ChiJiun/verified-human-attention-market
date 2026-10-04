# SDLC Status / 軟體開發生命週期狀態

> Last reviewed: 2026-10-05

目前正式進入 **Planning → Requirements**。本文件是目前 SDLC 的執行狀態頁，README 的 roadmap 是產品成熟度路線；這裡則追蹤每個 release 的 SDLC gate。

## Current Phase

```
Planning        ✅ Started
Requirements    🟡 Drafted
System Design   🟡 Initial architecture drafted
Implementation ⬜ Not started
Testing        ⬜ Test strategy drafted; no code yet
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
| MVP chain | Base | Proposed in ADR-0001 |
| Identity | World ID external integration | Working assumption |
| Proof of engagement | Off-chain verifier + claim authorization | Working assumption |
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
| ADR-0001 MVP Chain | ✅ Proposed |
| ADR-0002 First Use Case | ✅ Proposed |
| Threat Model v0 | ✅ Drafted |
| Implementation skeleton | ⬜ |
| Test suite | ⬜ |
| CI | ⬜ |
| Testnet deployment | ⬜ |

## Decision Gates Before Implementation

The following are the remaining P0 decisions before we call Planning complete:

- [ ] Owner confirms or changes the first buyer/use case.
- [ ] Owner confirms or changes Base as MVP chain.
- [ ] Decide POC gas UX: user-paid gas vs sponsored transaction.
- [ ] Decide claim authorization trust model for POC.
- [ ] Decide minimum campaign budget / reward unit for the POC.
- [ ] Confirm current testnet addresses and SDK/package choices immediately before coding.

## Next SDLC Actions

1. Review the Product Brief and Requirements.
2. Convert P0 requirements into GitHub issues.
3. Finalize ADR-0001 and ADR-0002.
4. Select concrete implementation stack and repository layout.
5. Enter **Implementation** by scaffolding contracts, API, and web app.
6. Add tests before testnet deployment.

---

**Current gate:** Planning is active; Requirements are sufficiently detailed to begin technical design, but Implementation should not be considered production-authorized until the two proposed ADRs are accepted.
