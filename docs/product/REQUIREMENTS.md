# MVP Requirements / MVP 需求規格

> Status: Draft  
> Scope: POC → MVP  
> Language: Traditional Chinese with technical identifiers in English
>
> Implementation status reviewed: 2026-10-19

每個 P0 requirement 都必須有可驗證的 acceptance criteria。

# Functional Requirements

## FR-001 Wallet Connection

**Status (2026-10-19):** implemented in `apps/web` (injected wallet via viem; network check against `NEXT_PUBLIC_CHAIN_ID`, switch-chain button; EIP-1193 4001 rejections are shown, not thrown). Not covered by automated UI tests.

**Requirement:** Advertiser 必須能連接 EVM wallet。

**Acceptance criteria:**

- [x] 使用者可以 connect / disconnect wallet。
- [x] UI 顯示 active address 與 network。
- [x] Wrong network 時有明確提示。
- [x] Wallet rejection 不造成 application crash。

## FR-002 Create Campaign

**Status:** implemented — `POST /v1/campaigns` with `Idempotency-Key`, validated by `createCampaignSchema` (`campaigns.test.ts`); on-chain window/limit checks in `createCampaign` (Foundry).

**Requirement:** Advertiser 可以建立 campaign draft。

最少欄位：

- content URL / content payload；
- reward per valid completion；
- maximum completions；
- start time；
- end time。

**Acceptance criteria:**

- [x] 無效時間區間無法建立。
- [x] reward <= 0 無法建立。
- [x] max completions <= 0 無法建立。
- [x] 建立後可取得唯一 campaign ID。

## FR-003 Fund Campaign with USDC

**Status:** implemented — `fundCampaign` requires the exact budget and the draft reference, marks the campaign `Active` and pulls the USDC in the same transaction, so a failed `transferFrom` reverts everything; the token is fixed at deployment (`rewardToken`, Base Sepolia USDC checked against the official address at API startup). Evidence: Foundry funding tests and invariants, e2e.

**Requirement:** Advertiser 使用 USDC funding campaign escrow。

**Acceptance criteria:**

- [x] funded amount 可由 contract state / event 驗證。
- [x] campaign liability 不得大於 funded budget。
- [x] transfer failure 時 campaign 不得被誤標為 funded。
- [x] 不接受錯誤 reward token。

## FR-004 Human Eligibility Verification

**Status:** implemented (ADR-0007) — `world-id.test.ts`, `eligibility.test.ts`; a real proof verified on Base Sepolia on 2026-10-14 (`docs/DEMO.md`).

**Requirement:** User 在參與 restricted mission 前必須通過 World ID verification。

**Acceptance criteria:**

- [x] Backend 可以驗證 World ID proof。
- [x] 無效 proof 被拒絕。
- [x] 同一 action / campaign 的重複資格依 policy 被拒絕。
- [x] Proof verification failure 不會發出 claim authorization。

## FR-005 Complete First Mission

**Status:** implemented — `submissions.test.ts`, `verifier.test.ts`, `persistence.test.ts`; the API also reads the contract live before accepting (ADR-0011).

**Requirement:** User 可以完成第一種 mission：閱讀 sponsored content + comprehension check。

**Acceptance criteria:**

- [x] campaign active 才能 submit。
- [x] comprehension answer 會被 verifier 評估。
- [x] expired / closed campaign submit 被拒絕。
- [x] completion request 可安全 retry，不重複產生 reward liability。

## FR-006 Claim Authorization

**Status:** implemented — `claims.test.ts` (tamper test over every field and domain component), `test_ClaimAuthorizationTypehashMatchesBackend`.

**Requirement:** 通過 eligibility + engagement verification 後，系統產生可供 contract 驗證的 claim authorization。

**Acceptance criteria:**

- [x] authorization 綁定 campaign（及 draft，ADR-0011）。
- [x] authorization 綁定 claimant。
- [x] authorization 綁定 reward amount。
- [x] authorization 有 nonce / unique identifier。
- [x] authorization 有 `issuedAt` 與 `expiresAt`。
- [x] authorization lifetime 不超過 contract-defined maximum TTL。
- [x] 修改任一欄位後驗證失敗。

## FR-007 Claim Reward

**Status:** implemented — `test_CreateFundAndClaim`, `test_DuplicateNonceRejected`, `test_OneWalletCannotClaimTwice`, `test_CompletionLimitReached`, invariants; e2e asserts exact balances.

**Requirement:** User 可以使用有效 authorization claim USDC。

**Acceptance criteria:**

- [x] reward amount 精確。
- [x] 同一 authorization 無法 claim 第二次。
- [x] budget 不足時 transaction fail-safe。
- [x] claim event 可供 indexer 追蹤。

## FR-008 Close / Expire Campaign

**Status:** implemented — pre-close authorizations stay claimable until expiry, post-close ones are rejected (`test_PreCloseAuthorizationRemainsClaimableAfterClose`, `test_PostCloseAuthorizationRejected`); the API stops issuing as soon as `closedAt != 0` or `endTime` passed.

**Requirement:** Campaign 可以依規則 closed / expired。

**Acceptance criteria:**

- [x] expiry 後不得新增 valid completion liability。
- [x] closed campaign 不接受新的 claim authorization。
- [x] 已授權且未過期 claim 的處理規則必須 deterministic。

## FR-009 Refund Unused Budget

