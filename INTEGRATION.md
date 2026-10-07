# 對外整合與多租戶產品化 — 異動與變數說明

把 HyAgent 從「單一示範 widget」升級為可提供給多個外部系統整合的多租戶服務。
**全程向後相容**：未帶 API Key 的舊 widget（`<script src=".../sdk/widget.js">`）落到內建的「預設租戶」，行為與改造前完全相同。

---

## 一、異動摘要

### 1. 多租戶地基（後端核心）
- **租戶 / API Key 模型**：每個整合方＝一個租戶，配發 `pk_`（公開，可放瀏覽器）與 `sk_`（秘密，伺服器端）金鑰。
  - `server/src/modules/tenant/`（types / store / service）
- **資料隔離**：對話全流程掛 `tenantId`，跨租戶讀取一律 `404`。
  - `server/src/modules/conversation/`（store / service / controller）
- **API Key 中介層**：`x-api-key` / `Authorization: ApiKey` / `?key=pk_` → 解析租戶；未帶 key 落預設租戶。
  - `server/src/middlewares/resolve-tenant.ts`
- **動態 CORS**：放行來源＝第一方設定 ∪ 任一租戶白名單；預設租戶為 `*` 時維持全放行。
- **SSO handoff**：每租戶登記 Assertion 公鑰（最多 2 把），宿主以自家私鑰簽發的 Identity Assertion 經 `POST /api/auth/sso/exchange` 換發 HyAgent Session（嵌入免帳密登入）。HyAgent 只持有公鑰。
- **每租戶 rate limit**：`server/src/middlewares/tenant-rate-limit.ts`。

### 2. 三種整合方式
- **Surface 1 — 嵌入 widget 產品化**：`client/public/sdk/widget.js`（對外路徑 `/sdk/widget.js`）支援 `data-key/form/locale/theme/position/token-url`（`token-url` 指向宿主自家的 Identity Endpoint，widget 需要身分時才現取一張 Assertion；靜態的 `data-user-token` 已移除，見 [`docs/HANDOFF-SSO.md`](docs/HANDOFF-SSO.md)），參數化 iframe URL，轉發 `oa-agent:submitted` 等事件，提供 `OAAgent.open/close/toggle/expand/collapse` 控制 API（`expand` 會把面板置中撐大並蓋上背景遮罩），以及宿主登出時**必須**呼叫的 `OAAgent.logout()`（不經登出直接換人的站台另有 `refreshIdentity()`，見 [整合手冊](docs/HyAgent客戶端整合手冊.md) §5.3、§5.4）。
  - client：`embedConfig.ts`、`api.ts`（帶 `x-api-key` + SSO 換發）、`App.tsx`（套用 locale/theme/form、送出事件）。
- **Surface 2 — 開發者 SDK**：新 workspace `@hyagent/sdk`（`sdk/`），headless REST + widget 事件/控制橋接 + SSO。
- **Surface 3 — 表單結果 webhook 回拋**：每租戶可登記端點，送出成功後以 **HMAC 簽章 + 行內非同步投遞 + 指數退避重試** 推送 `form.submitted`。
  - `server/src/modules/webhook/`

### 租戶自帶 AI 金鑰（BYO key）

