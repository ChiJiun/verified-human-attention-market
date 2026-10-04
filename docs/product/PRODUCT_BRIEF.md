# Product Brief / 產品簡報

## Product

**Verified Human Attention Market**

A Web3 marketplace/protocol where advertisers, creators, software, or AI agents can purchase **verified human attention**, while real users receive **USDC** for completing meaningful missions.

核心定位不是「看廣告賺幣」，而是：

> **A market for verifiable human attention and human-in-the-loop work.**

## Problem

現有廣告與 Web3 campaign 有三個核心問題：

1. **Identity quality**：wallet 或 click 不等於 unique human。
2. **Engagement quality**：即使是真人，也可能只是 farming reward。
3. **Settlement / programmability**：人類與 AI Agent 缺少統一、可程式化地購買真人任務的市場。

因此產品必須分開解決：

- Proof of Human；
- Proof / Evidence of Engagement；
- Settlement；
- Reputation；
- Distribution。

## First Target Customer

### Working assumption: Advertiser / Creator

第一版先服務想推廣內容、產品或 Web3 project 的 advertiser / creator。

理由：

- 與原始產品構想最一致；
- 任務容易定義；
- 可以很快測試「verified engagement 是否比 raw click 更值得付費」；
- 後續可自然延伸到 product research 與 AI human evaluation。

## First Mission

### Sponsored Content + Comprehension Check

使用者流程：

1. 使用者看到一個 sponsored mission。
2. 使用 World ID 完成 unique-human eligibility。
3. 閱讀指定內容。
4. 回答 1–3 個短 comprehension questions。
5. Backend 驗證 completion。
6. 使用者取得 claim authorization。
7. Smart contract 發放 USDC。

第一版不宣稱 comprehension quiz 能完整證明「真正注意力」，它只是比單純 click 更強的 baseline。

## Buyer Flow

```
Advertiser
  → connect wallet
  → create campaign
  → define content + completion rules
  → deposit USDC
  → campaign becomes active
  → receive aggregate results
  → unused budget refunded after close/expiry
```

## User Flow

```
User
  → browse mission
  → World ID verification
  → complete content task
  → submit comprehension response
  → receive claim authorization
  → claim USDC
```

## Value Proposition

### Advertiser

- 不是單純購買 click，而是購買有 human uniqueness signal 的 engagement；
- campaign budget 由 escrow 控制；
- settlement 可稽核；
- 可以逐步加入 quality / reputation targeting。

### User

- 注意力與回饋有直接經濟價值；
- reward 規則透明；
- 不需要公開 real-world identity 給 advertiser。

### Publisher

未來可以嵌入 mission 並取得 revenue share。

### AI Agent

未來可以透過 API + x402 自動建立 human task campaign。

## Core Hypothesis

> 真實 buyer 願意重複為 **fraud-adjusted verified human completion** 付費，而且這個 completion 對 buyer 的價值高於未驗證 raw traffic。

## MVP Scope

### In scope

- one EVM chain；
- native USDC；
- advertiser wallet funding；
- World ID external verification；
- one mission type；
- campaign escrow；
- claim authorization；
- reward claim；
- duplicate claim prevention；
- campaign expiry/refund；
- basic analytics；
- basic audit events。

### Out of scope

- native token；
- DAO；
- multi-chain；
- AARC；
- x402 critical path；
- dynamic auction；
- ML fraud scoring；
- fully decentralized engagement verification；
- large publisher marketplace。

## Success Metrics

第一階段不以 page view、raw click、TVL 或 token price 當核心 KPI。

優先：

- cost per verified valid completion；
- accepted completion rate；
- duplicate/fraud rejection rate；
- campaign fill time；
- advertiser repeat rate；
- user earnings per active hour；
- refund/accounting correctness。

## Main Product Risks

### 1. Reward farming

Proof of Human 只能降低 Sybil，不代表 engagement 有品質。

### 2. Economics

若 reward 太低，真人沒有動機；太高則 advertiser CAC 不合理。

### 3. Gas UX

小額 reward 若需要 user 自己支付 gas，可能破壞產品體驗。

### 4. Privacy

跨 campaign 累積 reputation 時必須避免建立可輕易 deanonymize 的 public behavior graph。

### 5. Adverse selection

若只有低品質 user 願意做 mission，平台可能無法提供 buyer 想要的品質。

## Long-Term Expansion

```
Ads / Sponsored Content
        ↓
Product Research
        ↓
Human Evaluation for AI
        ↓
Verified Human Attention API
        ↓
Publisher + Agent Ecosystem
```
