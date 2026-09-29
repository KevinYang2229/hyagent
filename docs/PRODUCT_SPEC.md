# HyAgent 產品規格文件

> 文件版本：1.1
> 對應產品版本：HyAgent v1.1.0  
> 文件日期：2026-08-31
> 文件狀態：通用表單與外部系統整合目標規格（To-Be）；尚未完成部分依第 12 節追蹤

## 1. 文件目的

本文件定義 HyAgent 目前的產品定位、使用者角色、功能範圍、主要流程、權限與資料隔離、整合方式、非功能需求及已知限制，作為產品、設計、開發、測試、維運與外部整合團隊的共同基準。

本文件同時描述目前能力與通用表單整合的目標能力。尚未完成、僅有骨架或正式上線前仍需替換的部分，會明確列入第 12 節，不視為已完成承諾。

## 2. 產品摘要

### 2.1 產品名稱

HyAgent — Universal AI Agent Integration Platform（通用 AI Agent 整合平台）

### 2.2 產品定位

HyAgent 是一個可嵌入既有網站或獨立使用的多租戶 AI Agent 整合平台。使用者可用自然語言執行跨系統任務、填寫客製化表單、查詢知識及產生報告；管理者則可透過後台管理租戶、權限、Agent 能力、表單、外部系統整合、知識庫、外觀、Webhook、用量與稽核紀錄。平台不綁定特定產品、系統或業務領域。

### 2.3 核心價值

- 降低跨系統業務表單的理解與填寫成本，由 AI 逐步補齊欄位。
- 以 Schema 與 Integration Definition 作為表單、驗證、畫面、Agent 與外部系統資料契約的單一事實來源。
- 讓不同企業、部門、群組及帳號擁有不同的 AI 服務與資料存取範圍。
- 透過 Widget、SDK、SSO、REST API 與 Webhook 接入既有站台。
- 以權限檢查、租戶隔離、送出確認及稽核機制降低 AI 越權與誤操作風險。

### 2.4 目標使用者

- 企業員工：以對話完成表單、查詢內部知識及產生報告。
- 租戶管理者：設定企業租戶、權限、知識庫、表單與整合項目。
- 系統管理者：管理整體平台、租戶及營運狀態。
- 外部系統開發者：將 HyAgent 嵌入企業入口網站，或串接 OA、HR、ERP、CRM、ITSM 及其他內外部 API。

## 3. 產品目標與非目標

### 3.1 目前產品目標

1. 提供繁體中文為主的自然語言跨系統任務處理體驗，表單只是其中一種互動與資料收集方式。
2. 支援多租戶、帳號身分、Scope 權限及跨租戶資料隔離。
3. 讓企業能以低程式碼方式新增或調整 Schema-driven 表單，並將同一套 Agent 編排能力配置到不同外部系統。
4. 提供企業文件的 RAG 問答與具來源約束的報告產生能力。
5. 支援嵌入式 Widget、Headless SDK、SSO handoff 與 Webhook。
6. 提供可操作的租戶管理後台與用量／稽核資訊。

### 3.2 目前非目標

- 不取代企業既有 OA、HR、ERP、CRM、ITSM 或其他業務系統；HyAgent 是前端體驗與編排／整合層。
- 不以 Prompt 作為真正的資料安全邊界；權限必須由後端與工具執行層強制檢查。
- 不保證未接正式外部系統連接器時的送單、建檔或簽核資料具有正式效力。
- 不將未經知識庫檢索支持的內容包裝成企業事實。

## 4. 角色與權限模型

| 角色 | 說明 | 主要能力 |
|---|---|---|
| 一般使用者 | 企業員工或入口網站登入者 | 建立對話、辦理被授權表單、查詢被授權知識、查看自己的對話與報告 |
| 特定群組／帳號 | 依租戶權限政策識別的使用者集合 | 使用額外服務或存取特定知識範圍 |
| 租戶管理者 | 管理單一企業租戶的人員 | 設定表單、知識庫、權限、外觀、Webhook、API Key、SSO 與報告 |
| 平台管理者 | 管理 HyAgent 平台的人員 | 建立／刪除租戶、檢視全平台設定及使用管理 API |
| 外部系統 | 入口網站、OA、HR、ERP、CRM、ITSM、Webhook Receiver 或其他 API | SSO 交換、表單資料接收、API 呼叫及事件交換 |

