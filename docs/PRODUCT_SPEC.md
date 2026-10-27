# HyAgent 產品規格文件

> 文件版本：1.2
> 對應專案版本：根目錄 `package.json` 為 HyAgent v1.2.0（以目前工作樹實作為準）
> 文件日期：2026-10-27
> 文件狀態：目前實作規格（As-Is）；未完成與部署限制依第 12 節追蹤
> 核對方式：程式、路由、設定與專案文件靜態比對；不代表已在正式環境完成驗收

## 1. 文件目的

本文件定義 HyAgent 目前的產品定位、使用者角色、功能範圍、主要流程、權限與資料隔離、整合方式、非功能需求及已知限制，作為產品、設計、開發、測試、維運與外部整合團隊的共同基準。

本文件以目前儲存庫已實作能力為基準。需設定外部服務才能運作的功能會註明條件；Demo、Stub 與尚未實作項目不視為正式整合完成。通用 Integration Definition 與集中 Credential 管理屬未完成項目，於第 12 節追蹤，不列入目前支援功能。

### 1.1 能力狀態判讀

| 狀態 | 範圍 |
|---|---|
| 已實作 | 對話、Schema 表單、租戶與 Scope 管理、我的任務、站內通知、回覆評價及管理介面 |
| 已實作，需部署設定或外部服務 | SSO、OA HTTP、SMTP、MCP、知識索引與模型、報告 PDF、語音及影像情境 |
| Demo／Stub | OA／郵件預設 Stub、示範簽核進度及情境 MCP 假資料；不具正式業務效力 |
| 尚未實作 | 通用 Integration Definition、租戶集中 Credential 管理、通用整合管理 API；其他缺口見第 12 節 |

「已實作」指儲存庫存在對應程式，不代表特定部署已啟用、通過驗收或完成應用商店發布。

## 2. 產品摘要

### 2.1 產品名稱

HyAgent — Universal AI Agent Integration Platform（通用 AI Agent 整合平台）

### 2.2 產品定位

HyAgent 是一個可嵌入既有網站或獨立使用的多租戶 AI Agent 整合平台。使用者可用自然語言執行跨系統任務、填寫客製化表單、查詢知識及產生報告；管理者則可透過後台管理租戶、使用者、權限、Agent 能力、表單、MCP 服務、知識庫、外觀、Webhook、回覆評價、用量與稽核紀錄。另有 Expo 行動 App 工作區，提供共用對話核心與品牌情境 App。平台不綁定特定產品、系統或業務領域。

### 2.3 核心價值

- 降低跨系統業務表單的理解與填寫成本，由 AI 逐步補齊欄位。
- 以 Schema 管理表單、驗證、畫面與 Agent 行為；OA HTTP 送出由 `oa.schema.json` 描述端點及資料映射，其他外部工具可透過 MCP 擴充。
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
3. 讓企業新增或調整 Schema-driven 表單，透過現有 OA 連接器或 MCP 工具接入外部服務；新業務整合仍需配置與開發相應契約。
4. 提供企業文件的 RAG 問答與具來源約束的報告產生能力。
5. 支援嵌入式 Widget、Headless SDK、SSO handoff 與 Webhook。
6. 提供租戶管理後台、回覆評價、用量與稽核資訊。
7. 提供我的任務、站內通知及行動 App 共用核心，支援需授權的語音與影像情境。

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
- 使用者可用服務由 Scope Policy 決定，可對部門（群組）或個別帳號配置，也可定義角色技能套餐（Scope 集合）並指派。
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
8. 送出成功後回傳現有 OA 契約結果（包含 `oaRequestId`），並視租戶設定投遞 Webhook。預設 Stub 單號不代表正式外部申請。

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
| AUTH-01 | 提供可開關的開發帳密登入，核發 Access Token 與 Refresh Token | `AUTH_PASSWORD_LOGIN=auto` 在 production 關閉；明確開啟時須更換預設共用密碼；非正式企業身分驗證 |
| AUTH-02 | 系統應支援 Token Refresh | 有效 Refresh Token 可換發新 Access Token |
| AUTH-03 | 系統應提供目前登入者資訊 | `/api/auth/me` 回傳可信任的使用者資料 |
| AUTH-04 | 每個租戶可登記 Assertion 公鑰（最多 2 把啟用中，`kid` 由公鑰算出） | 未登記公鑰或簽章無效時不得完成 SSO 交換；私鑰留在整合方環境，平台不持有 |
| AUTH-05 | SSO Token 應綁定租戶與外部使用者身分 | 交換後的 Session 必須保留 tenant/user 關係，避免跨租戶冒用 |
| AUTH-06 | 管理後台使用獨立管理密碼登入 | `ADMIN_PASSWORD` 未設定時，管理後台登入應停用 |
| AUTH-07 | 公鑰支援輪替與不可逆撤銷 | 最多 2 把啟用中；例行輪替不得撤掉最後一把；撤銷記錄原因並作廢該公鑰建立的 Session |
| AUTH-08 | 租戶可明確啟用訪客 Session | `/api/auth/guest` 由伺服器產生隨機訪客身分；預設關閉，關閉後既有訪客 Session 失效 |
| AUTH-09 | SSO／訪客 Session 可登出 | `/api/auth/logout` 作廢目前 Session；帳密 JWT 呼叫此端點不執行撤銷 |

