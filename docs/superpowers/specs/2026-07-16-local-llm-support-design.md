# 設計：支援地端（on-prem）大語言模型

- 日期：2026-07-16
- 狀態：已核可，待寫實作計畫
- 範圍：`server/` 的 LLM / embedding provider 抽象層 + env 設定 + 租戶設定 + admin/租戶前端「AI 模型」選項

## 目標與動機

讓平台**同時支援雲端與地端 LLM**，可切換。部分企業（政府、金融、醫療等）不願把對話資料送上雲端，要求 AI 推論在自家機房內完成。本設計讓同一套程式碼既能接雲端 API（Anthropic / OpenAI），也能接地端自架的 OpenAI 相容推理服務（vLLM / Ollama / TGI / TEI 等）。

## 需求（來自釐清）

1. **雲/地皆可**：平台要能設定成走雲端或地端。
2. **兩層切換**：env 當部署層預設；個別租戶可在後台覆寫成自己的雲/地選擇。
   - 地端客戶：整套安裝 `LLM_PROVIDER=local`，全走地端。
   - SaaS：`LLM_PROVIDER=anthropic`，租戶可 BYO key 或改走地端。
3. **embedding 也支援地端**：知識庫 RAG 的 embedding 能指向地端端點，斷網環境 RAG 仍可用。
4. **選地端就絕不 fallback 回雲端**：資料不外流是前提。連不到地端就報錯，不改道雲端。

## 為何可行（既有架構）

- `lib/llm/types.ts` 的 `LLMProvider` 介面是 vendor-neutral（text / tool_use / tool_result 區塊 + JSON Schema 工具），對話模組不 import 任何廠商 SDK。註解本就寫「方便日後換 OpenAI/Azure/local」。
- `openai.provider.ts` 用的是 **Chat Completions + function calling**——這正是 vLLM / Ollama / TGI / LocalAI 對外提供的「OpenAI 相容端點」格式。故地端模型可**重用** OpenAI provider 的訊息轉換與 tool_calls 解析邏輯，不必新寫一份。
- `resolve-settings.ts` 已經是「這次對話用哪個 AI」的決策層（租戶設定 → 平台預設 fallback、模型鎖定、計費歸戶）。加地端＝在此多加一個選項。

## 設計決策

### 方案 A（採用）：`local` 為第一級 provider，重用 OpenAI 相容格式

- `LLMProviderName` 與 `TenantLLMConfig.provider` 加入 `'local'`。
- 工廠 `getLLMProvider`：`local` 走 `createOpenAIProvider`，但 client 帶 `baseURL`。
- `baseURL` 順著 `ResolvedLLMSettings` 一路帶下去（部署層由 env 提供）。
- 好處：後台「AI 模型」卡片可明確列「地端」；計費歸戶 / keySource 清楚；程式與 UI 分得出「地端」與「雲端 OpenAI」。

### 方案 B（否決）：不加新 provider，只把 openai 的 baseURL 開成可設定

- 「地端 vs 雲端」變成「填哪個 URL」。
- 否決原因：單一 `OPENAI_BASE_URL` 無法**同時**服務「一個用雲端 OpenAI 的租戶」與「一個用地端的租戶」，違反需求 2（同系統雲/地 per-tenant 混用）。

### 安全性決策：地端 endpoint 是「部署層基礎設施」，租戶不可自填 URL

租戶在後台選 `local` 時，用的是部署層那**唯一**的 `LLM_BASE_URL`（平台營運者控制的地端推理機）。租戶**不能自帶任意 URL**。

- 避免 SSRF（租戶把 baseURL 指向內網任意服務）。
- 符合現實：地端就一台（或一組）推理機，非租戶各自持有。
- 租戶的選擇語意因此收斂為：「走部署層地端」 vs 「走自己的雲端 BYO key」。

### Fallback 策略：跨 provider 絕不自動切換

