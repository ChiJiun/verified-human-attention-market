# SDLC Status / 軟體開發生命週期狀態

> Last reviewed: 2026-10-21

Milestone 0 的 working decisions 與 System Design baseline 已收斂，目前正式進入 **Implementation**。本文件是 SDLC 執行狀態頁；README 的 roadmap 則追蹤產品成熟度。

## Current Phase

```
Planning        ✅ Complete
Requirements    ✅ Baseline complete
System Design   ✅ Baseline complete
Implementation 🟡 Active
Testing        🟡 Active
Deployment     🟡 Base Sepolia testnet only; v1 run done 2026-10-14, ADR-0011 redeploy pending; no real funds
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
| ADR-0011 Idempotent Campaign Creation | ✅ Accepted; needs a Base Sepolia redeploy |
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
| Deployment tooling / canonical ABI | ✅ Script + CI-checked ABI + fail-fast config; API and web use the canonical ABI at runtime; the API refuses a CampaignManager from before ADR-0011. The 2026-10-14 record is archived in `packages/contracts/deployments/archive/`; no current Base Sepolia record until the redeploy |
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
| Web flows | ✅ Advertiser create/fund (#11) and participant verify/answer/claim with the IDKit widget (#12); a lost RPC response, a retry or a second tab can never create a second campaign, because `createCampaign` is idempotent per draft (ADR-0011, #13). Close/refund buttons not on `main`; PR #84 (open) adds them |
| End-to-end POC | 🟡 Local anvil e2e in CI covers a lost RPC response, a concurrent resend and a same-parameter creation for another draft (ADR-0011). Base Sepolia: the v1 contract run on 2026-10-14 is complete (`docs/DEMO.md`); the run on the ADR-0011 contract is pending (#13) |
| World ID integration | ✅ Backend verification, RP signing and IDKit widget; a real production proof verified on Base Sepolia (ADR-0007, #9, #12) |
| Testnet deployment | 🟡 v1 `CampaignManager` (`0x12cc…DFEc`, 2026-10-14) ran the full flow with a real World ID proof; it is incompatible with ADR-0011 and retired. Redeploy and re-run pending (#13) |
| Operations runbook / alerts | ✅ docs/operations/RUNBOOK.md, docs/operations/alerts.yml |

## Remaining Gate Before Implementation

- [x] First buyer / use case selected.
- [x] Base selected as POC/MVP default.
- [x] POC gas UX selected.
- [x] Claim authorization trust model selected.
- [x] POC campaign economics selected.
- [x] Confirm exact current testnet addresses and external SDK/package versions immediately before testnet integration/deployment (re-checked 2026-10-13, `docs/deployment/TESTNET.md`; IDKit 4.4.0, ADR-0007).

## Implementation Evidence

- Monorepo scaffold verified with `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm format:check`.
- `CampaignManager` implements campaign creation/funding, EIP-712 claims, close/refund, replay protection, completion caps, pause, signer rotation, and single-token settlement.
- Claim authorization now includes `issuedAt` + `expiresAt`; refunds wait until the issuance deadline plus maximum authorization TTL, eliminating the off-chain authorization/refund race in the original design.
- Foundry baseline currently passes 13 unit/fuzz tests plus 3 stateful invariants.
- Stateful invariant run: 128 runs × 64 depth = 8,192 handler calls with zero invariant failures.
- Claim issuance checks the contract signer via RPC, matches the contract's EIP-712 typehash, caps distinct authorizations by campaign completion limit, and returns the same unexpired signature on retry.
- Base Sepolia run on 2026-10-14 (v1 contract, before ADR-0011) with a real World ID proof: funded 3 USDC, paid 1 USDC, refunded 2 USDC, contract balance 0; transactions in `docs/DEMO.md`.

## M1 review stack (2026-10-21)

Nothing below is merged. Every PR is open and in review, and CI was green on each at the time of writing. The owner decides the merge order and merges.

| PR | Base | Closes or refs |
| --- | --- | --- |
| #62 | `main` | Idempotent campaign creation, ADR-0011, Base Sepolia run record (#13) |
| #88 | #62 | Pool starvation and row-lock deadlock when signing acceptances (defects in #62) |
| #90 | #62 | Fixes #89, acceptance-time authorizations missing from the alert series |
| #68 | #62 | Docs reconciled with the code |
| #79 | #68 | Fixes #74, World ID 4.0 proofs only |
| #81 | #68 | Closes #73, untested `CampaignManager` reverts |
| #83 | #68 | Refs #13 and #12, Base Sepolia re-run runbook |
| #84 | #68 | Closes #69, close and refund buttons |
| #85 | #79 | Refs #71, wallet-bound World ID signal |
| #87 | #84 | Closes #72, cookie sessions, CSRF checks, nonce CSP |
| #92 | `main` | Fixes #91, generic 500 body; the same handler is needed on #62's branch after both merge |

Owner gates:

- **Merge order.** The bases imply #62 with #88 and #90 first, then #68, then #79, #81, #83 and #84, then #85 and #87 once retargeted. #92 is independent.
- **Contract cleanup decision (#80).** Decide before the ADR-0011 redeploy, because the redeploy is the next time `CampaignManager` changes on-chain.
- **Redeploy and re-run.** Needs the owner's keys and the World App scan on the owner's phone. #12 and #13 close only after that run.
- **#71 closes only after the #13 swap test passes**, run exactly as ADR-0007 describes, on PR #85's branch.

Open issues with no PR yet: #75, #76, #77, #78, #82, #86.

## Next SDLC Actions

1. Owner reviews and merges the stack above in order, and answers #80.
2. Redeploy `CampaignManager` (ADR-0011) to Base Sepolia, run the migration, and repeat the full flow (runbook in PR #83); then close M1 (#12, #13) and, if the swap test passes, #71.
3. Decide ADR-0010 (passive accrual, World ID at login and withdrawal) and run the #22 privacy review it requires.
4. Production readiness for real funds stays gated by #29 (external security review, named on-call).

---

**Current gate:** The local economic loop is verified, including ADR-0011. The Base Sepolia flow was verified on the v1 contract and must be repeated on the ADR-0011 deployment, after the owner merges the review stack. Real funds remain blocked by the production-readiness gate (#29).
