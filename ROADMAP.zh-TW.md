# 開發路線圖 — Verified Human Attention Market

[English README](README.md) | [繁體中文 README](README.zh-TW.md)

[English Roadmap](ROADMAP.md) | [繁體中文 Roadmap](ROADMAP.zh-TW.md)

這份 roadmap 追蹤產品從 **POC → MVP → Beta → Production → Protocol / Ecosystem** 的成熟過程。

目前刻意不先寫死日期，因為團隊人力、第一個市場與技術選型尚未完全確定。每個 milestone 都用 deliverables 與 exit criteria 衡量，避免「做很多功能」被誤當成「產品有進展」。

---

## Roadmap 原則

- **Single-chain first**
- **先用 USDC，不先發 native token**
- **World ID / Proof of Human 只是 anti-Sybil 的一層，不等於 Proof of Engagement**
- **x402 等核心 economic loop 跑通後，再導入 Agent / API payment**
- **AARC / chain abstraction 等真的有 multi-chain demand 再做**
- **financial invariants、monitoring、incident control 未完成前，不擴大 production risk**
- **核心 KPI 是 verified valid completion，不是 raw click**

---

## 目前狀態

| 項目 | 狀態 |
| --- | --- |
| Product thesis | 已定義 |
| Initial architecture | 已定義 |
| SDLC | 已定義 |
| Threat model | 初版 |
| MVP chain | 待決策 |
| First customer / use case | 待決策 |
| Smart contracts | 尚未開始 |
| Frontend | 尚未開始 |
| Backend | 尚未開始 |
| World ID integration | 尚未開始 |
| USDC settlement | 尚未開始 |
| x402 integration | 延後 |
| AARC integration | 延後 |

目前階段：**Planning / Requirements**

---

# Milestone 0 — Product Decision Gate

## 目標

在寫 production code 前，先鎖定最小但值得驗證的問題。

## P0 Deliverables

- [ ] 選定第一個客群：
  - advertiser / creator；
  - product research team；
  - AI human-evaluation buyer。
- [ ] 定義第一種 mission。
- [ ] 定義 valid completion。
- [ ] 重新確認當下支援狀況後，選定 MVP chain。
- [ ] 確認所選 chain 上 USDC 的正式支援狀態。
- [ ] 確認當下 World ID integration path。
- [ ] 決定 gas model。
- [ ] 決定第一版 reward model。
- [ ] 定義基本 privacy / data retention 邊界。
- [ ] 建立主要 architecture decision 的 ADR。

## Dependencies

無。

## Exit Criteria

開發者可以完整描述：

> advertiser funding → unique human 完成 mission → completion 被驗證 → user claim USDC → unused budget 可回收

而且 identity、settlement、campaign validity 沒有重大未決假設。

---

# Milestone 1 — POC：End-to-End Economic Loop

## 目標

先證明整個 economic loop 在技術上能跑通。

## Scope

一條 chain、一種 mission、一條 advertiser flow、一條 verified user flow。

## P0 Deliverables

### Contracts

- [ ] Campaign state machine
- [ ] CampaignFactory
- [ ] CampaignEscrow
- [ ] Reward claim mechanism
- [ ] Refund unused budget
- [ ] Duplicate / replay protection
- [ ] Contract events for indexing

### Identity

- [ ] World ID proof flow
- [ ] Campaign-specific uniqueness strategy
- [ ] Proof replay handling

### Backend

- [ ] Create / read campaign API
- [ ] Completion verification endpoint
- [ ] Claim authorization path
- [ ] Idempotent completion handling

### Frontend

- [ ] Advertiser wallet connection
- [ ] Create / fund campaign
- [ ] User mission page
- [ ] World ID verification UX
- [ ] Claim reward UX

### Testing

- [ ] Contract unit tests
- [ ] Basic invariant tests
- [ ] End-to-end happy path
- [ ] Duplicate claim test
- [ ] Expired campaign test
- [ ] Failed transfer / rejected wallet test

## 明確不做

- x402
- AARC
- multi-chain
- native token
- DAO
- 複雜 reputation
- ML fraud detection
- permissionless publisher ecosystem

## Exit Criteria

在 local environment 或 testnet：

1. advertiser 能 funding campaign；
2. eligible human 能完成 mission；
3. duplicate claim 會被拒絕；
4. valid claimant 收到正確 reward；
5. contract accounting 正確；
6. unused budget 可安全回收。

