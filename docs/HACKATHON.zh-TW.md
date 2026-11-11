# 繳交用摘要

[English](HACKATHON.md) | [繁體中文](HACKATHON.zh-TW.md)

這是專案的簡短說明，可以直接貼到報名表。每一句都能在這個 repo 裡查證；證據的連結在 [README](../README.zh-TW.md)。

## 待 owner 填寫

| 欄位 | 內容 |
| --- | --- |
| 黑客松與賽道 | _待填_ |
| 隊伍 | _待填_ |
| Demo 影片 | _待填_ |
| 活動期間完成的部分 | _待填_ |
| AI 工具的使用 | _待填_ |

## 說明

**一句話。** 測試網概念驗證。廣告主把 USDC 鎖進鏈上託管，每位經 World ID 驗證的真人讀完贊助內容、通過理解測驗後，在每個 campaign 領一次獎勵。

**問題。** 錢包與點擊不等於真人。機器人或一人多錢包可以重複領走同一筆活動預算。

**解法。** World ID 擋下同一人在同一個 campaign 的第二次領取，而且不揭露身分。鏈下驗證器檢查作答後簽發 EIP-712 授權。`CampaignManager` 合約檢查簽章、預算、名額、期限與重放後才付款；campaign 關閉並過了等待期後，把沒用完的預算退回廣告主。

**技術。** Solidity／Foundry（單元、fuzz、stateful invariant 測試）、Fastify API 與鏈上事件 indexer（PostgreSQL）、Next.js、World ID IDKit、Base Sepolia 上的 USDC。

**現況與下一步。** 2026-10-14 以真實 World ID proof 在 Base Sepolia 跑通完整流程（v1 合約）。之後合約有改版，新版只在本機鏈與 CI 跑過。未審計、只用測試資金、還沒有真實廣告主。下一步：重新部署新版合約、重跑測試網流程，再找真實買家測試。

**一項該說明的限制。** 理解測驗只是基本的參與度訊號，不能證明對方認真讀過。World ID 限制每個人在每個 campaign 只能領一次，並不保證作答是用心的。

## 該看哪裡

| 想看 | 打開 |
| --- | --- |
| 哪些已證實、哪些還沒有 | [README：目前哪些是真的](../README.zh-TW.md#目前哪些是真的) |
| 測試網上的交易 | [DEMO：Base Sepolia 實測（2026-10-14）](DEMO.zh-TW.md#base-sepolia-實測2026-10-14) |
| 合約 | [`packages/contracts/src/CampaignManager.sol`](../packages/contracts/src/CampaignManager.sol)，測試在 [`packages/contracts/test/`](../packages/contracts/test/) |
| 完整金流的端到端測試 | [`apps/api/e2e/poc.e2e.ts`](../apps/api/e2e/poc.e2e.ts) |
| 怎麼執行 | [README：在本機執行](../README.zh-TW.md#在本機執行)與 [DEMO](DEMO.zh-TW.md) |
| 每個決策的理由 | [docs/adr/](adr/README.md) |

專案使用的第三方技術：World ID（IDKit，以及後端驗證 4.0 proof）、Base（Base Sepolia 測試網）、USDC（Base Sepolia 上 Circle 的測試 USDC）。