現有架構本就不會跨 provider 自動 fallback（`resolveLLMSettings` 只有「租戶 key → 平台 env key」的**同 provider** key fallback）。選 `local` 就走 local；端點連不到 → `mapProviderError` 拋錯，不改道雲端。本設計保留此性質，並以測試鎖定。

## 元件與變更點

### 1. env（`server/src/config/env.ts`）

新增／修改：

```
LLM_PROVIDER: z.enum(['anthropic', 'openai', 'local'])   // 加 'local'
LLM_BASE_URL: z.string().optional()                       // 地端 chat 端點，如 http://vllm:8000/v1
LLM_API_KEY:  z.string().default('not-needed')            // 地端通常不驗 key，給 dummy

EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai')  // 新增
EMBEDDING_BASE_URL: z.string().optional()                          // 地端 embedding 端點
```

superRefine 追加 fail-fast（比照現有 `OA_BASE_URL` / `SMTP_HOST` 模式）：

- `LLM_PROVIDER === 'local'` 且無 `LLM_BASE_URL` → 報錯。
- `EMBEDDING_PROVIDER === 'local'` 且無 `EMBEDDING_BASE_URL` → 報錯。
- 既有的「anthropic 需 ANTHROPIC_API_KEY / openai 需 OPENAI_API_KEY」保留；`local` 不強制 key。

### 2. 解析層（`server/src/lib/llm/resolve-settings.ts`）

- `LLMProviderName` 加 `'local'`。
- `ResolvedLLMSettings` 加 `baseURL?: string`。
- `resolveLLMSettings`：
  - `provider === 'local'` → `baseURL = env.LLM_BASE_URL`、`apiKey = env.LLM_API_KEY`、`keySource = 'platform'`（地端無租戶 key 概念）。
  - 雲端（anthropic/openai）→ `baseURL = undefined`（用 SDK 內建位址），維持現行 key/keySource 邏輯。
- local 的 model 解析（**須在既有 `DEFAULT_MODELS[provider]` 查表前先攔截**，否則租戶選 local 而部署預設非 local 時會查到 `undefined`）：
  - `provider === 'local'` → `model = config.model ?? env.LLM_MODEL`，不經 `DEFAULT_MODELS`。
  - `env.LLM_MODEL`：部署層跑地端時設為地端模型名（如 `Qwen2.5-32B-Instruct`）。
  - `DEFAULT_MODELS` 維持只含 anthropic/openai 的靜態預設，僅供雲端 provider 使用。
- `pickModel` 的 `lockModel` 行為不變（租戶自訂 provider 時鎖模型，忽略 router/rerank 的覆寫）。

### 3. chat provider（`server/src/lib/llm/openai.provider.ts` + `index.ts`）

- `openai.provider.ts`：
  - module 級 `getClient` 快取鍵由 `apiKey` 改為 `apiKey|baseURL`（不同 baseURL 不可撞同一 client）。
  - 建 client 時帶 `baseURL: settings.baseURL`（雲端為 undefined，等同現行）。
- `index.ts` 工廠：`settings.provider === 'anthropic' ? anthropic : openai`；`local` 自然落到 `else`（openai 實作）。加註解說明 local 走此分支。

### 4. embedding（`server/src/lib/embedding/index.ts`）

- `getClient` 同樣把快取鍵與建構帶上 `baseURL`。
- `getEmbeddingProvider(config)`：
  - `env.EMBEDDING_PROVIDER === 'local'` → 用 `env.EMBEDDING_BASE_URL` + `env.LLM_API_KEY`（dummy），`keySource = 'platform'`。
  - 否則維持現行（租戶 `openaiApiKey` → tenant，否則平台 `OPENAI_API_KEY`）。