### 6.2 對話與 Agent

| 編號 | 需求 | 驗收條件 |
|---|---|---|
| CHAT-01 | 使用者可建立新對話並選填起始訊息與表單 ID | 建立後回傳 Conversation ID 與目前狀態 |
| CHAT-02 | 系統應在表單、知識問答、報告及其他可用 Agent 間進行意圖分流 | 分流結果受租戶服務與使用者 Scope 約束 |
| CHAT-03 | Agent 應支援多輪欄位補齊 | 每輪保留已收集欄位，不重複詢問已明確提供的資訊 |
| CHAT-04 | 使用者可取消對話 | 取消後不得繼續送出表單 |
| CHAT-05 | 系統應避免同一回合重複提問或重複執行高風險工具 | Guard 應在後端執行，不依賴模型自行遵守 |
| CHAT-06 | 對話及訊息需歸屬租戶與使用者 | 跨租戶或非擁有者讀取時不得洩漏資源是否存在 |
| CHAT-07 | 使用者可停止目前 AI 查詢 | 以 Query ID 中止同租戶、同使用者的模型／支援取消的工具呼叫；不同於取消表單，不保證撤回已完成的外部副作用 |
| CHAT-08 | 寫入工具使用確認卡片 | 支援提議、確認及取消動作；確認後由後端執行，不依賴模型自行判定使用者同意 |

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
| OA | `oa.schema.json`：OA HTTP 端點、方法、送出欄位映射與回應解析 | 現有 OA 送出契約；非通用 Integration Definition |

目前內建的 OA 情境表單可作為範例模板，而非 Agent 的固定能力邊界：

- 請假單（`leave-request`）
- 國內出差報銷（`business-trip-domestic`）
- 外出登記（`outing-registration`）

租戶可建立自訂表單 Definition 與視覺化版型。若需送到新的 CRM、ITSM 或 ERP，仍須確認現有 OA 契約是否適用，或另外開發 MCP／連接器，不能僅以建立表單視為整合完成。

主要要求：

- 前端依 Definition 動態渲染表單，不應針對每張表單另寫固定頁面。
- 支援文字、密碼、數字、多行文字、下拉、單選、多選、日期、時間、勾選及附件元件。
- 手動修改欄位必須送回後端驗證後才更新 Session。
- 明確同意欄位必須由使用者主動設為 `true`，Agent 不得代替同意。
- 對話附件單檔上限為 10 MB；外部系統能否接收附件依目前連接器與映射契約另行確認，未提供通用的檔案內容／外部 URL 傳送策略設定。
- 送出必須通過「已呈現摘要」與「本輪明確確認」兩道伺服器端條件。
- OA 連接器由 `OA_CONNECTOR=stub|http` 切換；HTTP 模式以 `OA_BASE_URL`、`OA_API_KEY` 設定目標與認證。
- HTTP 送出由各表單 `oa.schema.json` 的端點與映射驅動；尚無租戶層的通用 Credential 管理與 Connector 選擇介面。
- 目前 OA 結果使用 `oaRequestId` 等既有欄位；尚未統一成通用的 `externalId`／`redirectUrl` 契約。
- 新外部系統整合需檢查逾時、錯誤、重複送出與附件行為；不能假設已具備通用重試與冪等保證。

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
| 權限 | 管理部門／帳號 Scope Policy、角色技能套餐及其指派，檢視平台 Scope Catalog |
| 表單 | 查看、建立或更新租戶表單，進入視覺化 Designer |
| MCP 服務（平台頁面） | 新增、更新、刪除與重新整理 MCP Server；設定可見租戶、工具停用、確認要求及唯讀核准 |
| 使用者與 SSO | 管理租戶使用者、Session、Assertion 公鑰輪替與撤銷 |
| 回饋 | 查看回覆評價、問答快照與診斷資料，依條件篩選及標記處理狀態 |
| 知識庫 | 管理來源、匯入工作、檔案、標籤、ACL、建議問題與查詢測試 |
| Webhook | 新增、停用、啟用與刪除回呼端點 |
| 用量 | 查看對話、訊息、送出及 LLM 使用資訊 |
| 報告 | 依時間與關鍵字查詢租戶報告並下載 |
| 稽核 | 租戶頁查詢租戶稽核；側欄獨立頁查詢平台稽核，包含管理設定變更與相關工具／下載事件 |
| Skills | 查看平台可用技能／工具清單 |

