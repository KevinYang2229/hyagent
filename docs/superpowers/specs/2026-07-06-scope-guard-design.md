# OA Agent 範圍守門（Scope Guard）設計

日期：2026-07-06

## 問題

使用者問「圓周率是多少」等與公司/OA 無關的問題時，agent 仍會回答。根因是**整條路由鏈路沒有任何「離題／範圍外」的守門**：

1. **分類器只挑最像的意圖，不會拒絕範圍外**（`intent-router.ts` 的 `classify`）。prompt 寫「任何『想知道答案』的提問 → kb.query」，離題問題照樣被歸類；就算回 `none`，非點黏流程也會 fallback 到 form 服務。
2. **知識庫檢索沒有相關度門檻**。向量檢索永遠回傳 top-k；且 `rerank.ts` 把 reranker「判定不相關而省略」的片段又硬補回來 slice，導致不相關片段永遠存活、進到作答 LLM。
3. **form 服務的 system prompt 沒禁止答離題**。fallback 到填表助理時，泛用 LLM 被問圓周率就熱心回答。

## 目標範圍（可回答界線）

- **表單申請**（請假／外出／報銷等）
- **公司知識庫**檢索得到的公司資訊
- **基本客套**（打招呼、道謝、「你是誰」）→ 友善簡短回應並引導回正題

其餘（一般常識、算術、閒聊、與公司無關的問題）→ **禮貌婉拒＋介紹能力**，且沿用現有中英 locale。

## 架構

新增一個 **`assistant` 守門服務**，統一處理「基本客套」與「離題婉拒」。它是把守範圍的唯一出口。

- `sticky: false`：旁路服務，跟 knowledge 一樣**不觸碰** `session.values` / `session.status`，填表流程不受影響。
- 一次小 LLM 呼叫，一個 system prompt 同時分辨兩種情境：
  - 打招呼／道謝／問你是誰 → 簡短友善回應並說明能做什麼。
  - 與公司/表單無關的一般問題 → 禮貌婉拒並說明服務範圍。
- 中英 locale：依 `session.locale` 產生對應語言回覆（沿用 `normalizeLocale`）。
- `intents()` 回一個 `off-topic` 描述，供 Haiku 分類器目錄使用；`keywords` 留空（不參與關鍵字先行）。
- **永遠啟用**：跳過 `serviceRegistry.enabledFor` 的 `disabledServices` 過濾，租戶不可關閉（否則退回舊漏洞）。

**為什麼用「服務」而非在 router 直接塞婉拒字串**：貼合現有 `AgentService` + `serviceRegistry` pattern，`runTurn` 不需改動，客套與婉拒共用同一處，最一致也最省事。

## 分類器改造（`intent-router.ts` 的 `classify`）

讓 `classify` 多輸出一個明確值 `off-topic`（不再只有 intent id / none），以區分「離題」與「單純沒把握」。

路由對照：

| classify 結果 | 非點黏流程 | 點黏流程（填表中）|
|---|---|---|
| 具體 intent（form/kb） | 該服務 | 該服務 |
| `off-topic`（離題/客套） | → **assistant 守門** | → **assistant 守門**（旁路，表單流程不受影響）|
| `none`（沒把握/失敗） | → form fallback（**維持現狀**）| → 續留表單（**維持現狀**）|

關鍵原則：**只有分類器明確判離題才婉拒**；沒把握（`none`）時維持現有行為，避免誤殺正常填表。

分類器 prompt 追加規則（示意）：與公司/OA 無關的一般常識、算術、閒聊，或單純打招呼/道謝/問候 → 輸出 `off-topic`。輸出格式擴充為 `{"intent":"<id|off-topic|none>","confidence":0~1}`。

## 知識庫防呆（防禦縱深）

即使某題被分類器送進 knowledge，也不硬答不相關內容。

- `rerank.ts`：**移除把 reranker 剔除片段補回來的邏輯**（現行 `merged = [...picked, ...chunks.filter(未選)]`）。改為尊重 reranker 取捨，只回 `picked.slice(0, topK)`；reranker 全數剔除 → 回空陣列。
- `knowledge.agent-service.ts`：`chunks.length === 0` 時已回「知識庫查無相關資料 / No relevant information found」，剛好接住空結果。

## 改動清單

| 檔案 | 改動 |
|---|---|
| `server/src/modules/conversation/assistant.agent-service.ts`（新檔）| 守門/客套服務：小 LLM 呼叫、中英 locale、婉拒＋介紹能力；`sticky:false`；`intents()` 回 `off-topic` 描述 |
| `server/src/modules/conversation/service.registry.ts` | 註冊 assistant 服務；`enabledFor` 讓 assistant 永遠啟用（不受 `disabledServices` 影響）|
| `server/src/modules/conversation/intent-router.ts` | `classify` 多輸出 `off-topic`；`route` 依對照表把 `off-topic` 導向 assistant（點黏/非點黏皆是）|
| `server/src/modules/knowledge/rerank.ts` | 移除補回剔除片段的邏輯 |

## 測試

- intent-router：離題→assistant、客套→assistant、沒把握→維持 form fallback / 續留表單、具體意圖→對應服務。
- rerank：reranker 全數剔除 → 回空陣列（不再補回）。
- assistant 服務：離題輸入回婉拒且不動 `session.values/status`；en locale 回英文。

## YAGNI（明確排除）

- 不做管理端可調的婉拒白名單。
- 不做多輪離題計數／升級。
- 不動 knowledge 的向量檢索本身（只調整 rerank 這關）。