### 4.1 授權原則

- 租戶是第一層資料安全邊界，跨租戶資源一律不可讀取或操作。
- 使用者可用服務由 Scope Policy 決定，可對群組或個別帳號配置。
- 服務權限與資料範圍分開判斷；例如具備知識庫服務權限，不代表能讀取所有文件。
- 知識庫檔案可設定可見性 Scope，檢索時依登入者有效 Scope 過濾。
- 後端在每次 API 與工具執行時檢查身分、租戶及權限；前端隱藏按鈕不構成安全控制。
- 管理 API 同時支援管理 JWT 與 `x-admin-key`，兩者用途分離。

## 5. 核心使用情境

### 5.1 對話式任務與表單處理

1. 使用者登入第一方 Client，或由宿主站台透過 SSO handoff 進入嵌入式 Widget。
2. 使用者選擇表單，或以自然語言描述需求讓系統判斷意圖。
3. Agent 從訊息抽取欄位，並逐步詢問缺漏資訊。
4. 後端依 Schema 執行格式、必填及跨欄商業規則驗證。
5. 欄位完整後，系統顯示摘要並進入確認狀態。
6. 使用者可在表單畫面手動修正欄位；修正內容仍由後端驗證。
7. 只有在使用者已看過摘要且明確確認後，後端才能送出。
8. 送出成功後回傳標準化 Submission Result（外部單號、狀態與可選導向網址），並視租戶設定投遞 Webhook。

### 5.2 企業知識問答

1. 使用者以自然語言提出企業規章或文件問題。
2. 系統確認租戶已啟用知識庫服務並解析使用者有效 Scope。
3. 檢索器只從該租戶且使用者可見的文件片段中搜尋。
4. 系統對候選片段進行評分／重排後生成回答。
5. 查無適當資料時，系統應誠實告知無相關資料，不自行補造企業規定。

### 5.3 報告產生

1. 使用者在對話中提出報告、彙整或總結需求。
2. 系統確認使用者具備 `service:report` Scope。
3. Agent 抽取報告主題；主題不足時先追問。
4. 系統建立非同步工作，依序進入 `queued`、`outlining`、`composing` 與終態。
5. 每個章節獨立檢索知識庫並彙整，無資料章節需明確標示。
6. 全部章節無命中時，工作以 `empty` 結束且不產生檔案。
7. 完成後提供系統實際支援的下載格式，目前為 Markdown、HTML，以及偵測到 Chromium 時的 PDF。
8. 使用者只能存取自己的報告；租戶管理者可在後台查詢租戶內報告，下載行為需留下稽核紀錄。

### 5.4 外部站台嵌入

1. 管理者建立租戶並設定 `allowedOrigins`。
2. 系統核發可公開使用的 `pk_` API Key；`sk_` 僅供伺服器端使用。
3. 宿主站台載入 Widget Script，傳入 API Key、表單、語系、主題或位置等設定。
4. 若需帳號連結，宿主後端以自家私鑰簽發短效 Identity Assertion（HyAgent 只持有對應公鑰）。
5. Widget 向宿主的 Identity Endpoint（`data-token-url`）取得 Assertion，送至 `/api/auth/sso/exchange` 換發 HyAgent Session（不透明 `sessionToken`）。
6. Widget 透過事件通知宿主送單結果，宿主亦可呼叫 `open`、`close`、`toggle` 控制介面。
7. 宿主使用者登出時，宿主頁必須呼叫 `OAAgent.logout()` 作廢 HyAgent Session；可不經登出直接換人的站台，換人後呼叫 `refreshIdentity()`。

## 6. 功能規格

### 6.1 使用者認證與帳號連結

