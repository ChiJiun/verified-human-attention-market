# Demo：本機端到端 POC

這份文件說明如何在本機跑完整的經濟流程 demo（issue #13），以及各個元件的單獨指令。

Demo 會用**真的**本機鏈（anvil）、**真的**編譯後 `CampaignManager` 合約、真的 PostgreSQL 和真的 API，跑完下面這條流程：

```text
廣告主 SIWE 登入 → 建立草稿 campaign（含理解測驗）
→ 鏈上 createCampaign → API 驗證交易後連結
→ approve + fundCampaign → indexer 確認後 campaign 變 active
→ 使用者 World ID 資格驗證（模擬）→ 作答通過
→ 後端簽 EIP-712 授權 → 使用者鏈上 claim 領到 1 USDC
→ 重複 claim 被合約拒絕 → 對帳數字與鏈上一致
→ 廣告主 close（之後不再產生新負債）→ 等待期過後 refund 9 USDC
→ analytics 顯示 settled，金額完全對得上
```

唯一模擬的是 **World ID**：真的 World ID 需要 World App 和 Developer Portal 的 app。測試用的 USDC 是 mock token。

---

## 需要的工具

| 工具 | 版本 | 備註 |
| --- | --- | --- |
| Node.js | 24+ | |
| pnpm | 12.4.2 | `corepack enable` 後會依 `packageManager` 自動使用 |
| Foundry（forge、anvil） | v1.8.4 | Windows 請裝在 WSL 裡 |
| PostgreSQL | 16 | 用 Docker 最簡單 |

---

## 一鍵 demo（建議）

### macOS / Linux / WSL

開三個終端機。

**終端機 1：PostgreSQL**

```bash
docker run --rm --name vham-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vham_e2e \
  postgres:16-alpine
```

**終端機 2：本機鏈**

```bash
anvil
```

**終端機 3：編譯合約並跑 demo**

```bash
pnpm install
(cd packages/contracts && forge build)

export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
export E2E_RPC_URL=http://127.0.0.1:8545
pnpm --filter @vham/api test:e2e
```

### Windows（PowerShell + WSL 裡的 Foundry）

- **PostgreSQL：** 用 Docker Desktop 跑上面同一行 `docker run`。
- **anvil：** 在 WSL 終端機執行 `anvil`。WSL2 會把 `127.0.0.1:8545` 轉發給 Windows。
- **合約：** 在 WSL 裡執行 `cd packages/contracts && forge build`。產生的 `out/` 資料夾就在 repo 裡，Windows 端看得到。

最後在 PowerShell 執行：

```powershell
pnpm install
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/vham_e2e"
$env:E2E_RPC_URL = "http://127.0.0.1:8545"
pnpm --filter @vham/api test:e2e
```

### 預期結果

```text
✓ e2e/poc.e2e.ts > POC economic loop on a local chain > runs create → fund → verify → claim → close → refund with matching accounting
Test Files  1 passed (1)
```

注意事項：

- 每次執行都會清空 `vham_e2e` 資料庫的資料表，所以請用專用的資料庫，**不要**指到開發用的資料庫。
- anvil 的時間會被 demo 往前調。要重跑的話，建議先重啟 anvil。
- 沒有設定 `TEST_DATABASE_URL` 時，demo 會直接 skip，不會失敗。

CI 的 `e2e` job 每次 push 都會跑同一個 demo，設定見 `.github/workflows/ci.yml`。

---

## 其他指令

### 全部檢查（commit 前，對應 AGENTS.md §9 / §10）

```bash
pnpm install
pnpm typecheck
pnpm test          # 單元 + 整合測試；有 TEST_DATABASE_URL 時也會跑 PostgreSQL 測試
pnpm lint
pnpm build
pnpm format:check

cd packages/contracts
forge fmt --check
forge build --sizes
forge test -vv
```

### 只跑 PostgreSQL 整合測試

```bash
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
pnpm --filter @vham/api exec vitest run postgres
```

### 啟動 API 與 indexer（連到已部署的合約）

```bash
cp .env.example .env    # 依註解填入；不要 commit .env
pnpm --filter @vham/api db:migrate
pnpm --filter @vham/api dev        # API，預設 http://localhost:3001
pnpm --filter @vham/api indexer    # 鏈上事件索引 + campaign 狀態同步
```

各組環境變數的作用：

