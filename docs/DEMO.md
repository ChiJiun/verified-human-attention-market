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
- **`CLAIM_SIGNER_PRIVATE_KEY`**：沒設定時不會簽授權。它必須等於合約的 `authorizedSigner`，也不能是部署者的私鑰。

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

交易遲遲沒有收據時，頁面顯示「還在確認中，不要重送」，並持續自動對帳。重新整理頁面後也只會繼續對帳原本那筆交易，不會再送一次。

### 部署到 Base Sepolia

請依 [`docs/deployment/TESTNET.md`](deployment/TESTNET.md) 操作。部署需要你自己的 Foundry keystore、RPC 和 Developer Portal 的 World ID app，所以 testnet 部分（#13 剩下的驗收項目）還沒有實際執行。

---

## API 流程速查

| 步驟 | 端點 | 誰呼叫 |
| --- | --- | --- |
| 登入 | `POST /v1/auth/nonce` → 錢包簽 SIWE → `POST /v1/auth/verify` | 廣告主 |
| 建草稿 | `POST /v1/campaigns`（`Authorization: Bearer …`、`Idempotency-Key`） | 廣告主 |
| 取得上鏈參數 | `POST /v1/campaigns/:id/publish` | 廣告主 |
| 回報建立交易 | `POST /v1/campaigns/:id/onchain { txHash }` | 廣告主 |
| 資格驗證 | `POST /v1/campaigns/:id/eligibility/verify { claimant, idkitResponse }` | 使用者 |
| 作答 | `POST /v1/campaigns/:id/submissions`（`Idempotency-Key`） | 使用者 |
| 領取授權 | `POST /v1/campaigns/:id/submissions/:submissionId/authorization` | 使用者 |
| 鏈上領取 | `CampaignManager.claim(authorization, signature)`，由使用者錢包送出 | 使用者 |
| 成效 | `GET /v1/campaigns/:id/analytics` | 廣告主 |

完整規格見 [`docs/architecture/API_SPEC.md`](architecture/API_SPEC.md)。
