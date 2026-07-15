# 對外整合與多租戶產品化 — 異動與變數說明

把 OA Agent 從「單一示範 widget」升級為可提供給多個外部系統整合的多租戶服務。
**全程向後相容**：未帶 API Key 的舊 widget（`<script src=".../widget.js">`）落到內建的「預設租戶」，行為與改造前完全相同。

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
- **SSO handoff**：每租戶可設 `ssoSecret`，宿主簽發的使用者 token 經 `POST /api/auth/sso/exchange` 換發本系統 token（嵌入免帳密登入）。
- **每租戶 rate limit**：`server/src/middlewares/tenant-rate-limit.ts`。

### 2. 三種整合方式
- **Surface 1 — 嵌入 widget 產品化**：`client/public/widget.js` 支援 `data-key/form/locale/theme/position/user-token`，參數化 iframe URL，轉發 `oa-agent:submitted` 等事件，提供 `OAAgent.open/close/toggle` 控制 API。
  - client：`embedConfig.ts`、`api.ts`（帶 `x-api-key` + SSO 換發）、`App.tsx`（套用 locale/theme/form、送出事件）。
- **Surface 2 — 開發者 SDK**：新 workspace `@oa-agent/sdk`（`sdk/`），headless REST + widget 事件/控制橋接 + SSO。
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
| `ssoSecret` | 建租戶時由你提供 | 該租戶 SSO 驗章用的共享密鑰 |
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
  -d '{"name":"Acme","allowedOrigins":["https://acme.com"],"ssoSecret":"<選填>"}'

# 3. 對方網站嵌入（帶 pk）
# <script src="https://你的網域/widget.js" data-key="pk_..." data-form="leave-request"></script>

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
  - **設定** — 名稱、允許嵌入來源、SSO 密鑰、API Keys（產生 pk_/sk_）。
  - **Webhook** — 端點列表 / 新增 / 啟用停用 / 刪除。
  - **用量** — 對話 / 訊息 / 送出計數（唯讀）。

> `ADMIN_PASSWORD` 留空＝停用後台登入（回 403）。與機器對機器用的 `ADMIN_API_KEY` 分開，避免主控金鑰外洩到瀏覽器。
