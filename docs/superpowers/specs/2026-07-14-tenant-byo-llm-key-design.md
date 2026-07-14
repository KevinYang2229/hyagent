# 租戶自帶 AI 金鑰（BYO key）＋ Token 級成本歸戶 — 設計

**日期**：2026-07-14
**狀態**：設計（已與使用者確認方向）
**動機**：目前全系統共用一組 env 的 AI API key（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`），所有租戶燒同一個帳；用量雖按租戶記，但無法收費，大客戶也無法用自己企業的 key。本設計讓租戶自行設定 OpenAI / Anthropic key 與模型，並把 token 用量升級為可計價的成本歸戶。

## 決策紀錄

| # | 決策 | 選定 |
|---|---|---|
| D1 | 設定入口 | **sk\_ 秘密金鑰自助 API ＋ admin 後台代設**兩者都做。sk\_ 機制現成，客戶工程師可自助；admin SettingsTab 加「AI 模型」區塊代設。不做租戶登入後台（另案演進）。 |
| D2 | 設定範圍 | **provider ＋ key ＋ model**。不開放 routerModel / baseUrl（YAGNI，之後接地端模型再開）。 |
| D3 | Embedding 歸屬 | 租戶**有 OpenAI key 就用它**打 embedding（不論對話 provider 選誰）；只設 Anthropic key 或未設 → 用平台 key。因此 key 按廠商分欄存。 |
| D4 | 成本歸戶 | **本次一起做**：usage 按「模型 × key 來源」聚合 token，配單價表於讀取時計算成本。 |
| D5 | 傳遞方式 | **方案 A：工廠參數化**。`getLLMProvider(tenant?)` 顯式傳 tenant，SDK client 以 apiKey 為 key 快取。不用 AsyncLocalStorage（隱式、背景 job 無上下文）、不用每呼叫帶參數（重複邏輯散落）。 |
| D6 | 失效行為 | 租戶 key 401/403/額度不足 → 明確錯誤歸因，**絕不 fallback 平台 key**（防平台默默買單）。 |

## 架構

### 資料模型（tenant.types.ts）

```ts
llmConfig?: {
  provider?: 'anthropic' | 'openai'; // 對話用哪家；未設＝平台預設（env.LLM_PROVIDER）
  model?: string;                    // 未設＝該 provider 的平台預設模型
  anthropicApiKey?: string;
  openaiApiKey?: string;             // embedding 也吃這把（D3）
}
```

**模型路由規則**：租戶未設 `provider` → 一切照舊（含 `LLM_ROUTER_MODEL` 便宜模型分工）。租戶有設 `provider` → 該租戶**所有**呼叫（含意圖路由、rerank）都用 `llmConfig.model`，避免廠商錯配（如租戶用 OpenAI 但 router model 名是 claude-haiku）。

### LLM 工廠（lib/llm）

- 兩個 provider 由 module-level singleton 改為 `createAnthropicProvider(apiKey)` / `createOpenAIProvider(apiKey)` 工廠；內部以 apiKey 為 key 快取 SDK client（不每請求重建）。
- `getLLMProvider(tenant?)`：讀 `tenant.llmConfig` 決定 provider / key / 預設 model；未帶 tenant 或未設定 → 現行 env 行為。**預設租戶與舊 widget 行為零改變**。
- 呼叫點改動（各一行，tenant/session 均已在手）：
  - `modules/conversation/conversation.agent.ts`
  - `modules/conversation/intent-router.ts`
  - `modules/knowledge/rerank.ts`
  - `modules/knowledge/knowledge-file.service.ts`
- embedding 同款：`getEmbeddingProvider(tenant?)`（lib/embedding），租戶有 `openaiApiKey` 就用它；知識庫入庫（ingest job / 檔案上傳）與檢索端傳入 tenant。

### API

- 租戶自助：`GET / PUT /api/tenant/llm-config` — **只認 sk\_ 秘密金鑰**（pk\_ 一律 403）。
- admin 代設：`GET / PUT /api/admin/tenants/:id/llm-config`（requireAdmin），SettingsTab 加「AI 模型」區塊。
- **存前驗證**：PUT 時以該廠商 models list API 打一次輕量請求，無效回 400「金鑰無效」，不存壞 key。
- 遮罩：GET 回傳 key 只露尾 4 碼；PUT 傳 `null` 清除該 key、省略欄位＝不變。
- 所有異動寫 audit log（現有 audit store）。

### 成本歸戶（usage.store ＋ 單價表）

- `TenantUsage` 新增按「模型 × key 來源」聚合：
  `llmByModel: { [model]: { inputTokens, outputTokens, cacheReadTokens, keySource: 'platform' | 'tenant' } }`
  另加 `embeddingTokens`。既有 `llmTokens` 總數欄位保留並繼續累加（向後相容）。
- `recordLLMUsage(tenantId, usage, { model, keySource })` 擴充簽章；呼叫點已有 usage 紀錄行，就地補參數。
- 新增 `server/src/config/model-pricing.ts`：USD / MTok 單價表（input / output / cacheRead 分開），未知模型 fallback 0 並標「無單價」。成本於**讀取時**計算（admin usage 查詢端點），不落地——改價免重算歷史。
- UsageTab 改版：各模型 token 明細、預估成本（USD）、區分「平台 key（應收費用）」與「自帶 key（參考資訊）」。

## 安全

- key 儲存比照現有 `ssoSecret`：MVP 明文入 tenant store，接 DB 時改加密。任何 API 回應與 log 均不得出現完整 key。
- pk\_ 公開金鑰不可讀寫 llm-config（僅 sk\_ / admin）。
- 錯誤歸因：provider 回 401/403/quota → `AppError`「此租戶的 AI 金鑰無效或額度不足」，不 fallback（D6）。

## 測試策略

- 單元：settings fallback 矩陣（無設定／只 key／key＋provider／清除）、工廠 client 快取命中、usage 按模型×來源聚合、key 遮罩。
- 存前驗證與失效歸因：mock provider 回 401 → 400／明確錯誤，確認未寫入。
- 回歸：`npm run smoke` 不受影響（純 env 路徑）＝向後相容驗證。

## 非目標（v1）

- routerModel / baseUrl 開放（接地端 vLLM / Ollama 時再開）。
- 租戶登入後台（自助僅走 sk\_ API）。
- key 加密儲存（隨 Prisma 持久化一起做）。
- Azure OpenAI / 其他廠商。
