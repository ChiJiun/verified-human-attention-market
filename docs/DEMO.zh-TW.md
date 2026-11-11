# Demo：在本機鏈上跑完整流程

[English](DEMO.md) | [繁體中文](DEMO.zh-TW.md)

這份文件說明如何在本機跑完整的經濟流程：先用一個自動化測試跑一次，再用瀏覽器實際操作。文件也記錄了 2026-10-14 在 Base Sepolia 的實測。

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

本機唯一模擬的是 **World ID**：真的 proof 需要 World App 和 Developer Portal 的 app。本機的 USDC 是 mock token。

目錄：

- [需要的工具](#需要的工具)
- [自動化 demo：端到端測試](#自動化-demo端到端測試)（幾分鐘）
- [瀏覽器 demo：廣告主頁與任務頁](#瀏覽器-demo廣告主頁與任務頁)（約 15 分鐘，另加等待開始時間）
- [使用真的 World ID](#使用真的-world-id)
- [Base Sepolia](#base-sepolia)，含 [2026-10-14 的實測](#base-sepolia-實測2026-10-14)
- [其他指令](#其他指令)
- [廣告主頁面如何處理遲到或被取代的交易](#廣告主頁面如何處理遲到或被取代的交易)
- [API 流程速查](#api-流程速查)

---

## 需要的工具

| 工具 | 版本 | 備註 |
| --- | --- | --- |
| Node.js | 24.15 以上 | |
| pnpm | 12.4.2 | `corepack enable` 後會依 `packageManager` 自動使用 |
| Foundry（forge、anvil、cast） | v1.8.4 | Windows 請裝在 WSL 裡 |
| PostgreSQL | 16 以上 | 用 Docker 最簡單，直接安裝也可以 |

---

## 自動化 demo：端到端測試

這會把上面的流程當成一個測試跑完，不需要瀏覽器。CI 的 `e2e` job 在每次 push 與 pull request 都會跑同一個測試，設定見 `.github/workflows/ci.yml`。

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

**終端機 3：編譯合約並跑測試**

```bash
pnpm install
(cd packages/contracts && forge build)

export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
export E2E_RPC_URL=http://127.0.0.1:8545
pnpm --filter @vham/api test:e2e
```

### Windows（PowerShell + WSL 裡的 Foundry）

- **PostgreSQL：** 在 Docker Desktop 的終端機把上面的 `docker run` 寫成一行執行；或使用任何連得到的 PostgreSQL，把它的 URL 填進 `TEST_DATABASE_URL`。
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
 ✓ e2e/poc.e2e.ts (1 test)
   ✓ POC economic loop on a local chain (1)
     ✓ runs create → fund → verify → claim → close → refund with matching accounting

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

- 每次執行都會清空 `vham_e2e` 資料庫的資料表，所以請用專用的資料庫，**不要**指到開發用的資料庫。
- 測試會把 anvil 的時間往前調。要重跑的話，請先重啟 anvil。
- 沒有設定 `TEST_DATABASE_URL` 時，測試會直接 skip，不會失敗。
- 沒有先 `forge build` 時，測試讀不到 `packages/contracts/out/` 裡的合約。

---

## 瀏覽器 demo：廣告主頁與任務頁

用瀏覽器錢包分別扮演廣告主與參與者：廣告主建立 campaign 並入金，參與者作答並領取。World ID 在這個模式下是模擬的：`WORLD_ID_MODE=simulated` 只能在本機 anvil（chain 31337）啟用，換成其他鏈 API 會拒絕啟動。

下面用到的都是 anvil 啟動時印出的**公開測試帳號**，私鑰所有人都知道。只能用在本機，絕不要拿到任何真實網路上。

| 角色 | 帳號 | 地址 | 私鑰 |
| --- | --- | --- | --- |
| 部署者 | anvil #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 在下方的部署指令裡 |
| claim 簽名者 | anvil #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | 在下方的環境變數裡 |
| 廣告主（匯入瀏覽器錢包） | anvil #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| 參與者（匯入為第二個帳號） | anvil #3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` |

### 啟動各項服務

```bash
# 終端機 1：資料庫（同自動化 demo 的 docker run，POSTGRES_DB 改成 vham）
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
API_URL=http://localhost:3001 NEXT_PUBLIC_CHAIN_ID=31337 pnpm --filter @vham/web dev
```

在 Windows 上，終端機 2、3 在 WSL 執行，其餘在 PowerShell 執行。PowerShell 沒有 `&&`，也沒有 `NAME=value 指令` 的寫法，所以 `pnpm --filter @vham/api db:migrate` 與 `pnpm --filter @vham/api dev` 要分兩次執行；終端機 6 則先設定 `$env:API_URL = "http://localhost:3001"` 與 `$env:NEXT_PUBLIC_CHAIN_ID = "31337"`，再執行 `pnpm --filter @vham/web dev`。

### 實際操作

在瀏覽器錢包新增網路（RPC `http://127.0.0.1:8545`，Chain ID `31337`），並匯入上表的兩個帳號。

1. **廣告主（anvil #2）：** 打開 <http://localhost:3000/advertiser>，按 **Connect wallet**，再按 **Sign in with Ethereum**。填寫表單：
   - **Sponsored content URL：** 任何公開的 `https` 網址，例如 `https://example.com/`。表單只接受 `https`，API 會拒絕 IP 位址、`localhost` 這類內部主機名稱，以及帶埠號的網址。
   - **Start：** 2 到 3 分鐘後。預設是 15 分鐘後，開始時間之前沒有人能作答。
   - **End：** 至少比 Start 晚 15 分鐘，最多晚 24 小時。預設值可以直接用。
   - 一題理解測驗、它的選項，以及哪個選項是正確答案。

   按 **Save draft**，再按 **Create on-chain**，接著按 **Approve & fund**（錢包會要求兩筆交易：核准與入金）。等狀態變成 `active` 後，複製頁面上的 participant link。
2. **等到開始時間。** 本機鏈時間跟著真實時間走。
3. **參與者（anvil #3）：** 把錢包切到第二個帳號，打開 participant link。按 **Connect wallet**，再按 **Verify with World ID**（本機為模擬，不會開 widget，直接通過）。打開內容、選答案並按 **Submit answers**，接著按 **Claim USDC**。錢包會收到 1 mock USDC，頁面顯示「Reward paid to your wallet.」與交易 hash。
4. 回到廣告主頁面，可以看到已付金額和完成數都變了。參與者在驗證後不到 15 秒就送出作答時，仍然會領到獎勵，但頁面會把這次完成列在 `FAST_COMPLETION` 之下，並且不計入「Quality-adjusted accepted」。
5. **廣告主（anvil #2）：** 按 **Close campaign**。**Refund unused budget** 大約 15 分鐘後才會出現（頁面有倒數），因為已發出的授權最多還有效 15 分鐘。按下後狀態變成 `settled`。想跳過等待，執行 `cast rpc anvil_increaseTime 900 && cast rpc anvil_mine`，頁面下一次讀鏈時（最多 10 秒）按鈕就會出現。

登入後的 session 放在 `HttpOnly`、`Secure` 的 cookie 裡（#72）。已確認 Chromium 會保留 `http://localhost` 與 `http://127.0.0.1` 設定的這個 cookie；其他瀏覽器沒有驗證過。瀏覽器沒有保留 cookie 時，登入會直接顯示原因，這時請改用 Chromium，或改用 `next dev --experimental-https`。

### 再跑一次

anvil 每次啟動都是一條新的鏈，而部署腳本會把合約部署到同樣的位址。資料庫如果還留著上一條鏈的資料，兩邊就對不上：indexer 會記錄 `Inconsistent chain read at block N; retrying`，新的 campaign 永遠不會變成 `active`。用過 `anvil_increaseTime` 之後，鏈的時間也會比真實時間快，所以用過之後也請重啟 anvil。下一輪開始前：

1. 停掉 API 與 indexer，並重啟 anvil。
2. 重建資料庫：把 PostgreSQL 容器停掉再啟動（`--rm` 會丟掉資料），或把 `vham` 資料庫 drop 後重新 create。
3. 重新執行部署指令，並確認 `deployments/31337.json` 與環境變數裡的位址和 deploy block 仍然一致。
4. 重新跑 migration，再啟動 API、indexer 與前端。
5. 錢包還記得舊鏈的交易次數（nonce）。請清除它在這個網路的活動紀錄（MetaMask：設定 → 進階 → 清除活動分頁資料）。

---

## 使用真的 World ID

本機 demo 用模擬；要接真的 World ID，需要 World App（或官方 simulator / sandbox）和 Developer Portal 的 app。以下依 2026-10-13 查證的官方文件（<https://docs.world.org/world-id/idkit/integrate>、<https://docs.world.org/world-id/idkit/signatures>）：

1. 到 [Developer Portal](https://developer.world.org) 建立 app，並完成 World ID 4.0 的 RP registration，取得 `app_id`、`rp_id` 和 `signing_key`。
2. API 設定（只放在 API 的環境變數，**不要 commit**，也不要放進任何 `NEXT_PUBLIC_*`）：

   | 變數 | 說明 |
   | --- | --- |
   | `WORLD_ID_APP_ID` | `app_…`，回傳給前端開 widget |
   | `WORLD_ID_RP_ID` | `rp_` 加 1 到 16 位 hex，用來簽 request 和呼叫 `POST /api/v4/verify/{rp_id}` |
   | `RP_SIGNING_KEY` | RP 簽章私鑰（32 bytes hex），只在伺服器簽 `rp_context`，是秘密 |
   | `WORLD_ID_ENVIRONMENT` | `production`（預設）或 `staging`（配合 simulator）。同一個值會回傳給 widget，後端也據此拒絕其他環境的 proof |
   | `PARTICIPANT_KEY_SECRET` | 至少 32 字元；沒設定時資格驗證回 503 |

   `WORLD_ID_MODE` 必須是 `live`（預設），且 `WORLD_ID_RP_ID`、`RP_SIGNING_KEY`、`WORLD_ID_APP_ID` 都要有。三個都沒設定時 `world-id/request` 回 `503 WORLD_ID_NOT_CONFIGURED`；只設定一部分，或 id、私鑰格式不對時，API 啟動就失敗（`loadWorldIdConfig`）。`simulated` 模式只能在 anvil 使用，`world-id/request` 會回傳 `mode: "simulated"` 與 action，沒有 `appId` 與 `rp_context`。

3. 前端沒有自己的 World ID 模式設定，依 `world-id/request` 回傳的 `mode` 決定流程。參與者按 **Verify with World ID** 後，前端向 API 取得 `rp_context`，在瀏覽器產生 32 bytes 隨機鹽並算出綁定這個錢包的 signal（`@vham/shared/world-id`），再開 IDKit widget；IDKit 的結果原封不動連同錢包地址與鹽送到 `eligibility/verify`，換一個錢包或鹽送出會得到 `403 SIGNAL_MISMATCH`。API 只接受 `proof_of_human` 憑證（`issuer_schema_id` 1）。鹽只存在瀏覽器記憶體，API 不儲存也不記錄。
4. 每個 campaign 使用 action `vham-campaign-<id>`。官方文件沒有要求預先在 portal 註冊 action（見 ADR-0007），下面的 Base Sepolia 實測也確認了這一點。
5. 輪替 `RP_SIGNING_KEY` 只影響之後簽出的 request；輪替 `PARTICIPANT_KEY_SECRET` 會破壞進行中 campaign 的重複偵測，只能在 campaign 之間做。

---

## Base Sepolia

**目前沒有與現行程式相容的公開部署。** 2026-10-14 部署的合約早於 ADR-0011，API 會拒絕對它啟動（`campaignIdByDraft` 會 revert）。現在要看完整流程，請用上面的本機 demo。要部署現行合約，請依 [`docs/deployment/TESTNET.md`](deployment/TESTNET.md) 操作；重跑的步驟在 [`docs/deployment/BASE_SEPOLIA_RERUN.md`](deployment/BASE_SEPOLIA_RERUN.md)。

### Base Sepolia 實測（2026-10-14）

用真的 World ID（production、Orb 驗證過的 World App）、Base Sepolia 上的 `CampaignManager` 和 Circle 測試 USDC 跑完一次完整流程（#13），全部成功。

> 這次用的是 ADR-0011 之前的 v1 合約，部署紀錄已移到 `packages/contracts/deployments/archive/`。新版合約（`createCampaign` 帶 `draftRef`）需要重新部署並重跑一次。

| 項目 | 值 |
| --- | --- |
| `CampaignManager` | [`0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc`](https://sepolia.basescan.org/address/0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc)（v1，紀錄已封存：`packages/contracts/deployments/archive/84532-2026-10-14-pre-adr-0011.json`） |
| Campaign | on-chain ID `1`；1 USDC × 最多 3 筆；入金 3 USDC |
| World ID | `production`，action `vham-campaign-<campaignId>`，`proofOfHuman()` preset。這是 #74 修正前的設定：該 preset 仍允許 3.0 proof，已由 `CredentialRequest("proof_of_human")` 取代（ADR-0007） |

| 步驟 | 結果 | 交易 / 區塊 |
| --- | --- | --- |
| 部署 | owner、signer、USDC、合約程式碼皆在鏈上讀回確認 | [`0x2903d8ac…cdc90338`](https://sepolia.basescan.org/tx/0x2903d8ac3ae70c06441cc34f915fe9be0681b75050a683b9ec643529cdc90338) / 48106357 |
| 建立 campaign | API 驗證後連結 on-chain ID 1 | [`0x2042fdcc…629f0b39`](https://sepolia.basescan.org/tx/0x2042fdcc6c7de3b14df89d4f6fb1c25df4814a87e95f3f8db606879d629f0b39) / 48107249 |
| 入金 | indexer 確認後狀態變 `active` | [`0xda1673ce…8a3bea65`](https://sepolia.basescan.org/tx/0xda1673ced0c7b3c6bf6345d34339e49d86b33060f903168df53571508a3bea65) / 48107268 |
| World ID 驗證 | 真實 proof 通過後端 v4 verify，寫入一筆 eligibility | — |
| 作答 | 開始時間前送出被 `CAMPAIGN_NOT_STARTED` 擋下（預期行為），開始後通過 | — |
| 領取 | 參與者收到 1 USDC | [`0xc929552c…4bf876d7`](https://sepolia.basescan.org/tx/0xc929552ca98dc923a18baf04b4d2c47b0b05b1c91093444eafa77a854bf876d7) / 48107877 |
| 關閉 | 狀態 `closed` | [`0x3bdfb614…65914ae5`](https://sepolia.basescan.org/tx/0x3bdfb614d99bbc5673469648424fc43ff72d2d32c9b22c10867a2fab65914ae5) / 48107965 |
| 退款 | 關閉 15 分鐘後退回 2 USDC，合約餘額 0，狀態 `settled` | [`0x242c6aac…1c5e44a4`](https://sepolia.basescan.org/tx/0x242c6aac019183f29a18c12e39ba2380a94ad2e9f4bf573662831da41c5e44a4) / 48108562 |

實測發現：

- **per-campaign action 不需要預先註冊。** Developer Portal 沒有建立任何 action，`vham-campaign-<id>` 仍然驗證成功（ADR-0007 已更新）。
- **公開 RPC 的 `eth_getLogs` 最多 200 個區塊。** 用 `https://sepolia.base.org` 時要設 `INDEXER_MAX_BLOCK_RANGE=200`，否則 indexer 一直收到 HTTP 413。
- 第一次掃 QR code 出現 World App 的「Verification unavailable」，換掃描方式後成功；API 沒有收到請求，不是後端設定問題。
- 當時網頁沒有關閉和退款按鈕，這次用 `cast send ... --interactive` 由廣告主自己簽。現在已經有這兩個按鈕。
- 本機 5432 被其他容器佔用時，PostgreSQL 可以改用其他埠，並同步改 `DATABASE_URL`。

---

## 其他指令

commit 前要跑的檢查在 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

### 只跑 PostgreSQL 整合測試

```bash
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
pnpm --filter @vham/api exec vitest run postgres
```

這些測試同樣會清空該資料庫的資料表。

### 啟動 API 與 indexer（連到已部署的合約）

```bash
cp .env.example .env    # 依註解填入；不要 commit .env
set -a; source .env; set +a        # 載入 .env；API 和 indexer 不會自己讀它
pnpm --filter @vham/api db:migrate
pnpm --filter @vham/api dev        # API，預設 http://localhost:3001
pnpm --filter @vham/api indexer    # 另開一個終端機（同樣先載入 .env）：鏈上事件索引 + campaign 狀態同步
```

API 和 indexer 只從環境變數讀設定。shell 裡沒有 `DATABASE_URL` 時，`db:migrate` 會直接失敗（`DATABASE_URL is required for migrations`）。每個執行 API 或 indexer 的終端機都要先載入這些變數。

各組環境變數的作用：

- **鏈上設定**（`EVM_RPC_URL`、`USDC_ADDRESS`、`CAMPAIGN_MANAGER_ADDRESS`、`CAMPAIGN_MANAGER_DEPLOY_BLOCK`）：只要填了，就必須填完整，而且 API 啟動時會驗證鏈 ID 和合約程式碼。
- **`SIWE_DOMAIN`**：沒設定時無法登入，廣告主相關端點一律回 401。
- **`WORLD_ID_RP_ID` + `RP_SIGNING_KEY` + `WORLD_ID_APP_ID` + `PARTICIPANT_KEY_SECRET`**：前三個要一起設定；都沒設定時，資格驗證一律回 503；只設定一部分或格式錯誤時，API 拒絕啟動。
- **`CLAIM_SIGNER_PRIVATE_KEY`**（或正式環境的 `CLAIM_SIGNER_URL` + `CLAIM_SIGNER_ADDRESS`，ADR-0008）：沒設定時不會簽授權。簽署位址必須等於合約的 `authorizedSigner`，也不能是部署者的私鑰；明文私鑰只允許在 anvil 與 Base Sepolia 使用。
- **審核（#24）**：預設 `MODERATION_MODE=review`，新 campaign 要由 `OPERATOR_ADDRESSES` 裡的錢包核准（或廣告主在 `ADVERTISER_ALLOWLIST`）才能發佈、作答。`MODERATION_MODE=open` 只能在本機 anvil 使用。詳見 [docs/operations/MODERATION.md](operations/MODERATION.md)。

### 廣告主前端

```bash
# API 端（.env）：SIWE_DOMAIN 必須等於前端網址的 host
SIWE_DOMAIN=localhost:3000

# 前端
export API_URL=http://localhost:3001        # Next 把 /api/* 轉發到這裡
export NEXT_PUBLIC_CHAIN_ID=84532           # 本機 anvil 用 31337
pnpm --filter @vham/web dev                 # http://localhost:3000/advertiser
```

頁面流程（#11）：

1. 連接瀏覽器錢包；網路不對時會顯示切換按鈕。
2. 用 Sign-In with Ethereum 登入。重新整理後 session 仍在；沒連錢包時，頁面顯示「Signed in as …」和「Sign out」。「Disconnect」會先登出再中斷錢包；登出失敗時兩者都保留，可以再按一次。
3. 填寫 campaign（獎勵用十進位 USDC 輸入，內部以整數 atomic units 換算），設計 1–3 題理解測驗，然後按「Save draft」。
4. 按「Create on-chain」送出 `createCampaign`，API 驗證交易後完成連結。
5. 按「Approve & fund」核准並入金。錢包給 CampaignManager 的 USDC 額度（allowance）已經達到預算時，按鈕顯示為「Fund campaign」，只送入金。
6. indexer 確認入金後，狀態變成 `active`，頁面會顯示預算與成效。
7. 想提早結束時按「Close campaign」。關閉後 API 不再發新的領取授權，已發出的授權在到期前仍可在鏈上領取。結束前最後一分鐘不提供這個按鈕，因為交易可能在結束後才上鏈而 revert。
8. 退款要等到「關閉時間（沒關閉則是結束時間）加 15 分鐘」之後，因為已發出的授權最多還有效 15 分鐘，合約等它們全部過期才放行。這段時間頁面顯示開放時間、倒數和原因。時間到了按「Refund unused budget」，狀態變成 `settled`，未用完的預算回到廣告主錢包。

---

## 廣告主頁面如何處理遲到或被取代的交易

合約被 owner 暫停時，頁面說明退款要等解除暫停；「Close campaign」不受暫停影響。兩個按鈕送出前都會重新讀鏈並模擬交易，被合約拒絕時直接顯示 custom error 名稱（例如 `RefundNotAvailable`），不會自動重送。

**關閉與退款（#86）。** 交易在等待時間（2 分鐘）內沒有收據時，卡片顯示「還在確認中」，該按鈕先隱藏；頁面每 10 秒查一次收據、錢包帳號的 nonce 與 campaign 狀態，不必重新整理：

- 收據到了，或鏈上狀態已經是動作的結果（關閉後 `closed`、退款後 `settled`，例如錢包加速後由替代交易完成），卡片改成完成，按鈕依鏈上狀態更新。
- 收據顯示 revert，或同一個 nonce 已被另一筆交易用掉（在錢包取消），且重新讀到的 campaign 沒有變化，卡片說明原因，按鈕在鏈上仍允許時重新出現。
- 錢包的 RPC 可能由不同後端回答，所以要連續兩次檢查得到同一個結論才算數；之後鏈上若仍出現動作的結果，顯示失敗的卡片也會改成完成。
- 交易只要曾經查到過（知道它的 nonce），在那個 nonce 被用掉之前就一直算「還在確認」，因為它隨時可能上鏈。從來沒查到過、超過 10 分鐘仍查不到的交易，視為可能根本沒送出：一般按鈕仍隱藏，改為提供另外的「Close campaign anyway」／「Refund unused budget anyway」並附警告。再按之前請先看錢包的活動紀錄；重送前仍會模擬，若原交易其實已上鏈，模擬會失敗而不送出，兩筆都還沒上鏈時第二筆只會 revert 並耗 gas。

**核准與入金（#103）。** 核准（Approve USDC）與入金（Fund campaign）的交易沒有收據時，依同樣的規則處理：卡片顯示「還在確認中」，入金按鈕先隱藏，頁面每 10 秒查一次收據、nonce，以及交易要造成的結果，不必重新整理。

- 核准的結果是 allowance（owner 為廣告主、spender 為 CampaignManager）達到預算，也就是 rewardPerCompletion × maxCompletions（atomic units，整數計算）。看到後卡片改成完成，按鈕改為「Fund campaign」，按下後才送入金，頁面不會自動送出。
- 核准的收據一到（即使是之後檢查才查到），按鈕就會回來，不必等 allowance 達到預算。同一個錢包對 CampaignManager 只有一個 allowance，另一個分頁的核准或入金、或在錢包裡調低的額度上限，都可能讓它停在預算以下；這時按鈕顯示「Approve & fund」，按下時重新讀 allowance，仍不足才再核准。
- 入金的結果是鏈上的 campaign 變成 `active`、`fundedBudget` 等於預算，或 API 的索引已經看到入金。入金送出後，按鈕在看到這個結果之前都保持隱藏。只要看到過一次已入金，這個頁面就不再提供核准或入金，即使之後某次讀取（可能來自落後的 RPC 後端）又顯示尚未入金。
- revert、被取代、兩次檢查一致、失敗卡片之後改成完成，以及從未查到的交易 10 分鐘後改提供「Approve & fund anyway」／「Fund campaign anyway」，都和關閉、退款相同。例外是 revert 的核准：allowance 也可能來自其他 campaign 的核准，所以這張卡片不會之後改成「USDC approved」。
- 每次送出前頁面都重新讀鏈，包括核准完成、即將送入金的那一刻（核准可能等了兩分鐘）。原本的入金其實已上鏈，或 allowance 已被改到預算以下時，頁面說明原因，不會送出。兩筆核准都上鏈只是把額度再設一次並耗 gas；兩筆入金都送出時，第二筆會被合約以 `InvalidCampaignStatus` 拒絕並耗 gas，USDC 不會被扣兩次。
- 等待入金期間，頁面每次重新整理都會讀 allowance 和 campaign，用來決定按鈕顯示「Approve & fund」還是「Fund campaign」。

一個動作進行中時，其他按鈕（包含「Close campaign」與「Refund unused budget」）只會變成停用，不會消失，連點也不會點到滑進同一位置的「Refresh」。

關閉與退款這兩個按鈕只對目前部署的合約（`GET /v1/chain`）上的 campaign 出現。ADR-0011 之前的舊合約上的 campaign，頁面沒有合約位址可用，仍要用 `cast send` 由廣告主錢包送 `closeCampaign(id)` 和 `refundUnusedBudget(id)`。

**建立。** 建立交易遲遲沒有收據時，頁面顯示「還在確認中，不要重送」，並持續以 `draftRef` 向 API 對帳。API 暫時連不到鏈（`503 RPC_UNAVAILABLE`）也算「還在對帳」，頁面約兩分鐘內會自己重試；放棄時卡片明確寫出原因並請你按「Check again」（只查詢，不會送交易）。重新整理後頁面不保留交易 hash，只記得「這個草稿可能已送出建立交易」，因此優先提供「Check again」；超過 10 分鐘才會再提供「Create on-chain anyway」（若原交易其實已上鏈，第二筆只會 `DraftAlreadyCreated` revert 並耗 gas，不會建立第二個 campaign）。

「可能有建立交易還沒確認」的幾種邊界（#78）：

- 另一個分頁或瀏覽器的建立交易已上鏈但還沒達到確認深度時，`/publish` 以最新區塊判斷並回 `409 DRAFT_ALREADY_CREATED`，這個分頁不會再送；頁面改為等它確認後連結。交易還在 mempool、尚未上鏈時 API 看不到，這時只有合約擋得住（第二筆 revert，只耗 gas）。
- 瀏覽器不能用 `localStorage`（例如私密模式）時，標記只存在這個分頁的記憶體裡：同一次瀏覽中「Check again」與 10 分鐘後的「Create on-chain anyway」照常出現，重新整理後就不記得了，頁面會直接提供「Create on-chain」（送出前仍會先查已確認的建立，`/publish` 再查最新區塊）。
- 按「Create on-chain anyway」後在錢包拒絕簽署，這次沒有送出任何交易，先前那次嘗試的標記會保留，頁面繼續提供「Check again」。

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
| 資格驗證 | `POST /v1/campaigns/:id/eligibility/verify { claimant, signalSalt, idkitResponse }` | 使用者 |
| 作答 | `POST /v1/campaigns/:id/submissions`（`Idempotency-Key`） | 使用者 |
| 領取授權 | `POST /v1/campaigns/:id/submissions/:submissionId/authorization` | 使用者 |
| 鏈上領取 | `CampaignManager.claim(authorization, signature)`，由使用者錢包送出 | 使用者 |
| 成效 | `GET /v1/campaigns/:id/analytics` | 廣告主 |
| 檢舉 | `POST /v1/campaigns/:id/reports { reason, details? }` | 任何人 |

完整規格見 [`docs/architecture/API_SPEC.md`](architecture/API_SPEC.md)。