---

# Milestone 2 — MVP：真實買方驗證

## 目標

確認真實 buyer 是否願意重複為 verified human completion 付費。

## P0 Deliverables

- [ ] 使用正式支援的 USDC settlement
- [ ] Campaign expiration / refund
- [ ] Basic advertiser dashboard
- [ ] User mission feed
- [ ] Basic campaign analytics
- [ ] Event indexing
- [ ] Mission result storage
- [ ] Basic fraud rules
- [ ] Basic reputation fields
- [ ] API / blockchain failure observability
- [ ] Privacy / data retention policy
- [ ] Admin / dispute tooling

## P1 Deliverables

- [ ] Multiple campaign templates
- [ ] User preference filters
- [ ] Basic publisher attribution
- [ ] Exportable advertiser results

## 核心 Metrics

- cost per verified valid completion
- advertiser repeat rate
- accepted completion rate
- fraud-adjusted completion rate
- campaign fill time
- user earnings per active hour

## Exit Criteria

至少有一個真實 buyer 願意重複 funding campaign，而且平台已能衡量 fraud-adjusted unit economics。

---

# Milestone 3 — Closed Beta：Repeatability 與 Quality

## 目標

讓 marketplace 不需要每一個 campaign 都由人工介入才能完成。

## Deliverables

### Mission System

- [ ] Multiple mission types
- [ ] Mission templates
- [ ] Configurable eligibility / completion rules
- [ ] Better comprehension / quality checks

### Reputation

- [ ] Pseudonymous reputation model
- [ ] Accepted-completion history
- [ ] Domain / task-specific quality signals
- [ ] Dispute impact on reputation
- [ ] Abuse-resistant score update rules

### Fraud

- [ ] Behavioral anomaly rules
- [ ] Telemetry forgery detection
- [ ] Human farming heuristics
- [ ] Rate limits
- [ ] Risk review tooling

### Publisher

- [ ] First embeddable widget / SDK
- [ ] Publisher attribution
- [ ] Revenue-share accounting

### API

- [ ] Stable campaign API
- [ ] Stable completion / result API
- [ ] Authentication / rate limits
- [ ] Versioning policy

## Exit Criteria

- campaign 能在有限人工介入下建立、完成、settle、report；
- fraud 可以被量化，不再只是未知風險；
- 至少一個 external publisher / integration end-to-end 運作。

---

# Milestone 4 — Agent-Native Demand / x402

## 目標

讓 software 與 AI Agent 可以程式化購買 verified human work。

## Dependencies

- stable campaign API
- stable settlement
- reliable fraud controls
- machine-readable task / result schema

## Deliverables

- [ ] 重新驗證當下 x402 specification / ecosystem 的整合可行性
- [ ] Machine-readable campaign creation endpoint
- [ ] Programmatic payment flow
- [ ] Agent-friendly task schema
- [ ] Structured result retrieval
- [ ] Idempotency / payment reconciliation
- [ ] Per-agent limit / abuse controls
- [ ] API documentation / examples

## 目標流程

```
AI Agent
  → 需要 100 份 verified human judgments
  → programmatic payment
  → campaign 建立
  → human 完成任務
  → Agent 取得 structured results
```

## Exit Criteria

外部 software client 不需要人工逐筆 funding，就能購買並取得 verified-human work。

---

# Milestone 5 — Production Readiness

## 目標

可以在真實資金與可預期 incident handling 下運作。

## Smart Contract Security

- [ ] Unit tests
- [ ] Fuzz tests
- [ ] Invariant tests
- [ ] Access-control review
- [ ] Replay protection review
- [ ] Budget accounting review
- [ ] Pause / emergency mechanism
- [ ] 依 TVL / fund exposure 完成適當的 independent security review / audit

## Infrastructure

- [ ] Production secrets / key management
- [ ] Monitoring / alerting
- [ ] RPC/provider failure handling
- [ ] Database backup / restore
- [ ] Queue / retry strategy
- [ ] Financial reconciliation
- [ ] Structured logging
- [ ] On-call / incident process

## Risk Controls

- [ ] Campaign funding limits
- [ ] Daily payout limits
- [ ] Suspicious-payout alerts
- [ ] Signer anomaly alerts
- [ ] Emergency pause runbook
- [ ] Incident postmortem template

## Privacy / Abuse

