# 管理後台（Admin Backend）設計

日期：2026-06-16
狀態：已通過設計審核，待 spec 審核

> **後續變更**：SSO 已於其後改為非對稱的 Identity Assertion——本文提到的租戶「SSO 密鑰」（`ssoSecret`）欄位與其輸入框已移除，改為 **Assertion 公鑰清單**（上傳／停用／撤銷，`kid` 由公鑰算出）。現行契約見 [HANDOFF-SSO.md](../../HANDOFF-SSO.md)。本文其餘設計仍然有效。

## 目標

在 oa-agent monorepo 新增一個獨立的管理後台，提供管理者透過 Web 介面設定：

1. **Widget 外觀**（依租戶套用）
2. **租戶設定**（名稱、允許來源、SSO 密鑰、API Keys）
3. **Webhook 設定**（端點 CRUD、啟用/停用）

進入後台前需先通過**登入頁面**驗證。

## 現況與缺口

- 後端已有完整管理 REST API（`server/src/modules/admin/`），以 `x-admin-key`（`ADMIN_API_KEY`）保護，提供：建立/查詢租戶、發 API Key、登記/列出/刪除 webhook、查用量。
- `client/` 是給終端使用者的**嵌入式 widget**（對話填表），其 `LoginView.tsx` 是「員工帳密登入」，與本案的「後台管理員」無關。
- **缺口 1**：`Tenant` 模型沒有任何外觀（appearance）欄位；widget 外觀目前只靠 `widget.js` 的 `data-theme/position` query 參數即時帶入，沒有「存後端、依租戶套用」的能力。
- **缺口 2**：管理驗證只有靜態 `x-admin-key` header，沒有登入頁可用的 token 換發流程。

## 決策（已與使用者確認）

| 主題 | 決定 |
|------|------|
| 後台程式碼位置 | 新增獨立 `admin/` workspace（Vite + React + TS） |
| 後台登入機制 | 單一管理密碼 → 換發 admin token（MVP） |
| Widget 外觀範圍 | 存後端、依租戶套用（擴充 tenant 模型） |

## 架構總覽

```
oa-agent/
├─ admin/        ← 新增：管理後台 SPA（Vite + React + TS）
├─ server/       ← 擴充：admin 登入、外觀欄位、widget config 公開端點
├─ client/       （不動：嵌入式 widget，僅讀 /widget/config 套用外觀）
├─ ui/           （沿用：設計系統元件）
└─ shared/       （沿用 / 擴充：TenantAppearance 等共用型別）
```

權責邊界：`admin/` 只負責管理 UI，所有狀態經 `/api/v1/admin/*` REST 走後端；外觀的「實際套用」發生在 widget 端讀取 `/api/v1/widget/config`。三項設定各自獨立分頁，互不耦合。

## 後端改動（server/）

### 1. 後台登入（單一管理密碼 → admin token）

- 新環境變數 `ADMIN_PASSWORD`：後台登入密碼，與 `ADMIN_API_KEY` 分開，避免把主控金鑰外洩到瀏覽器。留空 = 停用後台登入（回 403）。
- 新端點 `POST /api/v1/admin/auth/login`，body `{ password }`：
  - 比對 `ADMIN_PASSWORD`（常數時間比對）。
  - 成功 → 回 `{ token }`，為 admin JWT（沿用 `server/src/utils/jwt.ts`，payload 標記 `role: 'admin'`，TTL 例如 8h）。
  - 失敗 → 401。
- 擴充 `server/src/middlewares/require-admin.ts`：通過條件為「有效 `x-admin-key`（既有，向後相容）**或** 有效 admin Bearer JWT（`role: 'admin'`）」。

### 2. Widget 外觀（存後端、依租戶套用）

- `shared`（或 `tenant.types.ts`）新增型別 `TenantAppearance`：
  - `primaryColor: string`（hex，如 `#0057ff`）
  - `theme: 'light' | 'dark'`
  - `position: 'br' | 'bl'`（右下 / 左下）
  - `logoUrl?: string`
  - `welcomeMessage?: string`
  - `defaultLocale?: string`（如 `zh-Hant`）
  - 全部選填；未設欄位回退內建預設。