| 編號 | 需求 | 驗收條件 |
|---|---|---|
| AUTH-01 | 系統應支援帳號密碼登入並核發 Access Token 與 Refresh Token | 登入成功後可呼叫受保護 API；無效憑證回傳 401 |
| AUTH-02 | 系統應支援 Token Refresh | 有效 Refresh Token 可換發新 Access Token |
| AUTH-03 | 系統應提供目前登入者資訊 | `/api/auth/me` 回傳可信任的使用者資料 |
| AUTH-04 | 每個租戶可登記 Assertion 公鑰（最多 2 把啟用中，`kid` 由公鑰算出） | 未登記公鑰或簽章無效時不得完成 SSO 交換；私鑰留在整合方環境，平台不持有 |
| AUTH-05 | SSO Token 應綁定租戶與外部使用者身分 | 交換後的 Session 必須保留 tenant/user 關係，避免跨租戶冒用 |
| AUTH-06 | 管理後台使用獨立管理密碼登入 | `ADMIN_PASSWORD` 未設定時，管理後台登入應停用 |

### 6.2 對話與 Agent

| 編號 | 需求 | 驗收條件 |
|---|---|---|
| CHAT-01 | 使用者可建立新對話並選填起始訊息與表單 ID | 建立後回傳 Conversation ID 與目前狀態 |
| CHAT-02 | 系統應在表單、知識問答、報告及其他可用 Agent 間進行意圖分流 | 分流結果受租戶服務與使用者 Scope 約束 |
| CHAT-03 | Agent 應支援多輪欄位補齊 | 每輪保留已收集欄位，不重複詢問已明確提供的資訊 |
| CHAT-04 | 使用者可取消對話 | 取消後不得繼續送出表單 |
| CHAT-05 | 系統應避免同一回合重複提問或重複執行高風險工具 | Guard 應在後端執行，不依賴模型自行遵守 |
| CHAT-06 | 對話及訊息需歸屬租戶與使用者 | 跨租戶或非擁有者讀取時不得洩漏資源是否存在 |

### 6.3 Schema-driven 表單

每張表單以 `schemas/<formId>/` 或租戶自訂 Definition 管理，包含下列層次：

| 層次 | 用途 | 狀態 |
|---|---|---|
| Data | JSON Schema 資料契約 | 必要 |
| Field | UI 元件、標籤、選項與說明 | 必要 |
| Validation | 必填與跨欄商業規則 | 必要 |
| Agent | 詢問順序、提示與確認話術 | 必要 |
| Layout | 欄位分組、排序與多步驟畫面 | 選用 |
| Workflow | 送出後簽核關卡 | 選用 |
| Policy | 工時等領域計算政策 | 選用 |
| Integration | 目標連接器、操作、認證參照、欄位映射、回應解析、錯誤映射與冪等策略 | 需要送至外部系統時使用 |

目前內建的 OA 情境表單可作為範例模板，而非 Agent 的固定能力邊界：

- 請假單（`leave-request`）
- 國內出差報銷（`business-trip-domestic`）
- 外出登記（`outing-registration`）

租戶亦可建立例如 CRM 客戶建檔、ITSM 報修、ERP 採購需求或自訂內部 API 操作等表單，不需新增專屬 Agent 類型。

主要要求：

- 前端依 Definition 動態渲染表單，不應針對每張表單另寫固定頁面。
- 支援文字、密碼、數字、多行文字、下拉、單選、多選、日期、時間、勾選及附件元件。
- 手動修改欄位必須送回後端驗證後才更新 Session。
- 明確同意欄位必須由使用者主動設為 `true`，Agent 不得代替同意。
- 附件單檔上限為 10 MB；送出時依 Integration Definition 決定傳送 Metadata、檔案內容或外部儲存 URL。
- 送出必須通過「已呈現摘要」與「本輪明確確認」兩道伺服器端條件。
- 表單 Definition 不得直接保存密碼、Token 或 API Key，只能引用租戶層的加密 Credential。
- 同一張表單可在不同租戶綁定不同 Integration；變更目標系統不應要求修改 Agent 編排核心或重寫前端頁面。
- 連接器須將各外部系統回應正規化為一致的 `externalId`、`status`、`message`、`redirectUrl` 與 `rawReference`（選用）結果。
- 無外部系統的表單可設定為僅保存 Submission、投遞 Webhook，或交由自訂 Connector 執行。

### 6.4 知識庫