**Status:** implemented — refund only after issuance deadline + `MAX_AUTHORIZATION_TTL` (`test_RefundWaitsForAuthorizationGracePeriod`), `CampaignRefunded` event indexed and reconciled. The web app has no refund button yet (sent with `cast`).

**Requirement:** Advertiser 可以回收合法 unused USDC。

**Acceptance criteria:**

- [x] 未結清 liability 不可被提走。
- [x] refund amount 可由 accounting 算式驗證。
- [x] refund event 可稽核。

## FR-010 Basic Advertiser Analytics

**Status:** implemented — `GET /v1/campaigns/:id/analytics` (SIWE or API key): planned budget, accepted / rejected / fraud-adjusted completions, confirmed funded / paid / remaining from indexed events (`onchain.test.ts`, e2e).

**Requirement:** Advertiser 可以查看基本 campaign outcome。

至少包含：

- funded budget；
- valid completions；
- paid rewards；
- remaining budget；
- rejected submissions count；
- campaign status。

# Non-Functional Requirements

## NFR-001 Budget Invariant

**Status:** enforced on-chain (`invariant_BudgetIsConserved`, `invariant_PaidRewardsNeverExceedFunding`); protocol fee is 0 in the POC, outstanding authorizations are bounded off-chain by the issuance cap.

任何時間：

```
paidRewards + protocolFees + refundableBalance <= fundedBudget
```

不得因 retry、race condition 或 replay 被破壞。

## NFR-002 Idempotency

**Status:** implemented for campaign creation, on-chain creation (`draftRef`, ADR-0011), submissions and claim issuance (one authorization per accepted submission).

會改變 financial state 的 backend request 必須具備 idempotency strategy。

## NFR-003 Replay Resistance

**Status:** World ID nullifier per campaign action; EIP-712 nonce + `claimedWallet`; SIWE nonces consumed once.

World ID proof、claim authorization 與 reward claim 都必須考慮 replay。

## NFR-004 Key Security

**Status:** plaintext signer keys refused off anvil / Base Sepolia; production signs through a KMS-backed service (ADR-0008); logs redact signatures and keys.

Production 不得把 claim signer private key：

- commit 到 repository；
-放在 client-side bundle；
-輸出到 logs。

## NFR-005 Observability

**Status:** request ids, redacted JSON logs, Prometheus metrics, payout anomaly and signer alerts (`docs/operations/RUNBOOK.md`, `alerts.yml`).

至少能追蹤：

- campaign creation failure；
- funding failure；
- proof verification failure；
- claim authorization failure；
- claim transaction failure；
- abnormal payout rate。

## NFR-006 Privacy

**Status:** only an HMAC participant key per campaign is stored; retention and erasure in `docs/privacy/DATA_RETENTION.md` (#22).

不得為了方便 analytics 而直接公開把 World ID-related identifier 與完整 behavioral history 綁在一起。

## NFR-007 Mobile UX

**Status:** not verified. The pages are plain responsive HTML and the IDKit widget is mobile-first, but no mobile browser test has been run; part of the Base Sepolia re-run (#12).

User mission 與 claim flow 必須能在 mobile browser 正常操作。

## NFR-008 Chain Failure Handling

**Status:** confirmation depth, orphaning of reorged events, halt on deep reorg with a recovery job, reconciliation job (ADR-0011, #17, #29).

RPC timeout / reorg / delayed confirmation 不得造成 backend 與 chain state 永久不一致。

# POC Simplifications

POC 可以暫時：

- 使用 testnet；
- 使用 single backend signer；
- 使用簡單 deterministic quiz verification；
- 由 user 自付 gas；
- 不做 publisher；
- 不做 x402。

但這些 simplification 必須在進入 Production 前重新 review。

# Traceability

| Requirement | Test |
| --- | --- |
| FR-002 | `apps/api/test/campaigns.test.ts`; Foundry create validation tests |
| FR-003 | Foundry funding tests, `testFuzz_FundingEqualsMaximumLiability`, e2e |
| FR-004 | `world-id.test.ts`, `eligibility.test.ts`, `rp-signature.test.ts`; real proof on Base Sepolia (`docs/DEMO.md`) |
| FR-005 | `submissions.test.ts`, `verifier.test.ts`, `persistence.test.ts` |
| FR-006 | `claims.test.ts` (tamper + expiry), `test_ClaimAuthorizationTypehashMatchesBackend` |
| FR-007 | `test_CreateFundAndClaim`, `test_DuplicateNonceRejected`, `test_OneWalletCannotClaimTwice`, e2e balances |
| FR-008 | `test_PreCloseAuthorizationRemainsClaimableAfterClose`, `test_PostCloseAuthorizationRejected`, e2e close |
| FR-009 | `test_RefundWaitsForAuthorizationGracePeriod`, `invariant_BudgetIsConserved`, e2e refund |
| FR-010 | `onchain.test.ts` analytics, e2e |
| NFR-001 | Foundry invariants (128 runs × 64 depth in CI) |
| NFR-002 | `campaigns.test.ts`, `submissions.test.ts`, `postgres.integration.test.ts`, e2e idempotent creation |
| NFR-003 | `world-id.test.ts`, `auth.test.ts`, Foundry replay tests |
| NFR-005 | `observability.test.ts` |
| NFR-007 | manual, pending (#12) |
| NFR-008 | `chain-indexer.test.ts`, `onchain.test.ts` (recovery), `reconciliation.test.ts` |
