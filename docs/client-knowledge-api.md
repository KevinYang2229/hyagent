# Web 對話前台 知識庫問答 - API 規格

本文件只列出前台做「知識庫問答」與「知識庫報告」會用到的 15 支 API，表單、任務中心、通知等其他服務一律不列。完整清單見 [client-api.md](client-api.md)。

內容依 `main` 分支的後端程式碼與 Swagger（`/api/docs`）整理。

## 知識庫問答怎麼運作

- **沒有專用的提問 API**。使用者的問題一樣用「建立對話」（API 9）與「送出訊息」（API 10）送出，後端依問句判斷要交給哪個服務；判定為知識類問題時，會先檢索知識庫，再由 AI 根據找到的片段作答
- **前端不用帶 `formId`**。它只用來指定「若要填表，填哪一張」，跟知識庫問答無關
- **來源出處寫在回覆文字裡**，格式為「（來源：標題）」。回應沒有獨立的來源欄位
- **查無資料時**，回覆固定為「目前知識庫查無相關資料，建議換個問法或洽詢對應窗口。」（英文介面為對應英文）
- **知識庫問答不會改動表單狀態**：`status` 維持 `collecting`，`values` 不變。回應裡的 `formId` 可能是後端預選的表單代碼或空字串，知識庫情境可以忽略
- **產生報告也走同一組對話 API**。使用者說「幫我整理一份請假規定的報告」這類要一份文件、而不是一個答案的話，後端會改交給報告服務：依知識庫內容規劃大綱、逐節檢索與撰寫，彙整成可下載的報告。回應會帶 `report`，前端再用 API 14 輪詢進度、API 15 下載，詳見下方「產生報告的流程」
- **能不能用知識庫依使用者權限而定**。用 API 7、API 8 回傳的 `knowledgeEnabled` 決定是否顯示開場推薦問句

## 共通規則

| 項目 | 說明 |
|------|------|
| Base URL | 同源部署時為相對路徑；前後端分開部署時由 `VITE_API_BASE` 指定後端網域 |
| 認證 | `Authorization: Bearer <token>`。帳密登入用 `accessToken`（JWT）；Widget SSO 用 `sessionToken`（`hyas_` 開頭）。兩者同時存在時前台優先送 Session |
| 租戶 | 嵌入模式每個請求帶 `x-api-key: pk_...`（租戶公開金鑰）；未帶時落到預設租戶 |
| 成功格式 | `{ "data": ... }`；`204` 無內容 |
| 錯誤格式 | `{ "error": { "code": "NOT_FOUND", "message": "Conversation not found", "details": {} } }`。唯一例外是 SSO 換發，見 API 3 |
| Token 換發 | 任一 API 回 `401` 時，前台先用 refresh token（帳密登入）或重新向宿主取 Assertion（SSO）換發，成功後重送一次；仍失敗才導回登入頁 |
| 限流 | 每「租戶＋使用者」每 60 秒 100 次（`RATE_LIMIT_MAX`、`RATE_LIMIT_WINDOW_MS`）；登入類另有獨立上限，超過回 `429 TOO_MANY_REQUESTS` |
| 月配額 | 提問會呼叫 LLM，受租戶月配額限制，用盡回 `429`；評價不計入配額 |

**常見錯誤碼**

| HTTP | code | 情境 |
|------|------|------|
| 400 | `BAD_REQUEST` | 參數格式錯誤（例如 queryId 不是 UUID） |
| 401 | `UNAUTHORIZED` | 未帶 token、token 過期、Session 已撤銷 |
| 403 | `FORBIDDEN` | 存取他人的對話 |
| 404 | `NOT_FOUND` | 對話或回覆不存在 |
| 409 | `CONFLICT` | 同一個查詢正在執行 |
| 422 | `VALIDATION_ERROR` | 請求欄位驗證失敗，`details` 為各欄位錯誤 |
| 429 | `TOO_MANY_REQUESTS` | 超過限流或月配額 |
| 502 | `LLM_ERROR` | LLM 呼叫失敗 |

---

## 一、API 功能清單