整合方可用 **sk_ 秘密金鑰**（伺服器對伺服器）自行設定 AI 供應商與金鑰：

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/tenant/llm-config` | 讀取目前設定（金鑰遮罩，只露頭 7 尾 4） |
| PUT | `/api/tenant/llm-config` | 更新設定；省略欄位=不變、`null`=清除；新金鑰存前會打該廠商 `/v1/models` 驗證 |

Body 欄位：`provider`（`anthropic`/`openai`）、`model`、`anthropicApiKey`、`openaiApiKey`。
規則：`model` 需搭配 `provider`；設定 `provider` 後該租戶所有 AI 呼叫（含意圖路由）鎖定該供應商與模型；
金鑰失效時回 502 明確錯誤，**不會** fallback 平台金鑰。pk_ 公開金鑰一律 403。

### 3. 營運面（cross-cutting）
- **管理 API**：`/api/admin/*`，受 `x-admin-key` 保護，可建租戶 / 發金鑰 / 登記 webhook / 查用量。
  - `server/src/modules/admin/`、`server/src/middlewares/require-admin.ts`
- **每租戶用量追蹤**：對話 / 訊息 / 送出計數（`server/src/modules/usage/`）。
- **API 文件**：OpenAPI 規格於 `/api/openapi.json`，Swagger UI 於 `/api/docs`。

> 基礎設施沿用既有「in-memory + 磁碟、介面可抽換」模式：租戶 / webhook / 用量 store 都可在無 DB/Redis 下運作；正式上線時再換 Prisma（持久化）與 BullMQ（webhook 佇列）。

---

## 二、新增環境變數

| 變數 | 預設 | 必填 | 說明 |
|------|------|------|------|
| `DEFAULT_TENANT_ORIGINS` | `*` | 否 | 預設租戶（未帶 API Key 的舊 widget 落點）允許嵌入的網域。`*`＝全放行（向後相容）；或逗號分隔網域收緊，如 `https://a.com,https://b.com`。 |
| `ADMIN_API_KEY` | （空） | 否 | 管理 API 的主控密鑰，**自訂**。留空＝停用管理 API（預設關閉，回 403）。啟用請填一段夠長的隨機字串，呼叫時於 header 帶 `x-admin-key: <此值>`。建議 `openssl rand -hex 32` 產生並存於部署 secret。 |

> 既有變數（`CORS_ORIGIN`、`RATE_LIMIT_*`、`REDIS_URL`、`JWT_*` 等）沿用，行為不變。完整清單見 [server/.env.example](server/.env.example)。

### 金鑰種類釐清
| 金鑰 | 誰產生 | 用途 |
|------|--------|------|
| `pk_…` / `sk_…` | 系統自動產生（建租戶 / 發金鑰時） | 租戶金鑰：解析租戶、資料隔離 |
| Assertion 公鑰 | 客戶產生金鑰對後提供公鑰，你在後台登記 | 該租戶 SSO 驗章用；私鑰留在客戶環境，我方不持有 |
| `ADMIN_API_KEY` | 你自訂（環境變數） | 系統管理者主控密鑰，凌駕所有租戶 |

---

## 三、快速啟用

```bash
# 1. 啟用管理 API
export ADMIN_API_KEY=$(openssl rand -hex 32)
npm run dev:server

# 2. 建立租戶（回傳一把公開金鑰 pk_…）
curl -X POST http://localhost:3000/api/admin/tenants \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Acme","allowedOrigins":["https://acme.com"]}'

# 2b. 登記客戶的 Assertion 公鑰（後台 UI 或內部端點；kid 由系統自公鑰算出）
curl -X POST http://localhost:3000/api/admin/tenants/<tenantId>/assertion-keys   -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json'   -d '{"publicKey":"-----BEGIN PUBLIC KEY-----
…"}'

# 3. 對方網站嵌入（帶 pk）
# <script src="https://你的網域/sdk/widget.js" data-key="pk_..." data-form="leave-request"></script>

# 4. 互動式 API 文件
open http://localhost:3000/api/docs
```

---

## 四、管理後台（admin）

獨立的 `admin/` workspace（Vite + React），以單一管理密碼登入後，可在 Web 介面設定 widget 外觀、租戶與 webhook。

```bash
export ADMIN_PASSWORD=$(openssl rand -hex 24)
npm run dev:server   # 後端 3000
npm run dev:admin    # 後台 5174
# 瀏覽器開 http://localhost:5174，以 ADMIN_PASSWORD 登入
```

- **登入**：`POST /api/admin/auth/login`（密碼比對 `ADMIN_PASSWORD`）換發 admin JWT；`require-admin` 同時接受 `x-admin-key` 或此 JWT（既有腳本不受影響）。
- **分頁**：
  - **外觀** — 主色 / 主題 / 按鈕位置 / logo / 歡迎語 / 預設語言，存於租戶，widget 載入時讀 `GET /api/widget/config` 套用（`data-*` 參數仍優先）。
  - **設定** — 名稱、允許嵌入來源、Assertion 公鑰清單（上傳 / 停用 / 撤銷，`kid` 由系統自公鑰算出）、API Keys（產生 pk_/sk_）。
  - **Webhook** — 端點列表 / 新增 / 啟用停用 / 刪除。
  - **用量** — 對話 / 訊息 / 送出計數（唯讀）。

> `ADMIN_PASSWORD` 留空＝停用後台登入（回 403）。與機器對機器用的 `ADMIN_API_KEY` 分開，避免主控金鑰外洩到瀏覽器。

---

## 自建 MCP 服務（讓 AI 呼叫外部系統）

HyAgent 的智慧代理可以呼叫我們自建的 MCP server。整體流程：

1. **寫 MCP server**：用 [`mcp/kit`](mcp/kit/README.md)（`createMcpHttpApp` + `createHyAgentVerifier`），照 README 的規範寫工具（欄位要有描述、唯讀工具標 `readOnlyHint`）。範例在 `mcp/kit/examples/rooms/`。
2. **部署**：MCP server 要能連到 HyAgent 後端的 `GET /.well-known/hyagent-mcp-jwks.json`（驗章用），HyAgent 後端要能連到 MCP server 的 `/mcp`。
3. **登記**：後台「MCP 服務」→ 新增，填 `serverId`、URL、擁有租戶（共用或某租戶專屬）、能力描述與路由關鍵字，按「測試連線」確認工具清單與讀寫判定。
4. **授權**：在租戶的權限分頁，把 `mcp:<serverId>` 授予要使用的部門或帳號（也需要 `service:agent`）。

### 身分與安全

- HyAgent 每個請求都簽一張 60 秒的 ES256 JWT：`aud` 為 `serverId`、`sub` 為使用者、`tenant` 為租戶、`scopes` 只含 `mcp:<serverId>` 相關項。MCP server 用 `callerFrom(extra)` 取得，可自行做二次權限檢查與稽核。
- 唯讀工具（`readOnlyHint: true`）AI 會直接呼叫；**其餘一律視為寫入**：AI 只能提議，使用者在確認卡片按「確認」後才由後端執行。後台可對單一工具強制確認或停用。
- **唯讀工具可能被 App 直接呼叫**：標示 `readOnlyHint: true` 的工具除了給 AI 使用，也會被前台（例如門市 App 的首頁摘要、列表、掃條碼查券）透過 `POST /api/tools/:toolId/invoke` 直接呼叫，不經 AI、也不經使用者確認。因此唯讀工具**不得有任何副作用**；權限一樣以 `mcp:<serverId>` 控管，呼叫身分同樣以簽章 JWT 帶給你的服務；這類直接呼叫不寫入 HyAgent 稽核紀錄（寫入動作照常稽核）。
- MCP server 端的 kit 會快取 JWKS 公鑰 5 分鐘，換鑰後最慢 5 分鐘生效；遇到未知 kid 會提前重抓，但最多每 30 秒一次。
- 後端未設 `MCP_SIGNING_KEY` 時，MCP 功能整體停用。

### 前台整合（自製 UI）

對話 API 的回應若帶 `pendingAction`（`{ id, summary: { title, fields[] }, expiresAt }`），請畫成確認卡片：

- 確認：`POST /api/conversations/:id/actions/:actionId/confirm` → `data.reply`、`data.actionOk`
- 取消：`POST /api/conversations/:id/actions/:actionId/cancel`
- `409 ACTION_EXPIRED`：已逾時（10 分鐘），請使用者重新提出；`409 ACTION_NOT_FOUND`：已處理過；`403`：權限已撤銷。
- 沒有畫卡片的舊前台，使用者打「確認」也能執行（打字備援）。

### 回傳表格（顯示提示）

工具可在結果的 `_meta["hyagent/display"]` 宣告表格，HyAgent 會把資料原樣畫成表格（不經 AI 轉述），
AI 只負責說明重點：

```jsonc
{ "type": "table", "title": "商品庫存", "rows": "items",
  "columns": [
    { "key": "name", "label": "商品名稱", "image": "image" },
    { "key": "stock", "label": "目前庫存", "unit": "個" },
    { "key": "suggested", "label": "建議補貨", "unit": "個", "format": "delta" },
    { "key": "status", "label": "狀態", "badge": { "庫存偏低": "danger", "正常": "success" } } ] }
```

限制：最多 50 列、12 欄；儲存格只接受字串或數字；色調只有 success／warning／danger／neutral；圖片須為 http(s) 網址。
對話 API 的回應會在 `blocks` 帶出這些表格。

### 可編輯的確認卡片

寫入工具的確認卡片由輸入 schema 自動產生：`readOnly` 不可改、數字帶 `minimum`／`maximum`、
`format: "date"` 為日期（後端會驗證日期格式）、`enum` 為下拉（`x-enumLabels` 顯示文字）、
物件陣列為可勾選表格（項目需有唯讀欄位辨識列）；延伸關鍵字 `x-unit`、`x-image`、`x-hidden`、`x-display: "html"`。

前端確認時可帶修改後的完整參數：`POST /api/conversations/:id/actions/:actionId/confirm`，body `{ input }`。
後端的處理規則：

- 修改後的 `input` 不可新增原始參數沒有的鍵；前端沒帶的鍵，會先以原始參數補齊再驗證。
- `readOnly`、`x-hidden`、`x-display: "html"`、被 `x-image` 指向的圖片來源欄位必須與原始值相同（陣列可刪列，不可新增列或改唯讀值）。
- `x-hidden` 欄位（如商品編號）使用者看不到，寫入工具必須自行驗證它與顯示欄位（名稱等）一致，不能只信任顯示值。
- 其餘欄位依 schema 驗證；不合法回 `422 ACTION_INPUT_INVALID`，動作保留，可修正後重送。
- 帶修改確認時若工具暫時無法使用，回 `503 TOOL_UNAVAILABLE`，動作同樣保留，可稍後重試。

不經 AI 直接提議：`POST /api/conversations/:id/actions/propose`，body `{ toolId, input }`：

- 只接受對 AI 開放（`agentExposed`）的寫入工具，否則 `404 TOOL_NOT_FOUND`。
- 該工具不是寫入工具回 `422 NOT_A_WRITE_TOOL`。

### 影像辨識

`POST /api/vision/analyze`（multipart：`image` 為 jpeg／png／webp ≤ 5MB、`mode` 為 `shelf` 或 `coupon`）：

- `shelf`：回傳 `findings`（名稱、商品編號、狀態、庫存、建議補貨量 `suggestedQty`、到期日、備註 `note`、框選座標）、`counts`，
  以及可直接送到 `propose` 的 `replenishment`。框選座標為 0–1 的相對值，超出範圍會被夾回。
  商品資料每 30 筆為一批查詢；每張照片最多保留 50 筆辨識結果，補貨提議最多 30 項。
- `coupon`：讀出券號後查券，回傳 `extracted`、`result` 與表格 `block`；讀不到券號時 `message` 提示改用掃條碼。

查詢門市資料用的 MCP serverId 由 `VISION_STORE_SERVER_ID` 指定（預設 `store-demo`）。
Demo 前可用 `server/scripts/vision-eval.ts` 以實際照片檢視辨識效果（會呼叫真實 LLM，產生費用）。