### 6.7 租戶與整合

| 能力 | 規格 |
|---|---|
| API Key | `pk_` 可置於瀏覽器；`sk_` 只可用於伺服器端高權限操作 |
| CORS | 第一方來源由 `CORS_ORIGIN` 設定；外部嵌入來源由租戶 `allowedOrigins` 管理 |
| Widget | 支援 API Key、表單、語系、主題、位置及 Identity Endpoint（`data-token-url`）等參數；提供 `logout()` / `refreshIdentity()` 供宿主登出、換人時呼叫 |
| SDK | 提供 Headless REST Client、Widget 控制與事件橋接 |
| Webhook | 表單送出成功後以 HMAC 簽章投遞 `form.submitted`，支援指數退避重試 |
| BYO LLM Key | 租戶可設定 Anthropic／OpenAI 的 Model 與 API Key，Key 驗證後保存並遮罩回傳；亦可選 local，但端點統一使用部署層 `LLM_BASE_URL`，不接受租戶任意指定網址 |
| 現有連接器 | OA：Stub／HTTP；Email：Stub／SMTP。由環境變數設定，非租戶通用 Connector Registry |
| MCP | 平台登記遠端工具服務，依租戶可見性與使用者 Scope 授權；以簽章 JWT 傳遞呼叫身分 |
| 地端模型 | 平台可設定 OpenAI 相容的地端 LLM 與 Embedding 端點；不等同所有功能皆可離線運作 |

### 6.8 MCP 與智慧代理

- MCP Server 可設為平台共用或指定租戶可見；使用者仍須具備智慧代理與對應 MCP Scope。
- 工具依遠端 Schema 驗證輸入；驗證失敗提供欄位明細供 Agent 修正。工具迴圈有服務設定上限。
- 遠端宣告唯讀不足以免確認；須經管理者核准，且服務網址與工具定義指紋相符。定義變更後原核准失效，回到需確認流程。
- 具副作用工具透過提議與確認卡執行；只允許符合授權及唯讀條件的工具經 `/api/tools/:toolId/invoke` 直接呼叫。
- `MCP_SIGNING_KEY` 未設定時 MCP 功能停用；服務連線須符合網址、網路與逾時限制。
- `mcp/kit` 提供自建服務的驗證工具；門市與 SpaceMe 服務為情境示範，不代表已接正式庫存或其他企業資料。

### 6.9 AI 回覆評價

- Web Client 與行動對話介面可對具 `replyId` 的 AI 回覆給讚／倒讚、改評或撤回；僅能操作自己的可評價回覆。
- 倒讚可選錯誤、未回答、過時、不適當或其他原因，說明上限 500 字；讚不附原因與說明。
- 評價保存當時的問答快照與可用診斷資訊（例如作答模型、知識檢索或工具 Trace），對話清理後仍可依保留政策查閱；不承諾提供完整模型推理或工具逐字稿。
- 後台提供清單、7／30／90 天統計、服務／原因／處理狀態篩選，以及 `open`／`resolved` 與處理說明。
- 預設保存 180 天，由 `FEEDBACK_RETENTION_DAYS` 調整；統計與期限依使用者最後評價更新時間，管理員處理不延長期限。
- 評價不呼叫 LLM、不掛月配額；不會自動訓練模型或自動修正知識內容。

### 6.10 我的任務與通知中心