### 1. 啟動與登入

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 1 | 帳密登入 | POST | `/api/auth/login` | 取得 access/refresh token 與使用者資料 | 登入頁送出 |
| 2 | 換發 token | POST | `/api/auth/refresh` | 以 refresh token 換新的一組 token | 任一 API 回 401 時自動呼叫 |
| 3 | SSO 換發 Session | POST | `/api/auth/sso/exchange` | 以宿主網站的 Assertion 換 HyAgent Session | Widget 嵌入時自動登入、Session 過期時 |
| 4 | 取得目前使用者 | GET | `/api/auth/me` | 還原登入狀態 | 重新整理頁面、登入後 |
| 5 | 登出 | POST | `/api/auth/logout` | 撤銷目前 Session | 使用者按登出 |

### 2. 頁面初始化

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 6 | 健康檢查 | GET | `/api/healthz` | 判斷後端是否在線 | 進入頁面 |
| 7 | Widget 外觀設定 | GET | `/api/widget/config` | 取得外觀、訪客的知識庫開關與推薦問句 | 嵌入模式載入時（登入前） |
| 8 | 登入者知識庫開場資料 | GET | `/api/knowledge/suggested-prompts` | 依本人權限覆蓋知識庫開關與推薦問句 | 登入後 |

### 3. 提問

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 9 | 建立對話並提問 | POST | `/api/conversations` | 建立對話並送出第一個問題 | 送出第一個問題、點推薦問句 |
| 10 | 追問 | POST | `/api/conversations/{id}/messages` | 在同一個對話繼續提問 | 之後的每個問題 |
| 11 | 停止生成 | POST | `/api/conversations/queries/{queryId}/stop` | 中途停止 AI 回答 | 使用者按「停止」 |

### 4. 回答評價

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 12 | 評價回答 | PUT | `/api/conversations/{id}/replies/{replyId}/feedback` | 設定讚／倒讚與原因 | 按讚或倒讚 |
| 13 | 取消評價 | DELETE | `/api/conversations/{id}/replies/{replyId}/feedback` | 移除自己的評價 | 再按一次同一個按鈕 |

評價會出現在後台「回饋」分頁，管理者可據此找出答錯或資料過時的知識庫內容。

### 5. 知識庫報告

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 14 | 報告狀態 | GET | `/api/reports/{id}` | 查詢報告產生進度與可下載格式 | 提問回應帶 `report` 後輪詢 |
| 15 | 下載報告 | GET | `/api/reports/{id}/download` | 下載報告檔案 | 報告完成後按下載 |

### 產生報告的流程

```
使用者：「幫我整理一份請假規定的報告」
  → API 9 / API 10，回應帶 report: { id, status: "queued" }
     reply：「正在依知識庫的資料產生「請假規定」的報告，完成後會在這裡提供下載連結。」
  → 每 2 秒呼叫 API 14，status 依序為 queued → outlining → composing
  → status 變成 done：依 files[] 顯示下載按鈕
  → 使用者按下載：API 15?format=pdf
```

- **觸發方式**：使用者明確要「一份報告／文件」才會觸發。只問某件事怎麼規定，仍是一般知識庫問答
- **主題不清楚時**：不會建立報告，而是回問「你想針對什麼主題產生報告？」，回應不帶 `report`
- **同一租戶一次只能產生一份**：已有報告進行中時，回覆「目前已有一份報告正在進行中，請等它完成後再試。」，回應不帶 `report`，不會回錯誤碼
- **資料來源**：預設是知識庫。若使用者有開通資料庫查詢、主題又是統計數據，報告會改查資料庫
- **報告會附各節來源**；節數上限由 `REPORT_MAX_SECTIONS` 設定
- 已產生的報告也會出現在任務中心（`GET /api/tasks` 的 `reports`），完成時會發通知；這兩支屬任務中心功能，見 [client-api.md](client-api.md)

---

## 二、API 詳細規格

### API 1. 帳密登入

```
POST /api/auth/login
```

**Headers**

- `x-api-key`（string，選填）：租戶公開金鑰；未帶時以預設租戶的帳號登入

**Request**

- `username`（string，必填）：使用者帳號
- `password`（string，必填）：使用者密碼

```json
{
  "username": "chen.mei",
  "password": "P@ssw0rd-2026"
}
```

