# Verified Human Attention Market

[English](README.md) | [繁體中文](README.zh-TW.md)

[![CI](https://github.com/ChiJiun/verified-human-attention-market/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ChiJiun/verified-human-attention-market/actions/workflows/ci.yml)

這是一個概念驗證：廣告主付費購買**經過驗證的獨立真人**的注意力，這些人以 **USDC** 領取報酬。預算鎖在鏈上託管合約，World ID 證明參與者是獨一無二的真人，鏈下驗證器判斷任務是否真的完成，合約才會發放獎勵。

> **這不是「看廣告賺幣」網站。** 目標是建立一個可驗證真人注意力的市場（之後提供 API），讓一個機器人或一個擁有很多錢包的人，無法重複領走同一個 campaign 的預算。

目前的參與度檢查是一份簡短的理解測驗：它是基本的訊號，不能證明對方認真讀過（[ADR-0002](docs/adr/0002-first-use-case-sponsored-content.md)）。通過驗證的真人仍然可能只為了領獎勵而作答；World ID 限制的是每個人在每個 campaign 只能領一次。

> ⚠️ **僅限測試網。** 合約尚未經過外部審計，也還沒通過 production 準備關卡（[#29](https://github.com/ChiJiun/verified-human-attention-market/issues/29)）。請勿使用真實資金。

**要評估這個專案？** [目前哪些是真的](#目前哪些是真的)說明哪些已經證實、哪些還沒有；[在本機執行](#在本機執行)用兩個指令就能檢查。可以直接貼到報名表的簡短說明在 [docs/HACKATHON.zh-TW.md](docs/HACKATHON.zh-TW.md)。

### 它真的能跑

- **在公開測試網上。** 完整流程已於 2026-10-14 在 Base Sepolia 執行（v1 合約），使用 Orb 驗證過的 World App 產生的真實 World ID proof：[入金 3 USDC](https://sepolia.basescan.org/tx/0xda1673ced0c7b3c6bf6345d34339e49d86b33060f903168df53571508a3bea65) · [領取 1 USDC](https://sepolia.basescan.org/tx/0xc929552ca98dc923a18baf04b4d2c47b0b05b1c91093444eafa77a854bf876d7) · [退款 2 USDC](https://sepolia.basescan.org/tx/0x242c6aac019183f29a18c12e39ba2380a94ad2e9f4bf573662831da41c5e44a4) · [合約](https://sepolia.basescan.org/address/0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc) · [全部六筆交易](docs/DEMO.zh-TW.md#base-sepolia-實測2026-10-14)
- **在 CI 裡，每次 push 與 pull request 都跑。** Foundry 測試（`forge` 回報 60 個，其中三個 stateful invariant 每次執行檢查 8,192 次呼叫）、超過 860 個 TypeScript 測試，以及在本機鏈加 PostgreSQL 上把整個金流從頭到尾跑一次。
- **這些沒有涵蓋的部分。** 測試網那次用的是較早的 World ID 請求（也接受 3.0 proof），而且合約之後改過。現行只接受 4.0、綁定錢包的請求，以及現行合約，只在本機鏈與 CI 跑過，World ID 是模擬的。測試網的重跑還沒做。

---

## 畫面

以下截圖來自本機執行：本機鏈（anvil）、模擬的 World ID、mock USDC。

| 廣告主：campaign 已入金並啟用 | 參與者：閱讀並作答 |
| --- | --- |
| ![廣告主頁面：啟用中的 campaign，已入金 10 USDC，已為 2 次完成付出 2 USDC，其中一次被標記 FAST_COMPLETION，並顯示參與者連結](docs/images/advertiser-active.png) | ![任務頁面：參與者的錢包、贊助內容連結、一題理解測驗與 Submit answers 按鈕](docs/images/mission-answer.png) |
| **參與者：獎勵已在鏈上發放** | **廣告主：已關閉、退款並結清** |
| ![任務頁面：顯示 Reward paid to your wallet 與領取交易的 hash](docs/images/mission-paid.png) | ![廣告主頁面：campaign 已結清，已付 2 USDC，剩餘 0 USDC，退款交易完成](docs/images/advertiser-settled.png) |

---

## 為什麼做這個

**問題。** 行銷活動付錢買的點擊與錢包活動，機器人或一個擁有很多錢包的人都做得出來。一個錢包不等於一個真人，一個真人也不一定真的參與了。

**給誰用。** 第一個對象是想讓少數真人讀某份內容的廣告主或創作者。Publisher 與透過 API 購買的 AI agent 是之後的事，目前沒有做。

**為什麼用 World ID。** 它提供每個 campaign 專屬的匿名識別值，所以同一個人在同一個 campaign 只會領到一次，而專案不會知道對方是誰。

**為什麼上鏈。** 廣告主不必把預算交給平台。預算放在合約裡，合約付出的金額不會超過入金，只憑簽好的授權付款，剩下的會退回。仍然需要信任的是鏈下驗證器與它的簽名金鑰；合約限制了最大損失（概念驗證階段是每個 campaign 10 測試 USDC）。

| | 看廣告賺幣、任務牆與問卷平台（常見做法） | 這個專案 |
| --- | --- | --- |
| 誰可以領錢 | 通常是任何帳號或錢包，所以一個人可以開很多個 | 每個 campaign 中，每位通過 World ID 驗證的真人一次；換一個錢包也領不到第二次 |
| 付錢買什麼 | 通常是曝光、點擊或鏈上操作 | 驗證器接受的一次完成（目前是理解測驗：基本訊號，不能證明認真讀過） |
| 用什麼付 | 通常是平台自己的代幣或點數 | USDC；刻意不發行原生代幣 |
| 預算放在哪 | 通常在平台手上 | 每個 campaign 各自的鏈上託管；沒用完的由廣告主領回 |
| 儲存了參與者的哪些資料 | 通常是帳號資料 | 每個 campaign 一個以金鑰雜湊過的 World ID nullifier，以及領取用的錢包；沒有姓名，也沒有原始的 World ID 資料 |

中間一欄描述的是產品類別，不是指特定產品。

---

## 目前哪些是真的

| | 狀態 |
| --- | --- |
| 託管合約（`CampaignManager`，Solidity） | 已完成並有測試。v1 合約已於 2026-10-14 在 Base Sepolia 跑完整個流程（連結見上方） |
| World ID | 那次執行是真的：Orb 驗證過的 World App 產生的 production proof，由後端驗證。本機 demo 與 CI 中是模擬的 |
| USDC | Base Sepolia 上是 Circle 的測試 USDC；本機鏈上是 mock token |
| 前端、API、indexer | 已完成：廣告主可以建立、入金、關閉 campaign 並退款；參與者可以驗證、作答並領取 |
| 還沒做的 | 測試網執行之後合約改過（campaign 的建立改成冪等，[ADR-0011](docs/adr/0011-idempotent-campaign-creation.md)），所以現行程式只在本機鏈與 CI 測試過，還沒重新部署到 Base Sepolia。沒有審計、沒有主網、沒有真實資金、沒有真實廣告主 |

工程進度與已合併的變更清單：[docs/SDLC_STATUS.md](docs/SDLC_STATUS.md)。

---

## 運作方式

```mermaid
sequenceDiagram
    autonumber
    actor A as 廣告主
    actor U as 參與者
    participant W as 網頁
    participant API as API + indexer
    participant ID as World ID
    participant C as CampaignManager（Base）

    A->>W: 建立 campaign（內容、獎勵、題目）
    W->>API: 儲存草稿
    A->>C: createCampaign + 入金（USDC 託管）
    C-->>API: 事件經 indexer 確認後，campaign 變 active

    U->>W: 打開任務連結、連接錢包
    W->>API: 取得簽好的 World ID 請求
    U->>ID: 證明自己是獨一無二的真人（World App）
    ID-->>API: proof，由後端驗證
    U->>API: 送出作答
    API-->>U: EIP-712 領取授權（鏈下簽名）
    U->>C: claim(授權)
    C-->>U: 1 USDC

    A->>C: closeCampaign，等待期過後退款
```

**誰負責判斷什麼**

| 問題 | 由誰判斷 | 為什麼放在這裡 |
| --- | --- | --- |
| 這是獨一無二的真人嗎？ | World ID（零知識證明） | 我們永遠不知道對方是誰，只拿到一個每個 campaign 專屬的識別值，用來擋第二次領取 |
| 對方真的有參與嗎？ | API（鏈下驗證器） | 規則常改，而且答案必須保密 |
| 這筆發放有效嗎？ | 合約 | 在鏈上檢查簽名、預算、名額上限、期限與重放 |
| 實際付了多少錢？ | **鏈** | 資料庫從已確認的鏈上事件對帳，永遠不反過來 |

**合約內建的安全規則**

- **預算守恆：** 發放加退款永遠不會超過入金金額。
- **防重放：** 每份授權有一次性的 nonce，每個錢包在同一個 campaign 只能領一次。
- **延後退款：** 要等到最後一份可能被簽發的授權都過期，廣告主才能退款。所以已簽發的授權不會和退款互相搶錢，但參與者仍須在授權到期前（最長 15 分鐘）自己完成領取。
- **曝險上限：** 每個 campaign 的獎勵、名額與預算在鏈上有上限（POC：1 USDC × 10）。

---

## 工程重點

- **退款不會和領取搶錢。** 領取授權是在鏈下簽的，所以可能存在一份鏈上還沒看過的授權。如果廣告主一關閉就能退款，手上握有有效簽名的參與者可能發現託管已經空了。合約要求廣告主等到所有可能簽發過的授權都過期（[`refundUnusedBudget`](packages/contracts/src/CampaignManager.sol#L319)，`MAX_AUTHORIZATION_TTL` = 15 分鐘）。
- **重試不會建立第二筆託管。** RPC 回應遺失、重送，或另一個瀏覽器分頁，都不會讓同一個草稿建立第二個 campaign：`createCampaign` 對每個草稿是冪等的，領取簽名也綁定同一個草稿（[ADR-0011](docs/adr/0011-idempotent-campaign-creation.md)）。
- **以鏈為帳本。** 資料庫由會處理鏈重組的 indexer 從已確認的事件對帳。重組深度超過確認深度時會停止簽發，而不是猜測。
- **proof 綁定錢包。** World ID 的 signal 包含 campaign 與領取者位址，所以為某個錢包產生的 proof 換到另一個錢包會被拒絕（[ADR-0007](docs/adr/0007-world-id-integration.md)）。這點在本機與 CI 測試過，還沒用真實的 World App 驗證。
- **合約小，而且沒有相依套件。** 443 行、沒有任何 import，每個 revert 都有測試涵蓋。三個 stateful invariant（預算守恆、發放不超過入金、名額上限）在每次 CI 執行的 8,192 次隨機呼叫中都成立。

---

## 架構

```mermaid
flowchart LR
    subgraph 瀏覽器
        WEB["apps/web<br/>Next.js<br/>廣告主頁 + 任務頁"]
        WALLET[錢包]
        WAPP[World App]
    end

    subgraph 伺服器
        API["apps/api<br/>Fastify REST API"]
        IDX[Indexer worker]
        DB[(PostgreSQL)]
    end

    subgraph Base
        CM[CampaignManager]
        USDC[USDC]
    end

    WEB --> API
    WALLET -->|建立、入金、領取| CM
    WAPP -->|proof| WEB
    API -->|驗證 proof| WID[World ID API]
    API --> DB
    IDX -->|讀取事件| CM
    IDX --> DB
    CM --> USDC
```

| 套件 | 內容 |
| --- | --- |
| [`apps/web`](apps/web) | Next.js 前端：廣告主後台（`/advertiser`）與參與者任務頁（`/mission?campaign=…`，含 World ID widget） |
| [`apps/api`](apps/api) | 基於 PostgreSQL（Drizzle）的 Fastify API：campaign、SIWE 登入、World ID 驗證、作答、領取授權簽發、審核、分析。也負責鏈上事件 indexer 與對帳 worker |
| [`packages/contracts`](packages/contracts) | Solidity + Foundry：`CampaignManager` 託管合約，含單元、fuzz 與不變量測試，以及部署腳本與部署紀錄 |
| [`packages/shared`](packages/shared) | API 與前端共用的合約 ABI 與鏈設定 |

確切版本以各套件的 `package.json` 與 lockfile 為準。

---

## 在本機執行

需要：Node.js 24.15 以上、pnpm 12.4.2、Foundry v1.8.4（Windows 請裝在 WSL）。第 2、3 步還需要一個連得到的 PostgreSQL 16 以上（以連線 URL 指定）。用 Docker 最快，直接安裝也可以。5432 埠被佔用時，請改用其他埠並同步修改 URL。

**1. 兩個指令檢查**（不需要資料庫，也不需要鏈）

```bash
pnpm install && pnpm test                  # API、前端與共用套件
cd packages/contracts && forge test -vv    # 合約；沒有相依套件，不需要 `forge install`
```

沒有資料庫時，`pnpm test` 會跑約 780 個測試，並跳過 PostgreSQL 整合測試。CI 會連同那些一起跑，所以上面寫的是 860 個以上。

**2. 在本機鏈上跑完整金流**（幾分鐘）

anvil 上的真合約、真的 PostgreSQL、真的 API，只有 World ID 是模擬的。一個測試會建立 campaign 並入金、驗證一位參與者、發放一筆領取、確認第二次領取被拒絕、關閉、退款，最後拿 API 的數字和鏈上比對。

```bash
# 終端機 1
docker run --rm --name vham-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vham_e2e postgres:16-alpine
# 終端機 2
anvil
# 終端機 3
(cd packages/contracts && forge build)
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
pnpm --filter @vham/api test:e2e
```

預期結果：`Test Files  1 passed (1)`。如果測試顯示為 skipped，表示沒有設定 `TEST_DATABASE_URL`。請指到專門給它用的資料庫，因為每次執行都會清空所有資料表。CI 的 `e2e` job 跑的就是同一個測試。在 Windows 上，`anvil` 與 `forge build` 在 WSL 執行，`pnpm` 指令在 PowerShell 執行，並用 `$env:TEST_DATABASE_URL = "…"` 取代 `export`。

**3. 在瀏覽器裡實際操作**

廣告主為 campaign 入金、參與者領取：請照 [docs/DEMO.zh-TW.md](docs/DEMO.zh-TW.md)。需要六個終端機和一個瀏覽器錢包，World ID 是模擬的。

API 和 indexer 只從環境變數讀設定，不會自己讀 `.env` 檔。執行時用到的所有變數都列在 [`.env.example`](.env.example)。不要 commit 任何金鑰或填好的 `.env`。

CI 在每次 push 與 pull request 執行四個 job：`javascript`（含 PostgreSQL）、`audit`、`e2e`、`solidity`。貢獻者與 AI coding agent 請看 [CONTRIBUTING.md](CONTRIBUTING.md) 與 [AGENTS.md](AGENTS.md)。

---

## 文件導覽

| 文件 | 想知道什麼時讀它 |
| --- | --- |
| [docs/HACKATHON.zh-TW.md](docs/HACKATHON.zh-TW.md) | 可以貼到報名表的專案簡短說明 |
| [docs/DEMO.zh-TW.md](docs/DEMO.zh-TW.md) | 如何跑完整流程，以及 Base Sepolia 實測紀錄 |
| [docs/SDLC_STATUS.md](docs/SDLC_STATUS.md) | 專案現在進行到哪裡，以及哪些變更在什麼時候合併 |
| [docs/product/PRODUCT_BRIEF.md](docs/product/PRODUCT_BRIEF.md) | 產品為誰而做、為什麼要做（中文夾英文術語） |
| [docs/product/VISION.zh-TW.md](docs/product/VISION.zh-TW.md) | 長期願景、商業模式選項與完整路線圖 |
| [docs/architecture/MVP_ARCHITECTURE.md](docs/architecture/MVP_ARCHITECTURE.md) | 各元件怎麼組在一起 |
| [docs/architecture/CONTRACT_SPEC.md](docs/architecture/CONTRACT_SPEC.md) | 合約確切做什麼、保證什麼 |
| [docs/architecture/CLAIM_AUTHORIZATION.md](docs/architecture/CLAIM_AUTHORIZATION.md) | 簽名領取授權的運作方式 |
| [docs/threat-model/THREAT_MODEL.md](docs/threat-model/THREAT_MODEL.md) | 可能出什麼問題、如何防範 |
| [docs/adr/](docs/adr/README.md) | 每個重大決策的理由 |
| [CONTRIBUTING.md](CONTRIBUTING.md)、[AGENTS.md](AGENTS.md) | commit 前要跑的檢查，以及在這個 repo 工作的規則 |

其他：[需求](docs/product/REQUIREMENTS.md)、[API 規格](docs/architecture/API_SPEC.md)、[資料模型](docs/architecture/DATA_MODEL.md)、[測試計畫](docs/testing/TEST_PLAN.md)、[資料保存](docs/privacy/DATA_RETENTION.md)、[維運](docs/operations/)與[測試網部署](docs/deployment/TESTNET.md)。

---

## 路線圖

| 里程碑 | 目標 | 狀態 |
| --- | --- | --- |
| M0 | 產品決策：第一個買家、鏈、gas、領取模型、經濟參數 | ✅ 完成 |
| **M1** | **POC：在測試網跑通完整的金流** | 🟡 已在 Base Sepolia 以 v1 合約執行；改版後合約的重跑還沒做 |
| M2 | 給真實買家的 MVP：監控、隱私、審核、簽名金鑰保管 | 🟡 工程基礎已完成；尚無真實買家 |
| M3 | 封閉測試：品質訊號、公開 API、publisher SDK | 🟡 品質訊號與公開 API 的契約已完成；publisher SDK 未開始 |
| M4 | AI agent 透過 x402 購買 campaign | ⬜ 未開始 |
| M5 | 可放真錢的 production 準備：審計、值班 | 🟡 部分完成：還沒有審計，也沒有值班 |
| M6–M7 | Publisher 網路、協議生態 | ⬜ 未開始 |
| M8 | 多鏈，只在有需求證據時才做 | ⬜ 延後 |

商業模式：尚未實作，概念驗證階段不收手續費（[ADR-0005](docs/adr/0005-poc-campaign-economics.md)）。考慮中的選項，前兩項是依結算金額收一定比例，或依每次通過驗證的完成收費：[VISION 第 13 節](docs/product/VISION.zh-TW.md#13-商業模式)。

含交付項目與完成標準的完整路線圖：[docs/product/VISION.zh-TW.md](docs/product/VISION.zh-TW.md#開發路線圖)。

---

## 名詞解釋

| 名詞 | 意思 |
| --- | --- |
| **World ID** | 證明「這是獨一無二的真人」的零知識證明，不會透露對方是誰 |
| **Nullifier** | World ID 在每個 app 與 action 下回傳的匿名值；同一個人永遠得到同一個值，所以能擋第二次領取 |
| **RP / RP 簽章** | Relying Party，也就是我們的 app。後端會為每個 World ID 請求簽名，防止別人冒充 |
| **IDKit** | World 的 SDK；widget 會顯示讓 World App 掃描的 QR code |
| **EIP-712** | 對結構化資料簽名的標準；後端簽出合約能驗證的領取授權 |
| **SIWE** | Sign-In with Ethereum：用錢包簽一則訊息來登入 |
| **Indexer** | 把已確認的合約事件讀進資料庫的 worker，會處理鏈重組（reorg） |
| **ADR** | 架構決策紀錄（Architecture Decision Record）：一份短文件，說明一個決定、考慮過的其他方案與後果 |
| **最小單位** | USDC 有 6 位小數，所以 `1000000` 代表 1 USDC。金額永遠不用浮點數儲存 |
| **Base Sepolia** | Base 的公開測試網（chain ID `84532`） |
| **anvil** | Foundry 的本機區塊鏈，用於開發與 CI |