| 編號 | 需求 | 驗收條件 |
|---|---|---|
| KB-01 | 管理者可設定網站來源並啟動擷取／索引 | 工作狀態與索引 Metadata 可查詢 |
| KB-02 | 管理者可上傳知識檔案 | 支援的檔案能被解析、切塊並寫入索引；無文字或格式錯誤需回明確錯誤 |
| KB-03 | 管理者可進行資料夾批次匯入 | 批次工作可追蹤檔案級結果，避免單一失敗破壞整批狀態 |
| KB-04 | 管理者可刪除單一檔案或整個知識庫 | 刪除後相關 Chunks、Metadata 與結構化表格資料應一致移除 |
| KB-05 | 管理者可建立可見性標籤並標註檔案 | 使用中的標籤刪除後，受影響檔案回到未標記狀態 |
| KB-06 | 檢索必須套用使用者有效 Scope | 無權限文件不可出現在命中、回答或報告中 |
| KB-07 | 管理者可模擬指定使用者測試查詢 | 測試結果應反映該使用者實際可見範圍 |
| KB-08 | 系統可自動產生或手動設定建議問題 | 手動設定在重新索引後仍應保留，除非管理者主動清除 |
| KB-09 | 管理者可查看 ACL 報告 | 報告應呈現標籤、Scope 與檔案可見性配置狀態 |

### 6.5 報告

- 報告只能由對話意圖觸發，沒有獨立的建立報告 REST API。
- 同一租戶同時間只允許一個報告工作執行。
- 章節內容必須以知識庫命中為依據；查無資料不得臆測。
- 精確圖表數值須由結構化資料計算，不由 LLM 自行產生。
- 綜合觀察只可使用符合條件的精確圖表資料點。
- 可下載格式由後端 Renderer Registry 決定，前端不得寫死格式清單。
- 報告預設保存 720 小時，過期後不列出且下載回 404。
- DB 模式下報告產出物可跨重啟保存；File 模式下只存在記憶體。

### 6.6 管理後台

管理後台至少提供以下頁面／分頁：

| 功能 | 規格摘要 |
|---|---|
| 租戶列表 | 建立、查看及進入租戶設定；平台管理者可刪除租戶 |
| 設定 | 租戶名稱、允許來源、Assertion 公鑰清單、API Key 與服務設定 |
| 外觀 | AI 名稱、Logo、歡迎語、主色、主題、語言與 Widget 位置，支援即時預覽 |
| 權限 | 管理群組、帳號與 Scope Policy，檢視平台 Scope Catalog |
| 表單 | 查看、建立或更新租戶表單，進入視覺化 Designer |
| 外部系統整合 | 管理 Connector、Base URL、Credential、操作、欄位／狀態映射與連線測試；敏感值僅可新增或輪替，不可明文讀回 |
| 知識庫 | 管理來源、匯入工作、檔案、標籤、ACL、建議問題與查詢測試 |
| Webhook | 新增、停用、啟用與刪除回呼端點 |
| 用量 | 查看對話、訊息、送出及 LLM 使用資訊 |
| 報告 | 依時間與關鍵字查詢租戶報告並下載 |
| 稽核 | 查詢工具執行、管理操作及報告下載等安全紀錄 |
| Skills | 查看平台可用技能／工具清單 |

### 6.7 租戶與整合

| 能力 | 規格 |
|---|---|
| API Key | `pk_` 可置於瀏覽器；`sk_` 只可用於伺服器端高權限操作 |
| CORS | 第一方來源由 `CORS_ORIGIN` 設定；外部嵌入來源由租戶 `allowedOrigins` 管理 |
| Widget | 支援 API Key、表單、語系、主題、位置及 Identity Endpoint（`data-token-url`）等參數；提供 `logout()` / `refreshIdentity()` 供宿主登出、換人時呼叫 |
| SDK | 提供 Headless REST Client、Widget 控制與事件橋接 |
| Webhook | 表單送出成功後以 HMAC 簽章投遞 `form.submitted`，支援指數退避重試 |
| BYO LLM Key | 租戶可設定 Anthropic 或 OpenAI Provider、Model 與 API Key；Key 須先驗證且回傳時遮罩 |
| Integration Connector | 以統一介面支援 Stub、通用 HTTP／REST、Webhook 及自訂 Adapter；各表單以 Integration Definition 選擇連接器與操作，前端與 Agent 不需因目標系統替換而改動 |
| Credential | 由租戶集中管理 API Key、Bearer Token、Basic Auth、OAuth 2.0 Client Credentials 或自訂密鑰；表單只保存 Credential Reference |

