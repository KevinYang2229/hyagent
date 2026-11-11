# Web 對話前台（client）- API 規格

本文件列出 `client/` 實際呼叫的 32 支後端 API，內容依 `main` 分支的後端程式碼與 Swagger（`/api/docs`）整理。前台呼叫入口集中在 `client/src/api.ts`，Widget 外觀設定在 `client/src/embedConfig.ts`。

## 共通規則

| 項目 | 說明 |
|------|------|
| Base URL | 同源部署時為相對路徑；前後端分開部署時由 `VITE_API_BASE` 指定後端網域 |
| 認證 | `Authorization: Bearer <token>`。帳密登入用 `accessToken`（JWT）；Widget SSO 與訪客用 `sessionToken`（`hyas_` 開頭）。兩者同時存在時前台優先送 Session |
| 租戶 | 嵌入模式每個請求帶 `x-api-key: pk_...`（租戶公開金鑰）；未帶時落到預設租戶 |
| 成功格式 | `{ "data": ... }`；`204` 無內容 |
| 錯誤格式 | `{ "error": { "code": "NOT_FOUND", "message": "Conversation not found", "details": {} } }`。唯一例外是 SSO 換發，見 API 3 |
| Token 換發 | 任一 API 回 `401` 時，前台先用 refresh token（帳密登入）或重新向宿主取 Assertion（SSO）換發，成功後重送一次；仍失敗才導回登入頁 |
| 限流 | 一般 API 每「租戶＋使用者」每 60 秒 100 次（`RATE_LIMIT_MAX`、`RATE_LIMIT_WINDOW_MS`）；登入類另有獨立上限，超過回 `429 TOO_MANY_REQUESTS` |
| 月配額 | `/api/conversations/*` 會呼叫 LLM，另受租戶月配額限制，用盡回 `429` |

**常見錯誤碼**

| HTTP | code | 情境 |
|------|------|------|
| 400 | `BAD_REQUEST` | 參數格式錯誤（例如 queryId 不是 UUID） |
| 401 | `UNAUTHORIZED` | 未帶 token、token 過期、Session 已撤銷 |
| 403 | `FORBIDDEN` | 存取他人的對話、無權使用該表單或服務 |
| 404 | `NOT_FOUND` | 對話、附件、報告、表單不存在 |
| 409 | `CONFLICT` 等 | 狀態不允許此操作（例如已送出的任務再送一次） |
| 422 | `VALIDATION_ERROR` | 請求欄位驗證失敗，`details` 為各欄位錯誤 |
| 422 | `UNPROCESSABLE_ENTITY` | 業務驗證失敗（例如表單必填未完成） |
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
| 4 | 取得目前使用者 | GET | `/api/auth/me` | 還原登入狀態、顯示申請人資料 | 重新整理頁面、登入後 |
| 5 | 登出 | POST | `/api/auth/logout` | 撤銷目前 Session | 使用者按登出 |

### 2. 頁面初始化

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 6 | 健康檢查 | GET | `/api/healthz` | 判斷後端是否在線 | 進入頁面 |
| 7 | Widget 外觀設定 | GET | `/api/widget/config` | 取得租戶外觀、知識庫開關與訪客推薦問句 | 嵌入模式載入時 |
| 8 | 登入者知識庫開場資料 | GET | `/api/knowledge/suggested-prompts` | 依本人權限覆蓋知識庫開關與推薦問句 | 登入後 |
| 9 | 我的技能 | GET | `/api/skills` | 顯示本人角色與可用 Agent Skill | 開啟「我的技能」 |
| 10 | 可辦理表單清單 | GET | `/api/forms` | 表單選單與開場範例語句 | 登入後 |
| 11 | 表單定義 | GET | `/api/forms/{formId}` | 取得欄位、驗證規則等完整定義，用來畫表單 | 對話進入某張表單時 |
| 12 | 假別剩餘時數 | GET | `/api/leave/balances` | 顯示「今年度剩餘 N 小時」 | 請假表單顯示時 |