- 我的任務包含未完成表單、已送申請與我的報告；可續填草稿，取消需確認。未送回後端的本地表單編輯不屬於已保存草稿。
- 已送申請可搜尋表單名稱或單號；已送出／送出中不可從清單取消。簽核進度仍為示範資料，實際結果以外部系統為準。
- 站內通知涵蓋超過 24 小時未更新且仍有權限的草稿、待確認／失敗／已送出表單與報告終態。
- 提供全部／未讀、單筆或全部標已讀、重新整理與任務跳轉；清單最多 100 則，是目前任務狀態彙整，非永久事件歷史。
- 通知頁面可見時每 60 秒更新，回到視窗或開啟時更新；未登入與預覽不查詢。已讀狀態依租戶與帳號隔離。
- 尚未提供通知偏好、瀏覽器推播、電子郵件通知或正式 OA 簽核事件通知。

### 6.11 行動 App、語音與影像

- `mobile/` 是獨立 Expo／React Native 工作區；`packages/app-core` 提供登入、API、對話、評價、語音、確認彈窗、設定與主題等共用能力。
- 目前包含門市、SpaceMe 與 LIB ONE 情境 App；品牌素材、路由及領域工具由各 App 管理。儲存庫有實作不代表已發布至應用商店。
- 支援租戶啟用後的訪客模式；訪客以獨立隨機身分運作，不繼承企業帳號權限。
- 語音轉文字由 `/api/speech/transcribe` 提供，須有服務權限與 OpenAI Key；未設定時不可用。行動端另提供回覆朗讀。
- 影像分析由 `/api/vision/analyze` 提供；門市資料查詢依模型能力、指定 MCP Server、使用者權限及外部資料可用性運作，不是通用的任意影像業務處理承諾。

### 6.12 郵件工具

- 智慧代理可代擬郵件；實際寄送屬副作用操作，須由使用者確認。
- `EMAIL_CONNECTOR=stub` 僅模擬結果；`smtp` 模式需設定 SMTP Host、寄件者及相關認證，實際投遞另依郵件服務驗收。

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
| Submission | 已送出表單、現有 OA 結果與外部單號 |
| MCP Server | 遠端工具網址、租戶可見性、連線設定與工具核准／覆寫 |
| Auth Session／Assertion Key | SSO／訪客身分、Session 到期與撤銷、公鑰生命週期 |
| Reply Feedback | 回覆評價、問答快照、診斷資訊與處理狀態 |
| Notification Read | 依租戶／帳號保存通知已讀狀態；通知內容由任務狀態彙整 |
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

- `/api/auth/*`：開發帳密登入、Refresh、SSO Exchange、訪客 Session、登出與目前使用者。
- `/api/conversations/*`：建立／取得對話、傳送訊息、修改欄位、送出、取消、附件與動作提議／確認／取消。
- `/api/conversations/queries/:queryId/stop`：停止自己的目前查詢。
- `/api/conversations/:id/replies/:replyId/feedback`：建立／更新與撤回回覆評價。
- `/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/cancel`：個人任務。
- `/api/notifications`、`/api/notifications/read`：通知與已讀狀態。
- `/api/skills`、`/api/knowledge/suggested-prompts`：本人可用角色／技能與知識建議問題。
- `/api/tools/:toolId/invoke`：不經 AI 直接呼叫授權唯讀工具。
- `/api/speech/transcribe`、`/api/vision/analyze`：語音轉文字與影像分析。
- `/api/forms/*`：取得可用表單與 Definition。
- `/api/reports/*`：查詢報告狀態及下載。
- `/api/widget/config`：取得租戶外觀、服務及建議問題。

### 9.2 租戶端

- `/api/tenant/llm-config`：讀取與設定租戶自帶 LLM Provider、Model 與 Key。

### 9.3 管理端

- `/api/admin/auth/login`：管理者登入。
- `/api/admin/tenants/*`：租戶、API Key、Webhook、用量、外觀與服務管理。
- `/api/admin/tenants/:id/forms/*`：表單 Definition 管理。
- `/api/admin/mcp-servers/*`：MCP Server 設定、工具核准與重新整理。
- `/api/admin/tenants/:id/assertion-keys/*`：Assertion 公鑰登記與撤銷。
- `/api/admin/tenants/:id/users/*`：租戶使用者管理。
- `/api/admin/tenants/:id/feedback*`：回覆評價清單、統計與處理。
- `/api/admin/audit`：平台層稽核。
- `/api/admin/tenants/:id/knowledge/*`：知識來源、匯入、檔案、標籤、ACL 與測試。
- `/api/admin/tenants/:id/reports/*`：租戶報告查詢與下載。
- `/api/admin/tenants/:id/audit*`：稽核紀錄。
- `/api/admin/scopes`、`/api/admin/skills`：平台能力目錄。