## 7. 主要狀態模型

### 7.1 對話狀態

```text
collecting → confirming → submitting → submitted
     │            │             └→ failed
     └────────────┴──────────────→ cancelled
```

| 狀態 | 說明 |
|---|---|
| `collecting` | 收集與驗證欄位 |
| `confirming` | 已呈現摘要，等待使用者確認或修改 |
| `submitting` | 正在呼叫表單所配置的外部系統／領域服務 |
| `submitted` | 送出成功 |
| `cancelled` | 使用者取消 |
| `failed` | 執行失敗，可依錯誤類型決定是否重試 |

### 7.2 報告狀態

```text
queued → outlining → composing → done
   │          │            ├──→ empty
   └──────────┴────────────└──→ failed
```

## 8. 資料模型摘要

| 實體 | 主要用途 |
|---|---|
| Tenant | 租戶識別、Allowed Origins、外觀、SSO、LLM 與服務設定 |
| API Key | 租戶解析及公開／秘密存取能力 |
| Session | 對話、欄位值、訊息與狀態 |
| Submission | 已送出表單、目標 Integration、標準化結果及外部系統單號 |
| Integration | 租戶的外部系統連接器、操作、Credential Reference、映射與重試設定 |
| Attachment | 對話附件內容與 Metadata |
| Scope Policy | 群組／帳號對 Scope 的授權規則 |
| Tenant Form | 租戶自訂表單 Definition |
| Knowledge Source／Index／Chunk | 知識來源、索引 Metadata 與向量片段 |
| Webhook | 回呼網址、密鑰、事件與啟停狀態 |
| Tenant Usage | 租戶用量與模型使用聚合 |
| Report Document | 報告格式、內容、擁有者與到期時間 |
| Audit Log | 操作者、工具、時間、結果與錯誤摘要 |

## 9. API 範圍摘要

### 9.1 使用者端

- `/api/auth/*`：登入、Refresh、SSO Exchange、目前使用者。
- `/api/conversations/*`：建立／取得對話、傳送訊息、修改欄位、取消、附件。
- `/api/forms/*`：取得可用表單與 Definition。
- `/api/reports/*`：查詢報告狀態及下載。
- `/api/widget/config`：取得租戶外觀、服務及建議問題。

### 9.2 租戶端

- `/api/tenant/llm-config`：讀取與設定租戶自帶 LLM Provider、Model 與 Key。

### 9.3 管理端

- `/api/admin/auth/login`：管理者登入。
- `/api/admin/tenants/*`：租戶、API Key、Webhook、用量、外觀與服務管理。
- `/api/admin/tenants/:id/forms/*`：表單 Definition 管理。
- `/api/admin/tenants/:id/integrations/*`：外部系統 Connector、Credential Reference、操作映射與連線測試。
- `/api/admin/tenants/:id/knowledge/*`：知識來源、匯入、檔案、標籤、ACL 與測試。
- `/api/admin/tenants/:id/reports/*`：租戶報告查詢與下載。
- `/api/admin/tenants/:id/audit*`：稽核紀錄。
- `/api/admin/scopes`、`/api/admin/skills`：平台能力目錄。

完整且可互動的 API 契約由 `/api/openapi.json` 與 `/api/docs` 提供。

## 10. 非功能需求

### 10.1 安全

- 所有受保護 API 必須驗證 JWT、API Key 或管理憑證。
- CORS 只允許第一方站台或租戶白名單來源，不應在正式環境無條件使用 `*`。
- SSO Token 必須短效、驗證簽章並綁定租戶；不得相信前端直接傳入的 User ID。
- 密碼、JWT Secret、管理金鑰與 LLM API Key 不得寫入前端 Bundle 或 Log。整合方的 Assertion **私鑰**不得離開其自家後端；平台只持有公鑰。
- `DATA_ENCRYPTION_KEY` 啟用時，BYO LLM Key 與 Session 上的使用者識別碼等敏感資料需加密落地（租戶公鑰為公開資料，不需加密）。
- 管理動作、工具執行與跨使用者報告下載需留下稽核資料。
- HTML／PDF 報告渲染不得任意存取外部網路，以避免 SSRF。
- 表單送出、寄信等具副作用操作應要求明確確認。

### 10.2 隔離與一致性