- [ ] Data-retention enforcement
- [ ] User deletion/privacy workflow（適用時）
- [ ] Malicious campaign / content moderation
- [ ] Phishing / scam controls
- [ ] Publisher abuse controls

## Exit Criteria

平台能承受常見 infrastructure failure，並在解除資金上限前，已建立完整 financial/security incident response。

---

# Milestone 6 — Publisher Network

## 目標

讓 distribution 不再依賴 first-party website。

## Deliverables

- [ ] Public publisher SDK
- [ ] Embeddable mission component
- [ ] Revenue-share rules
- [ ] Attribution system
- [ ] Publisher analytics
- [ ] Integration docs
- [ ] Versioned SDK release
- [ ] Sandbox environment

## Exit Criteria

多個獨立 third-party property 能無需客製化一次性整合，就導入 mission 並取得可稽核 revenue share。

---

# Milestone 7 — Protocol / Ecosystem

## 目標

從 application 演進成 infrastructure。

## Deliverables

- [ ] Stable public API
- [ ] Stable SDK
- [ ] Permissionless / semi-permissionless campaign integration model
- [ ] Third-party mission providers
- [ ] Agent-native demand
- [ ] Publisher network
- [ ] Reputation portability policy
- [ ] Protocol change 的 governance / security policy

## Exit Criteria

有實質比例的 demand 與 supply 來自 first-party UI 之外。

---

# Milestone 8 — Multi-Chain / AARC Decision Gate

## 目標

只有在市場證明 chain fragmentation 是真問題時，才加入 chain abstraction。

## Trigger Conditions

至少出現一項才考慮：

- 重要 advertiser 的資金主要在 unsupported chain；
- user 明顯偏好其他 chain settlement；
- publisher / agent partner 明確要求其他 network；
- bridge friction 可量化地傷害 conversion；
- 原 chain 的 liquidity / fee 成為實際限制。

## Implementation 前驗證

- [ ] 確認當下 AARC SDK / API capability
- [ ] 確認 supported networks
- [ ] Review security / trust assumption
- [ ] 建模 bridge / swap failure state
- [ ] 建模額外 fee
- [ ] 定義 fallback / recovery
- [ ] 決定 canonical campaign accounting 放在哪一層

## Decision Gate 通過後才做

- [ ] Chain abstraction layer
- [ ] Cross-chain funding UX
- [ ] 有必要時的 cross-chain reward UX
- [ ] Liquidity / reconciliation monitoring
- [ ] Cross-chain incident runbook

## Exit Criteria

使用者不需要理解 underlying chain，也能操作產品，同時 accounting 仍 deterministic，且 failure recovery 有文件化流程。

---

# Cross-Cutting Workstreams

這些工作會跨越多個 milestone。

## Security

- threat model
- contract invariants
- key management
- dependency review
- incident response

## Privacy

- data minimization
- pseudonymous reputation
- campaign-scoped identifiers
- retention limits
- deanonymization analysis

## Fraud Intelligence

- Sybil signals
- behavioral signals
- publisher fraud
- campaign abuse
- anomaly dataset

## Developer Experience

- API docs
- SDK
- examples
- sandbox
- versioning
- backward compatibility

## Market Design

- reward pricing
- platform take rate
- publisher share
- reputation effects
- dispute incentives

---

# 優先級定義

| Priority | 定義 |
| --- | --- |
| P0 | 當前 milestone 必需，會阻塞核心驗證 |
| P1 | 提高品質與 repeatability |
| P2 | 核心 demand 證明後的 growth feature |
| P3 | 有實際證據需要才做 |

目前應集中在：

> **Milestone 0 → Milestone 1 的 P0**

---

# 現在不該做的東西

在 core loop 還沒證明真實需求前，不優先做：

- native token
- DAO
- speculative tokenomics
- multi-chain settlement
- AARC critical path
- complex ML fraud scoring
- fully decentralized engagement verification
- large publisher marketplace
- advanced auction / dynamic pricing system

這些未來可能有價值，但現在只會增加 execution risk，而不會更快驗證核心 hypothesis。

---

# 成功定義

第一個真正重要的 proof point 不是 TVL、token price 或 raw clicks，而是：

> **真實 buyer 願意重複為 fraud-adjusted、verified-human completion 付費，因為這些結果比傳統未驗證流量更有價值。**

Roadmap 中的所有功能，都應該直接支持或驗證這個命題。