- **鏈上設定**（`EVM_RPC_URL`、`USDC_ADDRESS`、`CAMPAIGN_MANAGER_ADDRESS`、`CAMPAIGN_MANAGER_DEPLOY_BLOCK`）：只要填了，就必須填完整，而且 API 啟動時會驗證鏈 ID 和合約程式碼。
- **`SIWE_DOMAIN`**：沒設定時無法登入，廣告主相關端點一律回 401。
- **`WORLD_ID_RP_ID` + `PARTICIPANT_KEY_SECRET`**：沒設定時，資格驗證一律回 503。
- **`CLAIM_SIGNER_PRIVATE_KEY`**（或正式環境的 `CLAIM_SIGNER_URL` + `CLAIM_SIGNER_ADDRESS`，ADR-0008）：沒設定時不會簽授權。簽署位址必須等於合約的 `authorizedSigner`，也不能是部署者的私鑰；明文私鑰只允許在 anvil 與 Base Sepolia 使用。
- **審核（#24）**：預設 `MODERATION_MODE=review`，新 campaign 要由 `OPERATOR_ADDRESSES` 裡的錢包核准（或廣告主在 `ADVERTISER_ALLOWLIST`）才能發佈、作答。`MODERATION_MODE=open` 只能在本機 anvil 使用。詳見 [docs/operations/MODERATION.md](operations/MODERATION.md)。

### 廣告主前端（#11）

```bash
# API 端（.env）：SIWE_DOMAIN 必須等於前端網址的 host
SIWE_DOMAIN=localhost:3000

# 前端
export API_URL=http://localhost:3001        # Next 把 /api/* 轉發到這裡
export NEXT_PUBLIC_CHAIN_ID=84532           # 本機 anvil 用 31337
pnpm --filter @vham/web dev                 # http://localhost:3000/advertiser
```

頁面流程：

1. 連接瀏覽器錢包；網路不對時會顯示切換按鈕。
2. 用 Sign-In with Ethereum 登入。
3. 填寫 campaign（獎勵用十進位 USDC 輸入，內部以整數 atomic units 換算），並設計 1–3 題理解測驗。
4. 按「Create on-chain」送出 createCampaign，API 驗證交易後完成連結。
5. 按「Approve & fund」核准並入金。
6. indexer 確認後，狀態變成 active，頁面會顯示預算與成效。

交易遲遲沒有收據時，頁面顯示「還在確認中，不要重送」，並持續以 `draftRef` 向 API 對帳。重新整理後頁面不保留交易 hash，只記得「這個草稿可能已送出建立交易」，因此優先提供「Check again」；超過 10 分鐘才會再提供「Create on-chain anyway」（若原交易其實已上鏈，第二筆只會 `DraftAlreadyCreated` revert 並耗 gas，不會建立第二個 campaign）。

### 完整網頁 demo：本機鏈 + 前端（#11 / #12）

用瀏覽器錢包實際操作「廣告主建立、入金 → 使用者作答、領取」。World ID 在這個模式下是模擬的：`WORLD_ID_MODE=simulated` 只能在本機 anvil（chain 31337）啟用，換成其他鏈 API 會拒絕啟動。

下面用到的都是 anvil 啟動時印出的**公開測試帳號**，只能用在本機，絕不要拿到任何真實網路上。

| 角色 | 帳號 | 地址 |
| --- | --- | --- |
| 部署者 | anvil #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| claim 簽名者 | anvil #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| 廣告主（匯入瀏覽器錢包） | anvil #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| 使用者（匯入另一個錢包或帳號） | anvil #3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |

```bash
# 終端機 1：資料庫（同上的 docker run，資料庫名改用 vham）
# 終端機 2：本機鏈。每 2 秒產生一個區塊，indexer 才有確認數可以等
anvil --block-time 2

# 終端機 3：部署 mock USDC + CampaignManager，並給廣告主 100 mock USDC
cd packages/contracts && forge build
CLAIM_SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
ADVERTISER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cat deployments/31337.json      # 記下 campaignManager、usdc、deployBlock
```

API 和 indexer 的環境變數（例如寫在 `.env`，**不要 commit**）：

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham
EVM_CHAIN_ID=31337
EVM_RPC_URL=http://127.0.0.1:8545
USDC_ADDRESS=<deployments/31337.json 的 usdc>
CAMPAIGN_MANAGER_ADDRESS=<campaignManager>
CAMPAIGN_MANAGER_DEPLOY_BLOCK=<deployBlock>
CLAIM_SIGNER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
SIWE_DOMAIN=localhost:3000
WORLD_ID_MODE=simulated
PARTICIPANT_KEY_SECRET=local-demo-secret-at-least-32-characters
INDEXER_CONFIRMATIONS=2
# 本機 demo：讓 anvil #2 的 campaign 直接通過審核（也可以改用 MODERATION_MODE=open）
ADVERTISER_ALLOWLIST=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
```

API 和 indexer 不會自動讀 `.env`，請先在終端機 4、5 載入：bash/zsh 用 `set -a; source .env; set +a`，PowerShell 則逐行設定 `$env:NAME = "value"`。

```bash
# 終端機 4：API（會先跑 migration）
pnpm --filter @vham/api db:migrate && pnpm --filter @vham/api dev
# 終端機 5：indexer
pnpm --filter @vham/api indexer
# 終端機 6：前端
API_URL=http://localhost:3001 NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_WORLD_ID_MODE=simulated \
  pnpm --filter @vham/web dev