- 所有業務資料須包含或可推導 `tenantId`。
- 跨租戶查詢應回 404，避免洩漏資源存在性。
- 知識檔案刪除或重建索引後，Chunks、結構化表格、Metadata 與 ACL 應保持一致。
- DB 模式使用 PostgreSQL 持久化；File 模式僅適合開發、Demo 或單實例情境。

### 10.3 效能與可用性

- API 應有租戶／使用者層級 Rate Limit。
- 會觸發 LLM 成本的路徑應套用月配額與用量追蹤。
- 報告採非同步工作，前端以輪詢顯示進度，不阻塞單一 HTTP 請求。
- `/healthz` 用於存活檢查；`/readyz` 應反映資料庫等必要依賴是否可用。
- Webhook 失敗應以指數退避重試，不影響主要送單回應。

### 10.4 可維護性

- Monorepo 以 npm Workspaces 管理 `shared`、`ui`、`sdk`、`server`、`client` 與 `admin`。
- TypeScript 型別由 `@hyagent/shared` 共用。
- 表單定義與流程應優先透過 Schema 擴充，避免修改編排核心。
- LLM、Embedding、外部系統 Connector 與儲存層皆應保持可抽換介面。
- 程式異動應通過 Build、Typecheck、Lint 與相關測試。

### 10.5 可及性與使用體驗

- 介面需支援淺色／深色主題及使用者字級調整。
- 動畫應尊重 `prefers-reduced-motion`。
- 對話、表單驗證、上傳、報告與登入錯誤需提供可理解的繁體中文訊息。
- 嵌入模式應隱藏不必要的第一方導覽元素，維持 Widget 使用體驗。

## 11. 部署與設定需求

目前部署由三個主要服務組成：

```text
hyagent-admin  ─┐
hyagent-client ─┼── HTTPS ──> hyagent-server ──> LLM / PostgreSQL / Integration Connectors / Webhook
外部宿主站台 ──┘
```

關鍵設定包括：

- `CORS_ORIGIN`：第一方 Client 與 Admin 網域，逗號分隔且結尾不加 `/`。
- `DEFAULT_TENANT_ORIGINS`：預設租戶允許的嵌入來源。
- `JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`：正式環境必須使用不同且足夠長的隨機值。
- `ADMIN_PASSWORD`：管理後台登入；空值代表停用。
- `ADMIN_API_KEY`：機器對機器管理 API；不得暴露於瀏覽器。
- `DATA_BACKEND`、`DATABASE_URL`：正式多實例環境建議使用 DB 模式。
- `LLM_PROVIDER`、`LLM_MODEL` 及對應 Provider Key。
- `INTEGRATION_CONNECTOR_DEFAULT`：未指定連接器時的預設實作；開發環境可使用 Stub，正式環境應由租戶／表單指定 Integration。
- `REPORT_PDF_BROWSER`：PDF Renderer 使用的 Chromium 路徑。

## 12. 目前限制與正式上線前缺口

| 項目 | 現況／風險 | 建議 |
|---|---|---|
| 正式身分來源 | 一般登入仍有 Mock 帳號／共用開發密碼模式 | 串接企業 OIDC／身分提供者，建立穩定的外部帳號對應 |
| 通用外部系統串接 | 現有實作若仍由 Stub OA 模擬送單與簽核，尚未完整落實 Integration Definition | 建立 Connector Registry 與通用 HTTP Connector，補齊 Credential 管理、欄位／回應／錯誤映射、冪等、逾時重試及契約測試；再將 OA 降為其中一個 Adapter |
| API Key 生命週期 | 目前已以 SHA-256 雜湊保存，原始 Key 只在建立時顯示 | 補齊 Key 輪替、Last-used、到期政策與操作手冊 |
| File Backend | 記憶體／本機檔案不適合多實例，部分資料重啟即失 | 正式環境使用 PostgreSQL，檔案量增長時改用 S3／R2 |
| Webhook 工作佇列 | 目前為行內非同步重試 | 規模或可靠度需求提高時改用 BullMQ／持久化 Queue |
| 報告工作 | 同租戶一次只能產生一份，Job 部分狀態存在記憶體 | 將 Job 狀態持久化並支援可控併發與恢復 |
| 文件搜尋 | 報告後台關鍵字主要搜尋檔名與使用者 | 持久化 Topic／Metadata，視需求增加全文搜尋 |
| CORS 預設 | 預設租戶 `*` 是向後相容設定 | 正式環境收斂為明確白名單 |
| 附件儲存 | DB 直接保存 Bytes，單檔上限 10 MB | 大量附件改用物件儲存並加入惡意檔案掃描 |