- `Tenant` 加 `appearance?: TenantAppearance`。
- 新端點 `PATCH /api/v1/admin/tenants/:id`（受 requireAdmin）：可更新 `name / allowedOrigins / ssoSecret / appearance`（部分更新）。
- 新**公開**端點 `GET /api/v1/widget/config?key=pk_…`：經 resolve-tenant 解析租戶後，回該租戶 `appearance`（找不到 / 未設則回預設）。供 widget 載入時讀取。
- 套用優先序（widget 端）：`data-*` 即時參數 > 後端 `appearance` 設定 > 內建預設。`client/src/embedConfig.ts` 與 `widget.js` 據此合併。

### 3. Webhook

- 既有 create / list / delete 已足夠 MVP。
- 補一個 `PATCH /api/v1/admin/tenants/:id/webhooks/:webhookId`：切換 `disabledAt`（啟用 / 停用）。dispatcher 投遞前已會略過有 `disabledAt` 的端點。

## 後台 UI（admin/）

技術：Vite + React + TS + `react-router-dom`，沿用 `@oa-agent/ui` 元件與 `@oa-agent/shared` 型別。

### 路由與頁面

```
/login              密碼登入 → 存 admin JWT 於 sessionStorage → 路由守衛
/                   租戶清單 + 建立租戶（呼叫 GET/POST /admin/tenants）
/tenants/:id        租戶詳情，含四個分頁：
   ├─ 外觀     色彩 / 主題 / 位置 / logo / 歡迎語 表單；右側 widget 即時預覽 iframe
   ├─ 設定     name、allowedOrigins、ssoSecret、API Keys（列表 / 發 pk·sk / 複製）
   ├─ Webhook  端點列表、新增（url / secret / events）、啟用·停用、刪除
   └─ 用量     對話 / 訊息 / 送出 計數（唯讀）
```

- 所有資料請求帶 `Authorization: Bearer <adminJWT>`；401 時導回 `/login`。
- 「外觀」分頁的即時預覽：嵌入 `client` 的 widget iframe，帶該租戶 `pk` 與表單中的 data-* 值，即時反映調整。

### 元件邊界

- `api.ts`：admin REST client（login、tenants、keys、webhooks、usage、appearance），統一掛 Bearer、處理 401。
- `auth`（store/context）：保存 admin JWT、登入/登出、路由守衛。
- 各分頁為獨立元件，僅依賴 `api.ts` 與型別，互不耦合，可獨立測試。

## 新增環境變數

| 變數 | 預設 | 必填 | 說明 |
|------|------|------|------|
| `ADMIN_PASSWORD` | （空） | 否 | 後台登入密碼。留空 = 停用後台登入。建議用足夠長的隨機字串並存於部署 secret。 |

（`ADMIN_API_KEY` 沿用既有意義：機器對機器的主控金鑰；後台登入改用 `ADMIN_PASSWORD` 換發 JWT，兩者並存。）

## 向後相容

- 既有 `x-admin-key` 管理流程不變（CI / 腳本可續用）。
- 未帶 appearance 的租戶 → widget 行為與現況完全相同。
- `client` widget 既有 `data-*` 行為不變；新增的 `/widget/config` 讀取為附加層，無設定時等同現況。

## 測試策略

- 後端：`auth/login`（正確/錯誤密碼、JWT 效期）、`require-admin` 雙模式（key 與 JWT）、`PATCH tenants`（部分更新與隔離）、`GET /widget/config`（依 pk 回外觀 / 預設）、webhook 啟用停用。沿用既有 smoke 風格。
- 前端：路由守衛（未登入導向 /login）、api 401 處理、各分頁表單送出呼叫對應端點。

## 範圍外（YAGNI）

- 多管理員帳號 / 角色權限（本案為單一密碼）。
- 外觀進階（自訂字體、CSS 注入、多主題版型）。
- Webhook 投遞紀錄 / 重試儀表板（僅做端點 CRUD 與啟用停用）。