```

在瀏覽器錢包新增網路：RPC `http://127.0.0.1:8545`，Chain ID `31337`。

1. **廣告主（anvil #2）：** 打開 http://localhost:3000/advertiser，依序連接錢包、登入、建立 campaign。開始時間要設在幾分鐘後。接著按 Create on-chain，再按 Approve & fund，等狀態變成 `active` 後，複製頁面上的 participant link。
2. **等到開始時間後**（本機鏈時間跟著真實時間走）：
3. **使用者（anvil #3）：** 打開 participant link，依序連接錢包、按 Verify（local simulation）、閱讀內容並作答、按 Claim USDC，錢包就會收到 1 mock USDC。
4. 回到廣告主頁面，可以看到已付金額和完成數。

### 使用真的 World ID（#12）

本機 demo 用模擬；要接真的 World ID，需要 World App（或官方 simulator / sandbox）和 Developer Portal 的 app。以下依 2026-10-13 查證的官方文件（<https://docs.world.org/world-id/idkit/integrate>、<https://docs.world.org/world-id/idkit/signatures>）：

1. 到 [Developer Portal](https://developer.world.org) 建立 app，並完成 World ID 4.0 的 RP registration，取得 `app_id`、`rp_id` 和 `signing_key`。
2. API 設定（只放在 API 的環境變數，**不要 commit**，也不要放進任何 `NEXT_PUBLIC_*`）：

   | 變數 | 說明 |
   | --- | --- |
   | `WORLD_ID_APP_ID` | `app_…`，回傳給前端開 widget |
   | `WORLD_ID_RP_ID` | `rp_…`，用來簽 request 和呼叫 `POST /api/v4/verify/{rp_id}` |
   | `RP_SIGNING_KEY` | RP 簽章私鑰（32 bytes hex），只在伺服器簽 `rp_context`，是秘密 |
   | `WORLD_ID_ENVIRONMENT` | `production`（預設）或 `staging`（配合 simulator）。同一個值會回傳給 widget，後端也據此拒絕其他環境的 proof |
   | `PARTICIPANT_KEY_SECRET` | 至少 32 字元；沒設定時資格驗證回 503 |

   `WORLD_ID_MODE` 必須是 `live`（預設），且 `WORLD_ID_RP_ID`、`RP_SIGNING_KEY` 都要有，否則 `world-id/request` 回 `503 WORLD_ID_NOT_CONFIGURED`。
3. 前端不要設 `NEXT_PUBLIC_WORLD_ID_MODE=simulated`。參與者按 **Verify with World ID** 後，前端會先向 API 取得 `rp_context`，再開 IDKit widget；IDKit 的結果原封不動送到 `eligibility/verify`。
4. 每個 campaign 使用 action `vham-campaign-<id>`。官方文件沒有要求預先在 portal 註冊 action（見 ADR-0007），但這點要等 Base Sepolia 實測確認。
5. 輪替 `RP_SIGNING_KEY` 只影響之後簽出的 request；輪替 `PARTICIPANT_KEY_SECRET` 會破壞進行中 campaign 的重複偵測，只能在 campaign 之間做。

### 部署到 Base Sepolia

請依 [`docs/deployment/TESTNET.md`](deployment/TESTNET.md) 操作。

### Base Sepolia 完整流程實測（2026-10-14，#13）

用真的 World ID（production、Orb 驗證過的 World App）、Base Sepolia 上的 `CampaignManager` 和 Circle 測試 USDC 跑完一次完整流程，全部成功。

> 這次用的是 ADR-0011 之前的 v1 合約，部署紀錄已移到 `packages/contracts/deployments/archive/`。新版合約（`createCampaign` 帶 `draftRef`）需要重新部署並重跑一次，見 [`docs/deployment/TESTNET.md`](deployment/TESTNET.md)。

| 項目 | 值 |
| --- | --- |
| `CampaignManager` | `0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc`（v1，紀錄已封存：`packages/contracts/deployments/archive/84532-2026-10-14-pre-adr-0011.json`） |
| Campaign | on-chain ID `1`；1 USDC × 最多 3 筆；入金 3 USDC |
| World ID | `production`，action `vham-campaign-<campaignId>`，`proofOfHuman()` |

| 步驟 | 結果 | 交易 / 區塊 |
| --- | --- | --- |
| 部署 | owner、signer、USDC、合約程式碼皆在鏈上讀回確認 | `0x2903d8ac3ae70c06441cc34f915fe9be0681b75050a683b9ec643529cdc90338` / 48106357 |
| 建立 campaign | API 驗證後連結 on-chain ID 1 | `0x2042fdcc6c7de3b14df89d4f6fb1c25df4814a87e95f3f8db606879d629f0b39` / 48107249 |
| 入金 | indexer 確認後狀態變 `active` | `0xda1673ced0c7b3c6bf6345d34339e49d86b33060f903168df53571508a3bea65` / 48107268 |
| World ID 驗證 | 真實 proof 通過後端 v4 verify，寫入一筆 eligibility | — |
| 作答 | 開始時間前送出被 `CAMPAIGN_NOT_STARTED` 擋下（預期行為），開始後通過 | — |
| 領取 | 參與者收到 1 USDC | `0xc929552ca98dc923a18baf04b4d2c47b0b05b1c91093444eafa77a854bf876d7` / 48107877 |
| 關閉 | 狀態 `closed` | `0x3bdfb614d99bbc5673469648424fc43ff72d2d32c9b22c10867a2fab65914ae5` / 48107965 |
| 退款 | 關閉 15 分鐘後退回 2 USDC，合約餘額 0，狀態 `settled` | `0x242c6aac019183f29a18c12e39ba2380a94ad2e9f4bf573662831da41c5e44a4` / 48108562 |

實測發現：

- **per-campaign action 不需要預先註冊。** Developer Portal 沒有建立任何 action，`vham-campaign-<id>` 仍然驗證成功（ADR-0007 已更新）。
- **公開 RPC 的 `eth_getLogs` 最多 200 個區塊。** 用 `https://sepolia.base.org` 時要設 `INDEXER_MAX_BLOCK_RANGE=200`，否則 indexer 一直收到 HTTP 413。
- 第一次掃 QR code 出現 World App 的「Verification unavailable」，換掃描方式後成功；API 沒有收到請求，不是後端設定問題。
- 網頁沒有關閉和退款按鈕，這次用 `cast send ... --interactive` 由廣告主自己簽。
- 本機 5432 被其他容器佔用時，PostgreSQL 可以改用其他埠，並同步改 `DATABASE_URL`。

---

## API 流程速查

| 步驟 | 端點 | 誰呼叫 |
| --- | --- | --- |
| 登入 | `POST /v1/auth/nonce` → 錢包簽 SIWE → `POST /v1/auth/verify` | 廣告主 |
| 建草稿 | `POST /v1/campaigns`（`Authorization: Bearer …`、`Idempotency-Key`） | 廣告主 |
| 審核 | `POST /v1/admin/campaigns/:id/moderation { action: "approve", reason }` | 營運者 |
| 鏈設定 | `GET /v1/chain` | 任何人 |
| 取得上鏈參數 | `POST /v1/campaigns/:id/publish`（需已核准） | 廣告主 |
| 回報 / 連結建立交易 | `POST /v1/campaigns/:id/onchain { txHash }`，或 `{}` 以 `draftRef` 查鏈上建立 | 廣告主 |
| 任務內容 | `GET /v1/campaigns/:id/mission` | 使用者 |
| World ID 請求 | `POST /v1/campaigns/:id/world-id/request` | 使用者 |
| 資格驗證 | `POST /v1/campaigns/:id/eligibility/verify { claimant, idkitResponse }` | 使用者 |
| 作答 | `POST /v1/campaigns/:id/submissions`（`Idempotency-Key`） | 使用者 |
| 領取授權 | `POST /v1/campaigns/:id/submissions/:submissionId/authorization` | 使用者 |
| 鏈上領取 | `CampaignManager.claim(authorization, signature)`，由使用者錢包送出 | 使用者 |
| 成效 | `GET /v1/campaigns/:id/analytics` | 廣告主 |
| 檢舉 | `POST /v1/campaigns/:id/reports { reason, details? }` | 任何人 |

完整規格見 [`docs/architecture/API_SPEC.md`](architecture/API_SPEC.md)。