## 13. 驗收基準

一次可供 Demo／驗收的完整故事至少應通過：

1. 管理者建立租戶、設定 Allowed Origins、外觀與 SSO。
2. 管理者核發 `pk_` Key，並將 Widget 嵌入白名單宿主站台。
3. 宿主登入者可透過 SSO 免輸入 HyAgent 密碼進入 Widget。
4. 管理者不修改 Agent 編排核心，即可建立一張客製化表單、綁定非 OA 的測試 Integration，並完成欄位映射與連線測試。
5. 使用者以自然語言完成該客製化表單，能修改欄位、看摘要、明確確認並成功送出，且取得標準化外部單號與狀態。
6. 未授權使用者無法使用被限制服務或查到受限制文件。
7. 管理者上傳知識檔、設定可見性標籤，查詢測試能反映不同帳號 Scope。
8. 有 `service:report` 權限的使用者可建立報告、查看進度並下載可用格式。
9. 表單送出可觸發具 HMAC 簽章的 Webhook。
10. 管理者可查看用量、報告與稽核紀錄，且稽核紀錄能識別表單、Integration 與外部單號。
11. 跨租戶存取、無效 Token、未允許 Origin 與超出配額皆被後端拒絕並回明確錯誤。

## 14. 成功指標建議

目前程式已具備部分計數基礎，產品上線後建議追蹤：

- 對話建立數、有效互動使用者數及租戶活躍率。
- 表單開始率、完成率、取消率、失敗率及平均完成輪數。
- 首次欄位抽取正確率與人工修正率。
- 知識問答命中率、無結果率及權限過濾後零命中率。
- 報告完成率、平均產生時間、空報告率與下載率。
- Webhook 成功率、重試次數及最終失敗率。
- 每租戶／模型 Token 與成本使用量。
- 401、403、404、413、429、5xx 及 CORS 相關錯誤率。

## 15. 名詞表

| 名詞 | 說明 |
|---|---|
| Tenant | 租戶，一個企業或獨立整合方的資料與設定邊界 |
| Integration | 租戶可配置的系統整合定義，描述 HyAgent 如何透過 Connector 與 OA、HR、ERP、CRM、ITSM 或其他服務交換資料與事件 |
| Connector | 實作統一送出介面的 Adapter，例如通用 HTTP、Webhook、特定產品 API 或 Stub |
| Credential Reference | 表單／Integration 對租戶加密憑證的參照，不包含明文秘密 |
| SSO | 單一登入，使用者登入宿主站台後可免登入進入 HyAgent |
| RBAC | 依角色配置權限的存取控制方式 |
| ACL | 對特定資源列出可存取主體或條件的存取控制清單 |
| Scope | HyAgent 中代表服務或資料能力的權限字串 |
| RAG | 先檢索企業資料，再讓模型依命中內容回答或彙整 |
| Widget | 可嵌入外部網頁的 HyAgent 對話介面 |
| SDK | 供外部開發者呼叫 API、控制 Widget 與接收事件的工具包 |
| BFF | 面向前端的應用後端；HyAgent Server 同時承擔 Agent 編排與系統整合責任 |
| BYO Key | 租戶自行提供 LLM Provider API Key |
| Webhook | HyAgent 在事件發生後主動呼叫外部系統的 HTTP 通知 |

## 16. 參考文件

- [`../README.md`](../README.md)：功能、開發方式與核心架構。
- [`../INTEGRATION.md`](../INTEGRATION.md)：多租戶、Widget、SDK、SSO 與 Webhook。
- [`ARCHITECTURE.md`](ARCHITECTURE.md)：平台目標架構、現況與演進觸發點。
- [`../schemas/README.md`](../schemas/README.md)：Schema-driven 表單完整規格。
- [`../DEPLOY.zeabur.md`](../DEPLOY.zeabur.md)：Zeabur 部署與環境變數。