### 3. 對話

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 13 | 建立對話 | POST | `/api/conversations` | 建立對話並送出第一句話 | 使用者送出第一則訊息 |
| 14 | 送出訊息 | POST | `/api/conversations/{id}/messages` | 在既有對話送出一則訊息 | 之後的每則訊息 |
| 15 | 停止生成 | POST | `/api/conversations/queries/{queryId}/stop` | 中途停止 AI 回覆 | 使用者按「停止」 |
| 16 | 取得對話狀態 | GET | `/api/conversations/{id}` | 取目前狀態、欄位值與送出結果 | 輪詢簽核進度、還原對話 |
| 17 | 取消對話 | POST | `/api/conversations/{id}/cancel` | 放棄目前表單 | 使用者按取消 |

### 4. 表單確認與寫入動作

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 18 | 手動修改欄位 | PATCH | `/api/conversations/{id}/fields` | 在確認畫面直接改欄位值，不經 AI | 確認畫面編輯欄位 |
| 19 | 確認送出表單 | POST | `/api/conversations/{id}/submit` | 送出表單到 OA | 確認畫面按「送出」 |
| 20 | 確認寫入動作 | POST | `/api/conversations/{id}/actions/{actionId}/confirm` | 執行 AI 提議的寫入動作 | 確認卡片按「確認」 |
| 21 | 取消寫入動作 | POST | `/api/conversations/{id}/actions/{actionId}/cancel` | 放棄 AI 提議的寫入動作 | 確認卡片按「取消」 |

### 5. 附件

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 22 | 上傳附件 | POST | `/api/conversations/{id}/attachments` | 上傳表單附件 | 選擇檔案後 |
| 23 | 刪除附件 | DELETE | `/api/conversations/{id}/attachments/{attachmentId}` | 移除已上傳附件 | 按附件的刪除 |

### 6. 回覆評價

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 24 | 評價 AI 回覆 | PUT | `/api/conversations/{id}/replies/{replyId}/feedback` | 設定讚／倒讚與原因 | 按讚或倒讚 |
| 25 | 取消評價 | DELETE | `/api/conversations/{id}/replies/{replyId}/feedback` | 移除自己的評價 | 再按一次同一個按鈕 |

### 7. 任務中心、通知與報告