`/api/openapi.json` 與 `/api/docs` 提供 OpenAPI 文件入口；新增功能是否已納入仍須核對路由與 Schema，不能假設文件已涵蓋全部現有端點。

MCP 呼叫身分驗證公鑰由 `/.well-known/hyagent-mcp-jwks.json` 提供；MCP 停用時回 404。

## 10. 非功能需求

### 10.1 安全

- 所有受保護 API 必須驗證 JWT、API Key 或管理憑證。
- production 的 `CORS_ORIGIN` 含 `*` 會拒絕啟動；外部嵌入另依租戶 `allowedOrigins` 管理，正式租戶仍須自行收斂白名單。
- SSO Identity Assertion 必須短效、驗證簽章、防重放並綁定租戶；交換後使用不透明 Session Token，不得相信前端直接傳入的 User ID。
- 密碼、JWT Secret、管理金鑰與 LLM API Key 不得寫入前端 Bundle 或 Log。整合方的 Assertion **私鑰**不得離開其自家後端；平台只持有公鑰。
- production 必須設定 `DATA_ENCRYPTION_KEY`，否則拒絕啟動；BYO LLM Key 與 Session 使用者識別碼等敏感欄位加密落地（公鑰不需加密）。
- 管理動作、工具執行與跨使用者報告下載需留下稽核資料。
- HTML／PDF 報告渲染不得任意存取外部網路，以避免 SSRF。
- 表單送出、寄信與 MCP 寫入工具要求明確確認；遠端唯讀宣告需經管理員核准與指紋檢查。
- 外部檢索與工具內容加入 Prompt Injection 邊界；Web Client 對 Agent Markdown 圖片與不安全連結加以限制。這些防護不代表所有外部內容均可信任。

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

- 根目錄 npm Workspaces 管理 `shared`、`ui`、`sdk`、`server`、`client`、`admin` 及 MCP 套件；`mobile/` 為獨立 npm 工作區。
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

Web 平台由三個主要服務組成；行動 App 為獨立客戶端，MCP 服務依情境另外部署：

```text
hyagent-admin  ─┐
hyagent-client ─┼── HTTPS ──> hyagent-server ──> LLM / PostgreSQL / OA / SMTP / MCP / Webhook
外部宿主站台 ──┤
行動 App     ──┘
```

關鍵設定包括：

- `CORS_ORIGIN`：第一方 Client 與 Admin 網域，逗號分隔且結尾不加 `/`。
- `DEFAULT_TENANT_ORIGINS`：預設租戶允許的嵌入來源。
- `JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`：正式環境必須使用不同且足夠長的隨機值。
- `ADMIN_PASSWORD`：管理後台登入；空值代表停用。
- `ADMIN_API_KEY`：機器對機器管理 API；不得暴露於瀏覽器。
- `DATA_BACKEND`、`DATABASE_URL`：正式多實例環境建議使用 DB 模式。
- `LLM_PROVIDER`、`LLM_MODEL` 及對應 Provider Key。
- `OA_CONNECTOR=stub|http`、`OA_BASE_URL`、`OA_API_KEY`：現有 OA 連接器；HTTP 模式必須提供 Base URL。
- `EMAIL_CONNECTOR=stub|smtp` 與 SMTP 設定：寄信工具；SMTP 模式必須提供 Host。
- `MCP_SIGNING_KEY`、`MCP_PREVIOUS_PUBLIC_KEY`、`MCP_ALLOWED_PRIVATE_ORIGINS`：MCP 呼叫簽章、換鑰及網路例外。
- `AUTH_PASSWORD_LOGIN`：開發帳密登入開關；production 預設關閉。
- `DATA_ENCRYPTION_KEY`：production 必填；需保留金鑰以讀取既有加密資料。
- `ALLOW_FILE_BACKEND_IN_PRODUCTION`：production 使用 File Backend 須明確啟用，且僅適用單副本與持久磁碟。
- `LLM_BASE_URL`、`EMBEDDING_PROVIDER`、`EMBEDDING_BASE_URL`：地端模型設定。
- `FEEDBACK_RETENTION_DAYS`：回覆評價保存天數，預設 180。
- `SPEECH_MODEL`、`OPENAI_API_KEY`、`VISION_STORE_SERVER_ID`：語音與影像情境相關設定。
- `REPORT_PDF_BROWSER`：PDF Renderer 使用的 Chromium 路徑。

