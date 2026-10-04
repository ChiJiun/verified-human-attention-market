# MVP Requirements / MVP 需求規格

> Status: Draft  
> Scope: POC → MVP  
> Language: Traditional Chinese with technical identifiers in English

每個 P0 requirement 都必須有可驗證的 acceptance criteria。

# Functional Requirements

## FR-001 Wallet Connection

**Requirement:** Advertiser 必須能連接 EVM wallet。

**Acceptance criteria:**

- [ ] 使用者可以 connect / disconnect wallet。
- [ ] UI 顯示 active address 與 network。
- [ ] Wrong network 時有明確提示。
- [ ] Wallet rejection 不造成 application crash。

## FR-002 Create Campaign

**Requirement:** Advertiser 可以建立 campaign draft。

最少欄位：

- content URL / content payload；
- reward per valid completion；
- maximum completions；
- start time；
- end time。

**Acceptance criteria:**

- [ ] 無效時間區間無法建立。
- [ ] reward <= 0 無法建立。
- [ ] max completions <= 0 無法建立。
- [ ] 建立後可取得唯一 campaign ID。

## FR-003 Fund Campaign with USDC

**Requirement:** Advertiser 使用 USDC funding campaign escrow。

**Acceptance criteria:**

- [ ] funded amount 可由 contract state / event 驗證。
- [ ] campaign liability 不得大於 funded budget。
- [ ] transfer failure 時 campaign 不得被誤標為 funded。
- [ ] 不接受錯誤 reward token。

## FR-004 Human Eligibility Verification

**Requirement:** User 在參與 restricted mission 前必須通過 World ID verification。

**Acceptance criteria:**

- [ ] Backend 可以驗證 World ID proof。
- [ ] 無效 proof 被拒絕。
- [ ] 同一 action / campaign 的重複資格依 policy 被拒絕。
- [ ] Proof verification failure 不會發出 claim authorization。

## FR-005 Complete First Mission

**Requirement:** User 可以完成第一種 mission：閱讀 sponsored content + comprehension check。

**Acceptance criteria:**

- [ ] campaign active 才能 submit。
- [ ] comprehension answer 會被 verifier 評估。
- [ ] expired / closed campaign submit 被拒絕。
- [ ] completion request 可安全 retry，不重複產生 reward liability。

## FR-006 Claim Authorization

**Requirement:** 通過 eligibility + engagement verification 後，系統產生可供 contract 驗證的 claim authorization。

**Acceptance criteria:**

- [ ] authorization 綁定 campaign。
- [ ] authorization 綁定 claimant。
- [ ] authorization 綁定 reward amount。
- [ ] authorization 有 nonce / unique identifier。
- [ ] authorization 有 expiry。
- [ ] 修改任一欄位後驗證失敗。

## FR-007 Claim Reward

**Requirement:** User 可以使用有效 authorization claim USDC。

**Acceptance criteria:**

- [ ] reward amount 精確。
- [ ] 同一 authorization 無法 claim 第二次。
- [ ] budget 不足時 transaction fail-safe。
- [ ] claim event 可供 indexer 追蹤。

## FR-008 Close / Expire Campaign

**Requirement:** Campaign 可以依規則 closed / expired。

**Acceptance criteria:**

- [ ] expiry 後不得新增 valid completion liability。
- [ ] closed campaign 不接受新的 claim authorization。
- [ ] 已授權且未過期 claim 的處理規則必須 deterministic。

## FR-009 Refund Unused Budget

**Requirement:** Advertiser 可以回收合法 unused USDC。

**Acceptance criteria:**

- [ ] 未結清 liability 不可被提走。
- [ ] refund amount 可由 accounting 算式驗證。
- [ ] refund event 可稽核。

## FR-010 Basic Advertiser Analytics

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

任何時間：

```
paidRewards + reservedLiabilities + protocolFees + refundableBalance <= fundedBudget
```

不得因 retry、race condition 或 replay 被破壞。

## NFR-002 Idempotency

會改變 financial state 的 backend request 必須具備 idempotency strategy。

## NFR-003 Replay Resistance

World ID proof、claim authorization 與 reward claim 都必須考慮 replay。

## NFR-004 Key Security

Production 不得把 claim signer private key：

- commit 到 repository；
-放在 client-side bundle；
-輸出到 logs。

## NFR-005 Observability

至少能追蹤：

- campaign creation failure；
- funding failure；
- proof verification failure；
- claim authorization failure；
- claim transaction failure；
- abnormal payout rate。

## NFR-006 Privacy

不得為了方便 analytics 而直接公開把 World ID-related identifier 與完整 behavioral history 綁在一起。

## NFR-007 Mobile UX

User mission 與 claim flow 必須能在 mobile browser 正常操作。

## NFR-008 Chain Failure Handling

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

| Requirement | Planned test |
| --- | --- |
| FR-003 | Contract funding integration test |
| FR-004 | World ID valid/invalid/replay tests |
| FR-006 | Signature tamper + expiry tests |
| FR-007 | Claim + duplicate claim tests |
| FR-009 | Refund accounting invariant test |
| NFR-001 | Fuzz / invariant testing |
| NFR-002 | Duplicate request integration test |
| NFR-003 | Replay/adversarial tests |
| NFR-005 | Observability integration test |