**Response 200**

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjaGVuLm1laSJ9.c2lnbmF0dXJl",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmYW1pbHkiOiI3YTJjIn0.c2lnbmF0dXJl",
    "user": {
      "id": "chen.mei",
      "name": "陳美玲",
      "department": "人資部",
      "title": "專員",
      "email": "chen.mei@example.com"
    }
  }
}
```

**Response 401**：帳號或密碼錯誤
**Response 403**：此環境未開放帳密登入，須改用 SSO
**Response 429**：登入嘗試過多（預設每 15 分鐘 20 次）

---

### API 2. 換發 token

```
POST /api/auth/refresh
```

不需 `Authorization`。access token 預設 15 分鐘、refresh token 預設 7 天到期。

**Request**

- `refreshToken`（string，必填）：上次登入或換發取得的 refresh token。換發後舊的立即失效，請改存新的

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmYW1pbHkiOiI3YTJjIn0.c2lnbmF0dXJl"
}
```

**Response 200**

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjaGVuLm1laSJ9.bmV3c2ln",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmYW1pbHkiOiI3YTJjIn0.bmV3cmVm"
  }
}
```

**Response 401**：refresh token 無效或過期、已被撤銷，或偵測到舊 token 被重複使用（整組 token 會一併作廢）

---

### API 3. SSO 換發 Session

```
POST /api/auth/sso/exchange
```

不需 `Authorization`。租戶由 Assertion 的 `iss` 決定，`x-api-key` 不參與身分判定。

**Request**

- `assertion`（string，必填）：宿主網站簽發的 Identity Assertion（JWT）
- `embedOrigin`（string，選填）：嵌入面板的頁面 origin，由面板讀 `document.referrer` 取得；只有 HyAgent 自家面板送來時採信

```json
{
  "assertion": "eyJhbGciOiJFUzI1NiIsImtpZCI6Imhvc3QtMjAyNi0xMSJ9.eyJpc3MiOiJodHRwczovL3BvcnRhbC5leGFtcGxlLmNvbSJ9.c2ln",
  "embedOrigin": "https://portal.example.com"
}
```

**Response 201**

```json
{
  "data": {
    "sessionToken": "hyas_6f1c2e8a9b4d4f7e8c3a1b2d5e6f7a8b",
    "expiresIn": 3600,
    "user": {
      "id": "E10233",
      "name": "林志豪",
      "department": "業務部",
      "company": "範例股份有限公司"
    }
  }
}
```

**錯誤格式不同**：這支 API 的錯誤是扁平格式，以 `error` 欄位判斷：

```json
{
  "error": "TOKEN_EXPIRED",
  "message": "Assertion 已過期",
  "requestId": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
}
```

| HTTP | error | 情境 |
|------|-------|------|
| 400 | `INVALID_REQUEST` | 請求格式錯誤 |
| 401 | `MALFORMED_TOKEN`、`INVALID_SIGNATURE`、`UNKNOWN_KID`、`KEY_REVOKED`、`INVALID_ISSUER`、`INVALID_AUDIENCE`、`INVALID_CLAIMS`、`TOKEN_NOT_ACTIVE`、`TOKEN_EXPIRED`、`TOKEN_REPLAYED`、`INVALID_ALGORITHM` | Assertion 驗證失敗 |
| 403 | `TENANT_DISABLED`、`ORIGIN_NOT_ALLOWED` | 租戶停用、嵌入來源不在允許清單 |
| 404 | `TENANT_NOT_FOUND` | 找不到 `iss` 對應的租戶 |
| 413 | `ASSERTION_TOO_LARGE` | Assertion 超過大小上限 |
| 429 | `RATE_LIMITED` | 換發過於頻繁 |

---

### API 4. 取得目前使用者

```
GET /api/auth/me
```

**Response 200**

```json
{
  "data": {
    "id": "chen.mei",
    "name": "陳美玲",
    "department": "人資部",
    "title": "專員"
  }
}
```

`department` 會影響可查詢的知識庫範圍：管理者可以把特定文件只開放給某些部門。

**Response 401**：token 無效或過期

---

### API 5. 登出

```
POST /api/auth/logout
```

撤銷目前的 Session。前台會先清掉本地 token，再非同步通知後端，不等待結果。

**Response 204**：無內容
**Response 401**：未帶 token

---

### API 6. 健康檢查

```
GET /api/healthz
```

不需認證。前台只看 HTTP 狀態是否為 200。

**Response 200**

```json
{
  "status": "ok",
  "llm": { "provider": "anthropic", "model": "claude-sonnet-5-5" }
}
```

---

### API 7. Widget 外觀設定

```
GET /api/widget/config?key=pk_live_8f3a2c
```

不需登入。iframe 無法帶自訂 header，所以租戶金鑰放在 query。

**Query**

- `key`（string，必填）：租戶公開金鑰，只接受 `pk_` 開頭

**Response 200**

```json
{
  "data": {
    "appearance": {
      "assistantName": "小海",
      "primaryColor": "#0057ff",
      "theme": "light",
      "position": "br",
      "welcomeMessage": "您好，有任何公司規章或產品問題都可以問我。",
      "defaultLocale": "zh-Hant"
    },
    "knowledgeEnabled": true,
    "suggestedPrompts": [
      { "zh-Hant": "特休假可以分次請嗎？", "en": "Can annual leave be taken in parts?" },
      { "zh-Hant": "出差費用怎麼報支？", "en": "How do I claim travel expenses?" }
    ]
  }
}
```

| 欄位 | 說明 |
|------|------|
| `knowledgeEnabled` | 以訪客權限判定是否可用知識庫；登入後改用 API 8 的結果覆蓋 |
| `suggestedPrompts` | 開場推薦問句，每筆同時有繁中與英文，前台依介面語言挑一種顯示。依知識庫各來源（網站、檔案）各生成一筆，後面接管理者自訂的問句。知識庫尚未建好索引或 `knowledgeEnabled` 為 `false` 時為空陣列 |

前台在請求失敗時改用內建預設外觀，不顯示錯誤。

---

### API 8. 登入者知識庫開場資料

```
GET /api/knowledge/suggested-prompts
```

登入後呼叫。管理者可能只把知識庫開放給特定部門，API 7 用訪客身分判斷會得到 `false`，這支依本人權限重新判斷。回應帶 `Cache-Control: no-store`。

**Response 200**

```json
{
  "data": {
    "knowledgeEnabled": true,
    "suggestedPrompts": [
      { "zh-Hant": "特休假可以分次請嗎？", "en": "Can annual leave be taken in parts?" },
      { "zh-Hant": "出差費用怎麼報支？", "en": "How do I claim travel expenses?" }
    ]
  }
}
```

- 推薦問句一律取自訪客可見的公開內容，不會因為登入而出現機密文件的問句
- `knowledgeEnabled` 為 `false` 時 `suggestedPrompts` 一律為空陣列

**Response 401**：token 無效，或 token 的租戶與 `x-api-key` 的租戶不一致

---

### API 9. 建立對話並提問

```
POST /api/conversations
```

使用者送出第一個問題或點推薦問句時呼叫。點推薦問句等同把問句文字當成 `message` 送出。

**Headers**

- `x-query-id`（string，選填）：本次查詢識別碼（UUID），由前台產生；之後可用 API 11 停止這次回答。省略時就無法中途停止

**Request**

- `message`（string，必填）：使用者的問題。後端 schema 允許省略，但省略時只會建立空對話、不會回答
- `lang`（string，選填）：AI 回答語言，例如 `zh-Hant`、`en`；省略時為繁體中文
- `formId`（string，選填）：指定要填的表單，知識庫問答不需要帶

```json
{
  "message": "特休假可以分次請嗎？",
  "lang": "zh-Hant"
}
```

**Response 201**

```json
{
  "data": {
    "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
    "formId": "",
    "status": "collecting",
    "values": {},
    "reply": "可以。特休假以半日（4 小時）為最小單位，可分次申請，但須在年度結束前休畢，未休完的天數依規定折算工資。（來源：員工休假管理辦法）",
    "suggestions": ["特休未休完怎麼算？", "請特休要提前多久申請？"],
    "replyId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
  }
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | string | 對話 id，追問（API 10）與評價（API 12）時使用 |
| `reply` | string \| null | AI 的回答，Markdown 格式，可能含表格與條列；來源出處以「（來源：標題）」寫在文中 |
| `suggestions` | string[] | 建議的追問，可一鍵送出；可能為空陣列 |
| `replyId` | string | 本則回答 id，評價時使用 |
| `report` | object | 只有觸發報告時才帶：`{ "id": "d4e5f6a7-8b9c-4d0e-9f1a-2b3c4d5e6f70", "status": "queued" }`，之後用 API 14 輪詢 |
| `formId`、`status`、`values` | — | 表單用欄位，知識庫情境可忽略 |

回答太長被截斷時，`reply` 結尾會加上「（回答較長已截斷，可以縮小範圍再問一次。）」。

**Response 409**：同一個 `x-query-id` 正在執行
**Response 429**：超過限流或月配額
**Response 502**：LLM 呼叫失敗

---

### API 10. 追問

```
POST /api/conversations/{id}/messages
```

在同一個對話繼續提問。後端會參考最近的對話來理解「那」「他們」等指代，例如前一題問特休、這題問「那病假呢？」，會被改寫成完整問句再檢索。

**Path**

- `id`（string，UUID，必填）：對話 id（API 9 回傳）

**Headers**

- `x-query-id`（string，選填）：同 API 9

**Request**

- `message`（string，必填）：使用者的問題
- `lang`（string，選填）：本輪回答語言，可在對話中途切換

```json
{
  "message": "那病假呢？",
  "lang": "zh-Hant"
}
```

**Response 200**

```json
{
  "data": {
    "status": "collecting",
    "values": {},
    "reply": "病假一年內合計不超過 30 日，可以小時為單位申請；超過 3 日須附醫療證明。（來源：員工休假管理辦法）",
    "suggestions": ["病假薪資怎麼算？"],
    "replyId": "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
  }
}
```

查無資料時：

```json
{
  "data": {
    "status": "collecting",
    "values": {},
    "reply": "目前知識庫查無相關資料，建議換個問法或洽詢對應窗口。",
    "suggestions": [],
    "replyId": "c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f"
  }
}
```

**Response 403**：不是自己的對話
**Response 404**：對話不存在
**Response 409**：同一個 `x-query-id` 正在執行
**Response 429**：超過限流或月配額
**Response 502**：LLM 呼叫失敗

---

### API 11. 停止生成

```
POST /api/conversations/queries/{queryId}/stop
```

只能停止自己（同租戶、同使用者）的查詢。停止請求比查詢先到時，30 秒內開始的同一個查詢會直接中止。

**Path**

- `queryId`（string，UUID，必填）：提問時帶的 `x-query-id`

**Response 204**：無內容
**Response 400**：`queryId` 格式錯誤

---

### API 12. 評價回答

```
PUT /api/conversations/{id}/replies/{replyId}/feedback
```

同一則回答重複呼叫會覆蓋原評價。不計入月配額。

**Path**

- `id`（string，UUID，必填）：對話 id
- `replyId`（string，UUID，必填）：API 9、API 10 回傳的 `replyId`

**Request**

- `rating`（string，必填）：`up` 讚、`down` 倒讚
- `reason`（string，選填）：倒讚原因，僅 `rating=down` 可帶。`wrong` 答錯、`not_answered` 沒回答到、`outdated` 資訊過時、`inappropriate` 不恰當、`other` 其他
- `comment`（string，選填，最多 500 字）：補充說明，僅 `rating=down` 可帶

```json
{
  "rating": "down",
  "reason": "outdated",
  "comment": "特休規定今年已經改了"
}
```

**Response 200**

```json
{
  "data": {
    "rating": "down",
    "reason": "outdated",
    "comment": "特休規定今年已經改了"
  }
}
```

**Response 404**：這則回答已無法評價
**Response 422**：`rating=up` 卻帶了 `reason` 或 `comment`

---

### API 13. 取消評價

```
DELETE /api/conversations/{id}/replies/{replyId}/feedback
```

**Path**

- `id`（string，UUID，必填）：對話 id
- `replyId`（string，UUID，必填）：回答 id

**Response 204**：無內容
**Response 404**：對話不存在

---

### API 14. 報告狀態

```
GET /api/reports/{id}
```

提問回應帶 `report` 後，前端以此 API 輪詢，直到 `status` 為 `done`、`empty` 或 `failed`。

**Path**

- `id`（string，UUID，必填）：報告 id，即回應中的 `report.id`

**Response 200**（撰寫中）

```json
{
  "data": {
    "id": "d4e5f6a7-8b9c-4d0e-9f1a-2b3c4d5e6f70",
    "status": "composing",
    "topic": "請假規定",
    "doneSections": 2,
    "totalSections": 5,
    "files": []
  }
}
```

**Response 200**（完成）

```json
{
  "data": {
    "id": "d4e5f6a7-8b9c-4d0e-9f1a-2b3c4d5e6f70",
    "status": "done",
    "topic": "請假規定",
    "doneSections": 5,
    "totalSections": 5,
    "files": [
      { "format": "md", "filename": "請假規定.md" },
      { "format": "html", "filename": "請假規定.html" },
      { "format": "pdf", "filename": "請假規定.pdf" }
    ]
  }
}
```

| 欄位 | 說明 |
|------|------|
| `status` | `queued` 排隊中、`outlining` 規劃大綱、`composing` 撰寫中、`done` 完成、`empty` 知識庫查無可用資料、`failed` 失敗（`error` 帶原因） |
| `doneSections`、`totalSections` | 已完成節數與總節數，可用來顯示進度；`totalSections` 在大綱完成前不帶 |
| `files` | 本部署實際可下載的格式與檔名。前端不可寫死格式清單（pdf 需伺服器有瀏覽器才會產生），下載時的檔名直接用 `filename` |

**Response 404**：報告不存在，或不是自己的報告（一律回 404，不透露報告是否存在）。伺服器重啟後尚未完成的報告也會變成 404，前端應停止輪詢並提示使用者

---

### API 15. 下載報告

```
GET /api/reports/{id}/download?format=pdf
```

**Path**

- `id`（string，必填）：報告 id

**Query**

- `format`（string，選填）：下載格式，取 API 14 `files[].format` 的值；省略時為 `md`

**Response 200**：檔案內容（binary）

- `Content-Type` 依格式：`text/markdown; charset=utf-8`、`text/html; charset=utf-8`、`application/pdf`
- `Content-Disposition` 帶檔名

**Response 404**：報告或該格式不存在，或不是自己的報告
**Response 422**：`format` 不在本部署支援的格式內

---

## 三、實作建議

| 項目 | 建議 |
|------|------|
| 開場推薦問句 | 登入前用 API 7 的結果顯示；登入後呼叫 API 8，以它的 `knowledgeEnabled` 與 `suggestedPrompts` 覆蓋。`knowledgeEnabled` 為 `false` 時隱藏推薦問句 |
| 回答呈現 | `reply` 是 Markdown，需經過安全的 Markdown 元件呈現（前台用 `SafeMarkdown`），不要直接塞進 `innerHTML` |
| 來源出處 | 來源以「（來源：標題）」寫在回答文字中，目前沒有結構化欄位；若要做成可點的引用連結，需後端另外提供 |
| 停止生成 | 每次提問前產生新的 UUID 放進 `x-query-id`，使用者按停止時呼叫 API 11，同時 abort 原本的 fetch |
| 逾時 | 提問要等檢索與 LLM 作答，前端逾時建議設 90 秒以上 |
| 報告輪詢 | 每 2 秒呼叫 API 14，收到 `done`、`empty`、`failed` 即停止；收到 404 或連續失敗多次也要停止，避免持續消耗限流額度 |
| 報告下載 | 用 fetch 帶 token 取得 blob 再觸發下載，`<a download>` 的檔名用 API 14 的 `filename`。blob URL 沒有 header，瀏覽器不會讀 `Content-Disposition` |
| 對話延續 | 追問一律用同一個對話 id（API 10），後端才能理解指代；開新話題時再呼叫 API 9 建立新對話 |
| Token 換發 | 多個請求同時收到 401 時只換發一次，其餘等待同一個結果。refresh token 會輪替，舊的再用一次會讓整組 token 作廢 |
| 錯誤處理 | 以 `error.code` 判斷錯誤類型，不要比對 `message` 文字。SSO 換發改看扁平格式的 `error` |
| 舊欄位 | 後端仍接受 `x-user-id` header，但只是測試期遺留，實際身分一律取自 token，前端不必再送 |