## 12. 目前限制與正式上線前缺口

| 項目 | 現況／風險 | 建議 |
|---|---|---|
| 正式身分來源 | 帳密登入仍為開發共用密碼模式，production 預設關閉；已提供 Assertion SSO 與可選訪客模式 | 正式企業使用者由宿主後端簽發 Assertion；不可把開發登入當作正式企業認證 |
| 通用外部系統串接 | 已有 OA Stub／HTTP、Email Stub／SMTP 與 MCP；尚無通用 Integration Definition、租戶 Credential 管理及 `/integrations` 管理 API | 若要提供通用整合產品，再設計 Connector Registry、Credential、映射、重試、冪等及連線測試 |
| 正式送單與簽核 | OA 預設 Stub；HTTP 需配置實際端點與映射，任務簽核進度仍為示範資料 | 以真實外部系統完成契約與端到端驗收，不把 Stub 或示範狀態視為正式效力 |
| 行動與情境服務 | 有品牌 App、門市與 SpaceMe MCP 範例，不代表已發布或串接正式資料 | 依各情境確認裝置、權限、模型、外部服務與發布條件 |
| 多副本執行 | DB 持久化不等於所有執行狀態跨副本共享；查詢取消與報告 Job 等仍有程序內狀態 | 多副本須檢查路由黏著、狀態同步與工作佇列，不宣稱全面無狀態部署 |
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
4. 管理者建立一張自訂表單；以目前支援的 OA Definition 與 Stub／測試 HTTP 端點驗證映射。非 OA 工具另外透過 MCP 服務驗證。
5. 使用者以自然語言完成表單，能修改欄位、看摘要、明確確認並成功送出，取得目前 OA 契約的單號；清楚標示 Stub 與真實結果的差別。
6. 未授權使用者無法使用被限制服務或查到受限制文件。
7. 管理者上傳知識檔、設定可見性標籤，查詢測試能反映不同帳號 Scope。
8. 有 `service:report` 權限的使用者可建立報告、查看進度並下載可用格式。
9. 表單送出可觸發具 HMAC 簽章的 Webhook。
10. 管理者可查看用量、報告、平台／租戶稽核及回覆評價；以現有事件欄位驗證操作者、工具與結果，不要求尚未存在的 Integration 實體。
11. 跨租戶存取、無效 Token、未允許 Origin 與超出配額皆被後端拒絕並回明確錯誤。
12. 使用者可續填自己的草稿、查看申請與報告，通知已讀不影響其他帳號。
13. 使用者可評價、改評與撤回自己的回覆，管理者可篩選與處理；評價不消耗 LLM 月配額。
14. MCP 唯讀工具須經有效核准才可免確認；寫入工具未確認不得執行，無 Scope 的帳號不可存取。
15. 公鑰輪替與撤銷後，相關 Session 依規則失效；租戶停用訪客存取後，訪客不可繼續操作。
16. 停止目前 AI 查詢不等同取消申請；不承諾回復已完成的外部操作。
17. 啟用行動／語音／影像情境時，另依實際裝置、權限與 Provider 設定完成驗收。

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
| Integration Definition | 尚未完成的通用整合定義構想；目前表單使用 OA Definition，外部工具另可使用 MCP |
| MCP | Model Context Protocol；平台透過遠端工具服務擴充查詢與動作能力 |
| Connector | 現有 OA 或 Email 介面的實作；目前包含 OA Stub／HTTP 與 Email Stub／SMTP |
| Credential Reference | 尚未完成的集中憑證參照機制，不代表目前已有租戶 Credential 管理功能 |
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
- [`../NOTIFICATION-CENTER.md`](../NOTIFICATION-CENTER.md)：通知規則、API 與已讀儲存限制。
- [`ROLE-SKILLS.md`](ROLE-SKILLS.md)：角色與技能授權說明。
- [`HyAgent客戶網站自動登入規格.md`](HyAgent客戶網站自動登入規格.md)：Assertion SSO、公鑰與 Session 規則。
- [`superpowers/specs/2026-10-13-reply-feedback-design.md`](superpowers/specs/2026-10-13-reply-feedback-design.md)：回覆評價設計與保存政策。
- [`../mcp/kit/README.md`](../mcp/kit/README.md)：自建 MCP 服務與呼叫身分驗證。
- [`../mobile/README.md`](../mobile/README.md)：行動工作區與共用核心。