| # | API 名稱 | Method | Endpoint | 用途 | 時機 |
|---|---------|--------|----------|------|------|
| 26 | 我的任務 | GET | `/api/tasks` | 未完成表單、已送申請、報告清單 | 開啟任務中心 |
| 27 | 還原任務 | GET | `/api/tasks/{id}` | 取回未完成表單的狀態以繼續填寫 | 任務中心點「繼續」 |
| 28 | 取消任務 | POST | `/api/tasks/{id}/cancel` | 取消未完成表單 | 任務中心點「取消」 |
| 29 | 通知清單 | GET | `/api/notifications` | 通知中心清單與未讀數 | 開啟通知中心、定期刷新 |
| 30 | 標記通知已讀 | POST | `/api/notifications/read` | 將通知標為已讀 | 點開通知 |
| 31 | 報告狀態 | GET | `/api/reports/{id}` | 查詢報告產生進度與可下載格式 | AI 啟動報告後輪詢 |
| 32 | 下載報告 | GET | `/api/reports/{id}/download` | 下載報告檔案 | 按下載按鈕 |

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
      "region": "台北",
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
    "title": "專員",
    "region": "台北"
  }
}
```

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
      "launcherSize": 56,
      "welcomeMessage": "您好，我可以協助您請假、查詢規章與產生報告。",
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

- `knowledgeEnabled` 依訪客權限判定；登入後改用 API 8 的結果覆蓋
- 前台在請求失敗時改用內建預設外觀，不顯示錯誤

---

### API 8. 登入者知識庫開場資料

```
GET /api/knowledge/suggested-prompts
```

依本人權限判斷能否使用知識庫，用來覆蓋 API 7 的訪客判定。回應帶 `Cache-Control: no-store`。

**Response 200**

```json
{
  "data": {
    "knowledgeEnabled": true,
    "suggestedPrompts": [
      { "zh-Hant": "特休假可以分次請嗎？", "en": "Can annual leave be taken in parts?" }
    ]
  }
}
```

- `knowledgeEnabled` 為 `false` 時 `suggestedPrompts` 一律為空陣列

**Response 401**：token 無效，或 token 的租戶與 `x-api-key` 的租戶不一致

---

### API 9. 我的技能

```
GET /api/skills
```

**Response 200**

```json
{
  "data": {
    "roles": [
      { "id": "hr-staff", "name": "人資專員", "description": "可辦理請假與查詢人事規章" }
    ],
    "skills": [
      { "id": "leave-request", "label": "請假申請", "description": "以對話填寫並送出請假單" },
      { "id": "knowledge", "label": "知識庫問答", "description": "查詢公司規章與文件" }
    ]
  }
}
```

**Response 401**：token 無效

---

### API 10. 可辦理表單清單

```
GET /api/forms
```

只回傳呼叫者有權限（`form:<formId>` scope）的表單。

**Response 200**

```json
{
  "data": [
    {
      "formId": "leave-request",
      "title": "請假申請",
      "description": "以對話方式填寫並送出請假單",
      "examples": ["我下週一想請特休一天", "明天下午請病假"]
    }
  ]
}
```

---

### API 11. 表單定義

```
GET /api/forms/{formId}
```

**Path**

- `formId`（string，必填）：表單代碼，見 API 10

**Response 200**

回傳完整 Definition（型別見 `shared/src/index.ts`）。以下僅列主要欄位：

```json
{
  "data": {
    "formId": "leave-request",
    "data": {
      "type": "object",
      "title": "請假申請",
      "properties": {
        "leaveType": { "type": "string", "enum": ["annual", "sick", "personal"] },
        "startDate": { "type": "string", "format": "date" },
        "hours": { "type": "number", "minimum": 0.5 }
      }
    },
    "field": {
      "leaveType": {
        "component": "Select",
        "label": "假別",
        "options": [
          { "value": "annual", "label": "特休假" },
          { "value": "sick", "label": "病假" },
          { "value": "personal", "label": "事假" }
        ]
      },
      "startDate": { "component": "DatePicker", "label": "開始日期" },
      "hours": { "component": "Number", "label": "時數" }
    },
    "validation": { "required": ["leaveType", "startDate", "hours"] },
    "agent": { "intent": "請假", "description": "以對話方式填寫並送出請假單" }
  }
}
```

**Response 404**：表單不存在

---

### API 12. 假別剩餘時數

```
GET /api/leave/balances
```

僅限預設租戶、以帳密登入的內部帳號。

**Response 200**

```json
{
  "data": [
    { "leaveType": "annual", "remainingHours": 56 },
    { "leaveType": "sick", "remainingHours": 240 }
  ]
}
```

**Response 403**：非內部帳號（例如 SSO 或訪客）

---

### API 13. 建立對話

```
POST /api/conversations
```

**Headers**

- `x-query-id`（string，選填）：本次查詢識別碼（UUID），由前台產生；之後可用 API 15 停止這次 AI 回覆。省略時就無法中途停止

**Request**

- `message`（string，選填）：使用者的第一句話；省略時只建立空對話
- `formId`（string，選填）：直接指定要辦理的表單（見 API 10）；省略時由 AI 依第一句話判斷
- `lang`（string，選填）：AI 回覆語言，例如 `zh-Hant`、`en`；省略時為繁體中文

```json
{
  "message": "我下週一想請特休一天",
  "lang": "zh-Hant"
}
```

**Response 201**

```json
{
  "data": {
    "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
    "formId": "leave-request",
    "status": "collecting",
    "values": {
      "leaveType": "annual",
      "startDate": "2026-11-16",
      "hours": 8
    },
    "reply": "好的，已幫您填入 11/16（一）特休 8 小時。請問請假事由是？",
    "suggestions": ["家庭因素", "個人休息"],
    "replyId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
  }
}
```

回應欄位（與 API 14 共用，以下稱 TurnData）：

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | string | 對話 id，之後的 API 都用它 |
| `status` | string | `collecting` 蒐集中、`confirming` 待確認、`submitting` 送出中、`submitted` 已送出、`cancelled` 已取消、`failed` 送出失敗 |
| `values` | object | 目前已填的欄位值 |
| `reply` | string \| null | AI 回覆文字 |
| `suggestions` | string[] | 建議回覆，可一鍵送出；可能為空陣列 |
| `replyId` | string | 本則回覆 id，評價（API 24）時使用；沒有回覆文字時不帶 |
| `report` | object | 本回合啟動的報告 `{ id, status: "queued" }`，之後用 API 31 輪詢 |
| `pendingAction` | object | AI 提議、等使用者確認的寫入動作，用來畫確認卡片（見 API 20） |
| `blocks` | array | 畫面區塊，目前只有表格（`type: "table"`） |
| `submission` | object | 送出結果，含 `oaRequestId`、`status`、`approvals` 簽核進度 |

**Response 403**：無權使用指定的表單
**Response 409**：同一個 `x-query-id` 正在執行
**Response 429**：超過限流或月配額
**Response 502**：LLM 呼叫失敗

---

### API 14. 送出訊息

```
POST /api/conversations/{id}/messages
```

**Path**

- `id`（string，UUID，必填）：對話 id

**Headers**

- `x-query-id`（string，選填）：同 API 13

**Request**

- `message`（string，必填）：使用者訊息
- `lang`（string，選填）：本輪 AI 回覆語言，可在對話中途切換

```json
{
  "message": "家庭因素",
  "lang": "zh-Hant"
}
```

**Response 200**：TurnData（欄位見 API 13）

```json
{
  "data": {
    "status": "confirming",
    "values": {
      "leaveType": "annual",
      "startDate": "2026-11-16",
      "hours": 8,
      "reason": "家庭因素"
    },
    "reply": "資料已齊全，請確認後送出。",
    "suggestions": ["確認送出"],
    "replyId": "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
  }
}
```

AI 查出表格資料時會帶 `blocks`：

```json
{
  "data": {
    "status": "collecting",
    "values": {},
    "reply": "以下是本月門市銷售前三名。",
    "suggestions": [],
    "replyId": "c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f",
    "blocks": [
      {
        "type": "table",
        "title": "11 月門市銷售",
        "columns": [
          { "key": "store", "label": "門市" },
          { "key": "sales", "label": "銷售額", "unit": "元" }
        ],
        "rows": [
          { "store": "信義店", "sales": 1280000 },
          { "store": "板橋店", "sales": 965000 }
        ]
      }
    ]
  }
}
```

**Response 403**：不是自己的對話
**Response 404**：對話不存在
**Response 409**：同一個 `x-query-id` 正在執行
**Response 429**：超過限流或月配額
**Response 502**：LLM 呼叫失敗

---

### API 15. 停止生成

```
POST /api/conversations/queries/{queryId}/stop
```

只能停止自己（同租戶、同使用者）的查詢。停止請求比查詢先到時，30 秒內開始的同一個查詢會直接中止。

**Path**

- `queryId`（string，UUID，必填）：送訊息時帶的 `x-query-id`

**Response 204**：無內容
**Response 400**：`queryId` 格式錯誤

---

### API 16. 取得對話狀態

```
GET /api/conversations/{id}
```

**Path**

- `id`（string，UUID，必填）：對話 id

**Response 200**

```json
{
  "data": {
    "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
    "formId": "leave-request",
    "status": "submitted",
    "values": {
      "leaveType": "annual",
      "startDate": "2026-11-16",
      "hours": 8,
      "reason": "家庭因素"
    },
    "submission": {
      "oaRequestId": "LV20261111001",
      "status": "pending",
      "submittedAt": "2026-11-11T10:24:00+08:00",
      "approvals": [
        { "name": "直屬主管", "type": "manager", "status": "approved" },
        { "name": "人資", "type": "hr", "status": "current" }
      ]
    }
  }
}
```

**Response 403**：不是自己的對話
**Response 404**：對話不存在

---

### API 17. 取消對話

```
POST /api/conversations/{id}/cancel
```

**Path**

- `id`（string，UUID，必填）：對話 id

**Response 200**

```json
{
  "data": {
    "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
    "status": "cancelled"
  }
}
```

**Response 403**：不是自己的對話
**Response 404**：對話不存在

---

### API 18. 手動修改欄位

```
PATCH /api/conversations/{id}/fields
```

確認畫面直接改欄位值，不經 AI。每個欄位各自驗證，部分成功也會回 200。

**Path**

- `id`（string，UUID，必填）：對話 id

**Request**

- `fields`（object，必填）：key 為欄位代碼、value 為欄位值，至少一個；value 為空值表示清除該欄

```json
{
  "fields": {
    "hours": 4,
    "unknownField": "x"
  }
}
```

**Response 200**：TurnData 加上套用結果

```json
{
  "data": {
    "status": "confirming",
    "values": {
      "leaveType": "annual",
      "startDate": "2026-11-16",
      "hours": 4,
      "reason": "家庭因素"
    },
    "reply": null,
    "applied": ["hours"],
    "rejected": [
      { "field": "unknownField", "message": "未知欄位：unknownField" }
    ]
  }
}
```

**Response 409**：任務狀態已不允許修改（例如已送出）
**Response 422**：`fields` 為空物件

---

### API 19. 確認送出表單

```
POST /api/conversations/{id}/submit
```

不經 AI，直接把目前欄位值送到 OA。

**Path**

- `id`（string，UUID，必填）：對話 id

**Response 200**：TurnData，含 `submission`

```json
{
  "data": {
    "status": "submitted",
    "values": {
      "leaveType": "annual",
      "startDate": "2026-11-16",
      "hours": 4,
      "reason": "家庭因素"
    },
    "reply": "已送出請假單，單號 LV20261111001。",
    "suggestions": [],
    "submission": {
      "oaRequestId": "LV20261111001",
      "status": "pending",
      "submittedAt": "2026-11-11T10:24:00+08:00"
    }
  }
}
```

**Response 409**：任務狀態不允許送出，或此任務已有送出紀錄（避免重複送出）
**Response 422**：表單尚有欄位未完成，`details` 列出各欄位問題

---

### API 20. 確認寫入動作

```
POST /api/conversations/{id}/actions/{actionId}/confirm
```

AI 只能「提議」寫入動作，回在 TurnData 的 `pendingAction`，要使用者按確認才會執行，這段不經 AI。`pendingAction` 範例：

```json
{
  "id": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
  "summary": {
    "title": "調整庫存",
    "fields": [
      { "label": "商品", "value": "經典白 T 恤 M" },
      { "label": "調整數量", "value": "+20" }
    ]
  },
  "expiresAt": "2026-11-11T10:39:00+08:00"
}
```

**Path**

- `id`（string，UUID，必填）：對話 id
- `actionId`（string，UUID，必填）：`pendingAction.id`

**Request**

- `input`（object，選填）：使用者在確認卡片上修改後的完整參數；省略時照原參數執行

```json
{
  "input": { "sku": "TS-WHT-M", "delta": 15 }
}
```

**Response 200**：TurnData 加上 `actionOk`

```json
{
  "data": {
    "status": "collecting",
    "values": {},
    "reply": "已將經典白 T 恤 M 的庫存增加 15 件。",
    "suggestions": [],
    "actionOk": true
  }
}
```

**Response 403**：無權執行此動作
**Response 409**：`ACTION_NOT_FOUND` 動作不存在或已處理過、`ACTION_EXPIRED` 動作已逾時
**Response 422**：`ACTION_INPUT_INVALID` 修改後的參數不符合規則
**Response 503**：`TOOL_UNAVAILABLE` 相關服務暫時無法使用

---

### API 21. 取消寫入動作

```
POST /api/conversations/{id}/actions/{actionId}/cancel
```

**Path**

- `id`（string，UUID，必填）：對話 id
- `actionId`（string，UUID，必填）：`pendingAction.id`

**Response 200**：TurnData

```json
{
  "data": {
    "status": "collecting",
    "values": {},
    "reply": "已取消，這個動作不會執行。",
    "suggestions": []
  }
}
```

**Response 409**：`ACTION_NOT_FOUND` 動作不存在或已處理過

---

### API 22. 上傳附件

```
POST /api/conversations/{id}/attachments
Content-Type: multipart/form-data
```

**Path**

- `id`（string，UUID，必填）：對話 id

**Form fields**

- `file`（binary，必填）：單檔上限 10 MB；接受 PDF、JPEG/PNG/GIF/WebP、Word、Excel

**Response 201**

```json
{
  "data": {
    "id": "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
    "name": "診斷證明.pdf",
    "mime": "application/pdf",
    "size": 284512
  }
}
```

前台把回傳的 metadata 加進表單的 `attachments` 欄位值。

**Response 422**：缺少 `file` 欄位、格式不支援或超過大小上限

---

### API 23. 刪除附件

```
DELETE /api/conversations/{id}/attachments/{attachmentId}
```

**Path**

- `id`（string，UUID，必填）：對話 id
- `attachmentId`（string，UUID，必填）：附件 id（API 22 回傳）

**Response 200**

```json
{
  "data": { "id": "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" }
}
```

**Response 404**：附件不存在

---

### API 24. 評價 AI 回覆

```
PUT /api/conversations/{id}/replies/{replyId}/feedback
```

同一則回覆重複呼叫會覆蓋原評價。不受月配額限制。

**Path**

- `id`（string，UUID，必填）：對話 id
- `replyId`（string，UUID，必填）：TurnData 的 `replyId`

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

**Response 404**：這則回覆已無法評價
**Response 422**：`rating=up` 卻帶了 `reason` 或 `comment`

---

### API 25. 取消評價

```
DELETE /api/conversations/{id}/replies/{replyId}/feedback
```

**Path**

- `id`（string，UUID，必填）：對話 id
- `replyId`（string，UUID，必填）：回覆 id

**Response 204**：無內容
**Response 404**：對話不存在

---

### API 26. 我的任務

```
GET /api/tasks
```

清單只含 metadata，不帶表單值或 AI 對話逐字稿。

**Response 200**

```json
{
  "data": {
    "drafts": [
      {
        "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
        "formId": "leave-request",
        "title": "請假申請",
        "status": "confirming",
        "updatedAt": "2026-11-11T09:58:00+08:00",
        "canResume": true,
        "canCancel": true
      }
    ],
    "submissions": [
      {
        "oaRequestId": "LV20261105003",
        "formId": "leave-request",
        "title": "請假申請",
        "submittedAt": "2026-11-05T14:12:00+08:00",
        "conversationId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
      }
    ],
    "reports": [
      {
        "id": "e5f6a7b8-9c0d-4e1f-8a2b-3c4d5e6f7a81",
        "title": "第三季門市營運分析",
        "createdAt": "2026-11-10T16:40:00+08:00"
      }
    ]
  }
}
```

**Response 401**：token 無效

---

### API 27. 還原任務

```
GET /api/tasks/{id}
```

**Path**

- `id`（string，UUID，必填）：任務 id，即對話 id（見 API 26 的 `drafts[].id`）

**Response 200**：與 API 16 相同

```json
{
  "data": {
    "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
    "formId": "leave-request",
    "status": "confirming",
    "values": {
      "leaveType": "annual",
      "startDate": "2026-11-16",
      "hours": 8
    }
  }
}
```

**Response 403**：不是自己的任務
**Response 404**：任務不存在

---

### API 28. 取消任務

```
POST /api/tasks/{id}/cancel
```

只有 `collecting`、`confirming`、`failed` 狀態可以取消。

**Path**

- `id`（string，UUID，必填）：任務 id

**Response 200**

```json
{
  "data": {
    "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40",
    "status": "cancelled"
  }
}
```

**Response 403**：不是自己的任務
**Response 404**：任務不存在
**Response 409**：目前任務狀態無法取消（例如已送出）

---

### API 29. 通知清單

```
GET /api/notifications
```

**Response 200**

```json
{
  "data": {
    "items": [
      {
        "id": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
        "kind": "report_done",
        "title": "「第三季門市營運分析」報告已完成",
        "createdAt": "2026-11-10T16:52:00+08:00",
        "read": false,
        "target": { "category": "reports", "id": "e5f6a7b8-9c0d-4e1f-8a2b-3c4d5e6f7a81" }
      },
      {
        "id": "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
        "kind": "confirming",
        "title": "請假申請待您確認送出",
        "createdAt": "2026-11-11T09:58:00+08:00",
        "read": true,
        "target": { "category": "drafts", "id": "3f6c8a2e-1b4d-4e7a-9c5f-2d8e7b6a1c40" }
      }
    ],
    "unreadCount": 1
  }
}
```

- `kind`：`draft` 未完成表單、`confirming` 待確認送出、`submission_failed` 送出失敗、`submitted` 已送出、`report_done` 報告完成、`report_failed` 報告失敗
- `target.category` 對應 API 26 的 `drafts`、`submissions`、`reports`，點通知時用來切到任務中心的對應分類

**Response 401**：token 無效

---

### API 30. 標記通知已讀

```
POST /api/notifications/read
```

**Request**

- `ids`（string[]，必填，1–100 筆）：通知 id（64 字元的十六進位字串），見 API 29

```json
{
  "ids": ["4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a"]
}
```

**Response 200**

```json
{
  "data": { "ok": true }
}
```

**Response 404**：通知不存在或已失效
**Response 422**：`ids` 為空、超過 100 筆或格式錯誤

---

### API 31. 報告狀態

```
GET /api/reports/{id}
```

TurnData 帶 `report` 後，前台以此 API 輪詢，直到 `status` 為 `done`、`empty` 或 `failed`。

**Path**

- `id`（string，必填）：報告 id

**Response 200**

```json
{
  "data": {
    "id": "e5f6a7b8-9c0d-4e1f-8a2b-3c4d5e6f7a81",
    "status": "done",
    "topic": "第三季門市營運分析",
    "doneSections": 5,
    "totalSections": 5,
    "files": [
      { "format": "md", "filename": "第三季門市營運分析.md" },
      { "format": "html", "filename": "第三季門市營運分析.html" },
      { "format": "pdf", "filename": "第三季門市營運分析.pdf" }
    ]
  }
}
```

- `status`：`queued` 排隊中、`outlining` 規劃大綱、`composing` 撰寫中、`done` 完成、`empty` 查無資料、`failed` 失敗（`error` 帶原因）
- `files` 是本部署實際可下載的格式；前台不可寫死格式清單，下載時的檔名直接用 `filename`

**Response 404**：報告不存在，或不是自己的報告（一律回 404，不透露報告是否存在）

---

### API 32. 下載報告

```
GET /api/reports/{id}/download?format=pdf
```

**Path**

- `id`（string，必填）：報告 id

**Query**

- `format`（string，選填）：下載格式，取 API 31 `files[].format` 的值；省略時為 `md`

**Response 200**：檔案內容（binary）

- `Content-Type` 依格式：`text/markdown; charset=utf-8`、`text/html; charset=utf-8`、`application/pdf`
- `Content-Disposition` 帶檔名

**Response 404**：報告或該格式不存在，或不是自己的報告
**Response 422**：`format` 不在本部署支援的格式內

---

## 三、實作建議

| 項目 | 建議 |
|------|------|
| Token 換發 | 多個請求同時收到 401 時只換發一次，其餘等待同一個結果（前台以 `navigator.locks` 跨分頁共用）。refresh token 會輪替，舊的再用一次會讓整組 token 作廢 |
| 停止生成 | 每次送訊息前產生新的 UUID 放進 `x-query-id`，使用者按停止時呼叫 API 15；同時 abort 原本的 fetch |
| 對話逾時 | 建立對話與送訊息會等 LLM 回覆，前端逾時建議設 90 秒以上 |
| 重複送出 | API 19 已在後端擋重複送出（409）；前端仍應在送出期間停用按鈕 |
| 寫入動作 | `pendingAction` 有 `expiresAt`，過期後確認會回 `409 ACTION_EXPIRED`，前端可提示使用者重新提出 |
| 報告輪詢 | 以固定間隔（例如 2–3 秒）輪詢 API 31，收到 `done`、`empty`、`failed` 即停止 |
| 錯誤處理 | 以 `error.code` 判斷錯誤類型，不要比對 `message` 文字。SSO 換發改看扁平格式的 `error` |
| 快取 | 任務、通知、技能、知識庫開場資料的回應都帶 `Cache-Control: no-store`，前端不要另外快取 |
| 舊欄位 | 後端仍接受 `x-user-id` header，但只是測試期遺留，實際身分一律取自 token，前端不必再送 |