- embedding provider 採**部署層 env 驅動**（非 per-tenant），簡化設計；per-tenant BYO embedding 維持 openai-only。
- **維度／模型注意**：換 embedding 模型（如地端 `bge-m3`）維度與 OpenAI 不同，各租戶索引必須以同模型**重跑 ingest**（README 已載明，此處重申；索引檔為 `knowledge-index.<tenantId>.json`）。

### 5. 租戶設定（`server/src/modules/tenant/llm-config.schema.ts` / `llm-config.service.ts` + 型別）

- `provider` zod enum 由 `['anthropic', 'openai']` 改為 `['anthropic', 'openai', 'local']`。
- `llm-config.service.ts` 的 `provider` 型別 union 加 `'local'`。
- 租戶選 `local` 時**不涉及任何 URL 欄位**（沿用部署層 `LLM_BASE_URL`），也不需租戶 key。

### 6. verify-key（`server/src/lib/llm/verify-key.ts`）

- 加 `local` 分支：改為對 `{LLM_BASE_URL}/models` 做可達性 GET（非金鑰驗證）。可達回 true，逾時/連不到回 false，供後台顯示地端端點健康狀態。

### 7. 前端「AI 模型」卡片（`admin/` 與租戶自助頁）

- provider 下拉多一個「地端」選項。
- 選「地端」時隱藏 key 輸入（改顯示唯讀的部署層地端端點資訊或「使用系統地端模型」字樣）。
- 後台可顯示 verify-key 的地端端點可達性。

### 8. 文件（`server/.env.example` + README）

- `.env.example` 新增地端區塊：`LLM_PROVIDER=local`、`LLM_BASE_URL`、`LLM_API_KEY`、`EMBEDDING_PROVIDER`、`EMBEDDING_BASE_URL`，附雲/地兩組範例註解。
- README「可抽換層」段補上 `local` provider 與地端部署說明。

## 測試

- `resolve-settings` 單元測試：
  - `provider=local` 時 `baseURL` 正確帶入、`apiKey=LLM_API_KEY`、`keySource=platform`。
  - local model 解析（租戶指定 vs env.LLM_MODEL）。
  - **不 fallback**：租戶 provider=local 不會因缺 key 改用雲端。
- env superRefine：`LLM_PROVIDER=local` 缺 `LLM_BASE_URL` → parse 失敗；`EMBEDDING_PROVIDER=local` 缺 `EMBEDDING_BASE_URL` → 失敗。
- embedding：`EMBEDDING_PROVIDER=local` 時 client 帶 baseURL、走 platform keySource。
- openai.provider：`getClient` 以 `apiKey|baseURL` 為鍵，不同 baseURL 得到不同 client。
- （既有雲端測試須維持綠燈，確保零回歸。）

## 推薦地端 stack（部署參考，非本次程式範圍）

| 元件 | 建議 |
| --- | --- |
| 推理引擎 | vLLM（OpenAI 相容 + tool parser 最成熟；啟 `--enable-auto-tool-choice`） |
| 對話模型 | Qwen2.5-32B-Instruct（繁中 + function-calling 平衡；GPU 夠可上 72B） |
| Router 模型 | Qwen2.5-7B 或同一顆 |
| Embedding | bge-m3 或 Qwen3-Embedding，經 vLLM/TEI 起 `/v1/embeddings` |

風險提示：地端開源模型的 **function-calling 可靠度**與**繁中能力**落差大，是整個 agent（slot-filling、送出守門皆靠 tool_use）成敗關鍵；模型與 GPU 選型是部署端的主要工作，非本次程式改動範圍。地端無 prompt caching，每輪重算 system prompt + 工具定義，延遲/GPU 負載高於雲端。

## 不在本次範圍（YAGNI）

- 租戶自帶任意地端 URL（SSRF 風險，明確排除）。
- per-tenant embedding 地端化（embedding 地端化採部署層 env 開關即可）。
- 地端模型的部署、GPU 佈建、模型微調。
- Anthropic 相容的地端格式（地端一律走 OpenAI 相容格式）。
