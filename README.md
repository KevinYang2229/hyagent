# HyAgent（v1.0.0）

對話式 OA Agent。員工用自然語言描述需求，Agent 透過對話補齊欄位（slot-filling）、驗證、請使用者確認後送出。**已內建三張表單：請假單（leave-request）、國內出差報銷（business-trip-domestic）、外出登記（outing-registration）**，schema-driven、LLM 驅動、OA 以 stub 模擬。

同一個對話介面另有兩條路：**知識庫問答**（RAG 檢索企業文件回答）與**報告**（依檢索結果彙整成可下載文件，見下方「報告」一節）。多租戶、權限（scope）、用量配額與後台管理見 [`INTEGRATION.md`](INTEGRATION.md)，部署見 [`DEPLOY.zeabur.md`](DEPLOY.zeabur.md)。

## 文件地圖

| 文件 | 讀它來回答 |
| ---- | ---------- |
| [`README.md`](README.md)（本檔） | 這是什麼、怎麼跑起來、schema 六層與部署拓撲 |
| [`schemas/README.md`](schemas/README.md) | 各層欄位規格、引擎怎麼消費、**如何新增/設定一張表單** |
| [`INTEGRATION.md`](INTEGRATION.md) | 對外整合：多租戶、API Key、widget/SDK、SSO handoff、webhook、後台管理 |
| [`DEPLOY.zeabur.md`](DEPLOY.zeabur.md) | 部署：Zeabur 前後端分服務、四個 Dockerfile、環境變數清單 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 目標架構、現況對照、演進觸發點——決定「要不要做某個平台機制」時查它 |
| [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) | 產品規格（To-Be）：通用表單與外部系統整合的目標規格 |
| [`docs/SYSTEM_ANALYSIS.md`](docs/SYSTEM_ANALYSIS.md) | 系統分析（As-Is）：現況系統規格 |
| [`docs/HANDOFF-OA-HTTP.md`](docs/HANDOFF-OA-HTTP.md) | 交接：把表單送進真 OA（`OA_CONNECTOR=http`）的待辦與驗收 |
| [`docs/HANDOFF-SSO.md`](docs/HANDOFF-SSO.md) | 交接：SSO handoff 從 demo 做到可上線的待辦與驗收 |
| [`docs/knowledge-reimport-manifest.md`](docs/knowledge-reimport-manifest.md) | 知識庫清空當下各租戶原本有什麼，供重新匯入對照 |

## 核心理念：一份 Schema 當唯一來源

表單以 `schemas/<formId>/` 下的六層 JSON 定義，程式由此生成驗證與 Agent 工具：

| 層         | 檔                       | 用途                                          | 狀態 |
| ---------- | ------------------------ | --------------------------------------------- | ---- |
| Data       | `data.schema.json`       | 資料形狀（JSON Schema = OA 契約）             | ✅   |
| Field      | `field.schema.json`      | 欄位 UI 元件 + 標籤 + 選項                    | ✅   |
| Validation | `validation.schema.json` | 必填 + 跨欄商規                               | ✅   |
| Agent      | `agent.schema.json`      | 詢問順序、提示、確認話術                      | ✅   |
| Layout     | `layout.schema.json`     | 版面：欄位分組、顯示順序、多步驟（>1 section）| ✅   |
| Workflow   | `workflow.schema.json`   | 簽核關卡：送出後計算 approved/current/pending | ✅   |

> Layout / Workflow 為選用層：表單沒有定義時，前端 fallback 成扁平單頁、後端不帶簽核進度。三張表單目前皆已定義 Layout；簽核狀態於 Demo 以時間自動推進（真串接時改由 OA 連接器查詢）。

新增一張表單 = 在 `schemas/` 加一個資料夾，**不需改編排層程式**。

> 📖 **各層欄位規格、引擎如何消費、以及「如何新增/設定一張表單」的完整說明見 [`schemas/README.md`](schemas/README.md)。**

## 專案結構（monorepo / npm workspaces）

```
hyagent/
├─ schemas/            前後端共用：六層表單 JSON Definition（單一來源）
├─ shared/             前後端共用：TS 型別（Definition / FieldSpec / SessionStatus…）
├─ ui/                 設計系統元件庫 @hyagent/ui（前端共用、純展示）
├─ sdk/                對外整合 SDK @hyagent/sdk（headless REST 客戶端 + widget 事件/控制橋接）
├─ server/             後端 Express（schema 引擎 + 對話 Agent + 知識庫 + 報告 + REST）
├─ client/             前端 Vite + React + TS（對話 + schema-driven 表單）
├─ admin/              後台 Vite + React + TS（租戶／權限／知識庫／表單 Designer／報告／稽核）
├─ presale/            整合範例（公開 widget、租戶 widget、自製 UI、webhook receiver、mock OA）
└─ docs/               架構決策、產品／系統規格、串接交接文件（見上方「文件地圖」）
```

`server` 與 `client` 都 import `@hyagent/shared`，型別不再各寫一份。**但 server 一律只用 `import type`**——部署映像只帶編譯後的 `server/dist`，執行期載入 shared 的 TypeScript 原始檔會直接爆掉，所以要共用的執行期函式（如條款連結判斷）改寫在 server 自己的模組（[`field-links.ts`](server/src/modules/form/field-links.ts)）。

### 設計系統與 schema-driven 渲染

表單元件由 schema 的 `field.component` 決定，透過一張 registry 對應到 `@hyagent/ui` 的元件：

```
ui/src/components/*          設計系統元件（自己的 props，不認識 schema）
ui/src/styles.css            設計系統共用樣式：token（--primary-color…）+ base + 共用 class
client/src/form/registry.tsx field.component（'Select'…）→ 設計系統元件的 adapter
client/src/FormView.tsx      只查 registry render，不寫死 switch
```

設計系統的共用樣式由 ui 套件擁有並對外提供，client 引用一次（`@import "tailwindcss"` 之後）：

```css
/* client/src/index.css */
@import "tailwindcss";
@import "@hyagent/ui/styles.css"; /* ← 元件共用 token + base */
```

（`@hyagent/ui/styles.css` 對應 `ui/src/styles.css`，於 ui 的 package.json `exports` 宣告。）

**接上你的設計系統**：

1. 把元件放進 `ui/src/components/` 並從 `ui/src/index.ts` export。
2. 在 `client/src/form/registry.tsx` import，寫一個把 `FieldControlProps`（`spec` / `value` / `onChange` / `disabled`）轉成該元件 props 的 adapter。
3. 加進 `fieldRegistry`。FormView 不需改動。

（`ui/src/components/` 內目前是範例佔位元件，換成你的設計系統後保留 props 介面即可。）

## 快速開始

```bash
# 1. 安裝（根目錄一次裝齊所有 workspace）
npm install

# 2. 設定 API key（編輯 server/.env，把 ANTHROPIC_API_KEY 換成真正的 key）
#    ANTHROPIC_API_KEY=sk-ant-...

# 3. 啟動（各開一個終端機）
npm run dev:server   # 後端 http://localhost:3000
npm run dev:client   # 前端 http://localhost:5173
npm run dev:admin    # 後台 http://localhost:5174

# 4.（離線）驗證 schema 引擎，不需 key
npm run smoke

# build / typecheck / test / lint 全部 workspace
npm run build
npm run typecheck
npm test
npm run lint         # 或 npm run lint:fix
```

打開 http://localhost:5173 即可用對話畫面填寫請假單；前端 dev server 會把 `/api`、`/healthz` proxy 到後端 3000。

## API（REST，全程繁中對話）

| Method | Path                                      | 說明                                                        |
| ------ | ----------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/conversations`                   | 建對話，可帶 `{ "message": "..." }` 起首輪                  |
| POST   | `/api/conversations/:id/messages`      | 送一則訊息，跑一輪                                          |
| PATCH  | `/api/conversations/:id/fields`        | 確認畫面手動編輯欄位（不經 LLM，走 form.engine 驗證後存回） |
| GET    | `/api/conversations/:id`               | 取狀態 + 已填值 + 送出結果                                  |
| POST   | `/api/conversations/:id/cancel`        | 取消                                                        |
| GET    | `/api/forms` / `/api/forms/:formId` | 列出 / 取得表單 Definition                                  |
| GET    | `/api/reports/:id`                        | 查報告產生進度與可下載格式                                  |
| GET    | `/api/reports/:id/download?format=md`     | 下載報告（`format` 由後端登錄表決定：`md` / `html`，探測到 Chromium 時另有 `pdf`） |
| GET    | `/api/admin/tenants/:id/reports`          | 後台：查該租戶的報告（`from` / `to` / `q` 皆選填）           |
| GET    | `/api/admin/tenants/:id/reports/:reportId/download?format=md` | 後台：下載報告（不比對建立者，改以稽核留軌跡） |
| GET    | `/healthz`                                | 存活檢查：回 `{ status, llm: { provider, model } }`；不打 LLM、不查 DB |
| GET    | `/readyz`                                 | 就緒檢查：`db` 模式實際 ping 資料庫，不可達回 503，讓編排器停止導流 |

> 對話 API 需 JWT：先 `POST /api/auth/login`（dev 環境為 mock 帳號 `kevin`/`hyweb` + `AUTH_DEV_PASSWORD`）取得 accessToken，之後帶 `Authorization: Bearer <token>`。widget/SDK 另可走租戶 `ssoSecret` 的 SSO handoff（`/api/auth/sso/exchange`）。`/api/reports/*` 同樣需要 JWT——`<a href>` 一般導覽不會帶 Authorization header，前端需改用 fetch 取 blob 後觸發下載。

> **互動式 API 文件**：server 起來後開 <http://localhost:3000/api/docs>（Swagger UI），原始規格在 `GET /api/openapi.json`。規格由 [`server/src/modules/docs/openapi.ts`](server/src/modules/docs/openapi.ts) 維護，涵蓋對外整合面的主要端點與三種認證維度（`x-api-key` 租戶金鑰 / `Authorization: Bearer` 使用者 JWT / `x-admin-key` 管理 API）——上面這張表只列對話與報告，整合面端點以該規格與 [`INTEGRATION.md`](INTEGRATION.md) 為準。

> **舊路徑相容**：`/api/v1/*` 仍可用，server 於路由前把 `req.url` 改寫成 `/api/*`（同一次請求完成，保留 method / body / headers，不走 HTTP 轉址）。確認外部串接皆改用無 `v1` 的路徑後即可移除。

### Demo（curl）

```bash
# 登入取得 token（dev：mock 帳號 + AUTH_DEV_PASSWORD，預設 oa1234）
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"kevin","password":"oa1234"}' | jq -r .data.accessToken)

# 建立並起首輪
curl -s -X POST localhost:3000/api/conversations \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"message":"我下週一到週二要請特休，家裡有事"}'

# 後續回答（用回傳的 id）
curl -s -X POST localhost:3000/api/conversations/<id>/messages \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"message":"確認"}'
```

Agent 會逐一問缺漏欄位 → 必填齊全後出摘要請你回「確認」→ 送出 stub OA，回 `oaRequestId: STUB-...`。

## 報告（依知識庫檢索彙整成可下載文件）

在對話中提到想要一份「報告 / 彙整 / 總結」（例：「幫我整理一份請假規定的報告」），Agent 會辨識為報告意圖並觸發：

1. **觸發方式**：純對話，沒有獨立的「建立報告」REST 端點。Agent 先用 LLM 從對話抽出主題（抽不到就回問，**不會** fail-open 拿一句空泛的話去硬跑，因為一份報告的成本是「1 次大綱 + N 次檢索 + N 次彙整」）。
2. **需要的 scope**：`service:report`。這是刻意的產品決定——報告成本較高，**不列入新租戶預設開通的服務**，須由 admin 於後台「權限」手動授予該租戶（或該租戶內特定使用者）後才能使用；未授予時對話會判定沒有此意圖可用。
3. **非同步產生**：抽到主題後對話立即回覆「已開始產生」並附上 `report: { id, status }`，實際彙整在背景進行，前端輪詢 `GET /api/reports/:id` 取得進度（`status`：`queued` → `outlining` → `composing` → `done` / `failed` / `empty`，並回傳 `doneSections` / `totalSections`）；終態才會有完整的 `files`（`{ format, filename }[]`，前端一律照它渲染下載選項，不寫死格式清單）。同一租戶同時只允許一份報告在跑，併發時會直接以對話回覆說明，不當錯誤處理。
4. **內容全部來自知識庫**：LLM 依主題先拆出章節大綱，再逐節各自查知識庫、彙整檢索到的片段——章節之間互不共享脈絡，杜絕拼湊出檢索之外的內容。**查無資料的章節會據實標示為查無相關資料，不臆測、不生內容**；若全部章節都零命中，整份報告視為 `empty` 終態，不產出任何檔案。
5. **圖表分兩種來源，圖說也據此分流**——差別在可信度，不能用同一句話帶過：
   - **精確圖**（`complete`）：來自試算表上傳後另外留存的結構化資料列（[`knowledge.tables.repo.ts`](server/src/modules/knowledge/knowledge.tables.repo.ts)，僅 `db` 後端）。章節 prompt 讓 LLM 用一個 `chart-ref` 程式碼區塊指名「哪張表、哪幾欄」，**數字由程式從原始儲存格算出**，圖下標出處與總列數。型別 `bar` / `line` / `pie` / `donut` / `grouped` 由 LLM 依語意提出，但**程式依資料形狀驗證並可覆寫**（107 個國家不會被畫成圓餅）。給 `tables` 可讓多張表各貢獻一個數列做跨表對比（標籤取交集，缺漏的年度整個略過而不補 0）。一節可有多張圖。
   - **節錄圖**：LLM 從檢索片段讀出的數列。檢索只取 top-k，所以它必然是節錄而非母體——圖說會明講這件事，散文說「根據檢索到的資料」讀者知道是節錄，長條圖不會自己這樣說話。
6. **收尾的「綜合觀察與建議」**（[`report.synthesis.ts`](server/src/modules/report/report.synthesis.ts)）：整份報告唯一有資格下結論的一節。各節不共享脈絡的代價是全篇沒有一處把跨檔案的數字讀成一件事，這節補上——**且只吃精確圖表的資料點**，不吃各節散文（餵散文等於讓結論長在轉述上，某節寫錯會被放大成整份報告的定論）。精確圖不足兩張、或這節的 LLM 失敗，就整節略過，不影響其餘章節，也不改動進度回報的分子分母。
7. **產出物保存 `REPORT_TTL_HOURS` 小時**（預設 720，即 30 天）後過期，下載會回 404；`DATA_BACKEND=db` 時產出物落地 Postgres（`report_docs`，見 `server/db/migrations/0007_report_docs.sql`），重啟後仍可下載，`file` 模式僅存於記憶體、重啟即失效。
8. **下載格式**：`md`（Markdown）、`html`，以及**探測到 Chromium 時才登錄的 `pdf`**（[`renderers/pdf.ts`](server/src/modules/report/renderers/pdf.ts) 把 html 產物交給 headless Chromium 印出，列印時網路全封——報告內文的 `![](http://…)` 圖片語法若由 server 去抓就是 SSRF，不是排版）。探測不到就不登錄，`?format=pdf` 誠實回 422，而不是給一個按了就壞的連結。格式清單由 [`report.render.ts`](server/src/modules/report/report.render.ts) 的 renderer 登錄表單一決定；新增格式只需在該登錄表加一行，路由白名單、副檔名、Content-Type、前端下載清單皆由此推導（`docx` / `xlsx` 的 renderer 仍在且有測試，只是刻意不登錄）。下載檔名為中文時走 RFC 5987（`Content-Disposition: ...; filename*=UTF-8''...`），並附 ASCII fallback 給不支援的舊瀏覽器。
9. **要輪詢到全部格式都落地才算完成**：`pdf` 是最後產、也最慢產的一個（實測比 `html` 晚 7～18 秒）。狀態查詢在「產出物數量未達本部署的格式數」且「未超過 90 秒渲染寬限期」前一律回 `composing`——否則前端一收到終態就停止輪詢，把當下那份殘缺的下載清單永久凍結住。

環境變數（`server/src/config/env.ts`）：

| 變數 | 預設 | 範圍 | 說明 |
|------|------|------|------|
| `REPORT_MAX_SECTIONS` | `6` | 1–12 | 大綱節數上限；每節各一次檢索＋一次彙整 LLM，節數直接決定一份報告的成本 |
| `REPORT_SECTION_TOP_K` | `5` | 1–20 | 每節交給彙整 LLM 的檢索片段數（與知識庫問答的 `FINAL_K` 同量級） |
| `REPORT_TTL_HOURS` | `720`（30 天） | 1–8760 | 產出物保存時數；報告沒有對應「對話結束」的生命週期終點，只能靠 TTL 回收。預設 30 天而非 24 小時，否則後台的報告查詢頁只看得到一天內的資料 |
| `REPORT_TIMEZONE` | `Asia/Taipei` | IANA 時區名 | 報告表頭產生時間的顯示時區。刻意不用伺服器本地時間——正式環境跑在 UTC，會把台北的 09:41 印成 01:41 |
| `REPORT_PDF_BROWSER` | 未設 | 執行檔路徑 | 印 PDF 用的 Chromium。未設時依序探測常見位置（容器的 `/usr/bin/chromium`、開發機的 Google Chrome）；找不到就只是少一種格式，`md` / `html` 照常產出。登錄表在啟動時決定，事後裝好瀏覽器要重啟才生效 |

報告表頭的產生時間以 `YYYY-MM-DD HH:mm:ss`（24 小時制）呈現，不用 ISO 8601——報告是給人讀的文件。

### 後台查詢（租戶 → 「報告」頁籤）

可依**時間區間**與**關鍵字**查詢該租戶留存的報告並下載。兩點使用上必須知道的限制：

- **能搜的只有檔名與使用者**。報告主題（`topic`）與產生進度只活在記憶體的 job 裡，重啟即失、沒有落地，所以搜不到；檔名是報告標題的 slug（如「產品分析報告」），實務上已能對應到大部分需求。
- **後台下載不比對建立者**——管理者本來就該能取得租戶內任何人的報告。正因為少了那道門，每次下載都會寫入稽核紀錄（誰、下載了誰的哪一份），可在「稽核」頁籤查到 `report.download`。跨租戶仍是硬邊界，一律 404。

已過期的報告不會列出：使用者端已經拿不到，後台列成可下載只會製造「點了才發現失敗」。

## 架構

> 🗺️ **平台目標架構、現況對照與演進觸發點見 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**——決定「要不要做某個平台機制」時查它，不重新辯論。

```
server/src/
  config/env.ts                 環境變數（含 LLM_ / KNOWLEDGE_ / REPORT_ / OA_）
  lib/llm/                      LLM provider 抽象 + Claude / OpenAI / local 實作（tool use + prompt caching）
  lib/embedding/                embedding provider 抽象（雲端 / 地端）
  lib/oa/                       OA 連接器抽象 + StubOAConnector + http 骨架
  modules/form/                 schema-core：型別 / Ajv 引擎 / loader / registry / 工具生成 / approvals（簽核關卡狀態）/ field-links（條款連結與明確同意）
  modules/conversation/         session store（記憶體 + file/db 持久化）+ slot-filling agent loop + 意圖分流 + REST
  modules/knowledge/            知識庫：檔案解析 / 切塊 / 索引（pgvector 或靜態索引）/ 檢索 + 重排 / 試算表結構化留存
  modules/report/               報告：大綱 → 逐節彙整（含圖表）→ 綜合節 → renderer 登錄表（md / html / pdf）
  modules/tenant/ authz/ usage/ 多租戶、scope 權限、用量與配額
  modules/leave/                請假最終驗證 → 送 OA + workflow
  modules/business-trip/        國內出差報銷最終驗證 → 送 OA + workflow
  modules/outing/               外出登記最終驗證 → 送 OA + workflow
client/src/
  api.ts                        對話 / 表單 / 報告 API client（型別取自 @hyagent/shared）
  App.tsx                       對話畫面 + 狀態管理
  FormView.tsx                  schema-driven 表單：依 field.component 渲染可編輯元件，依 layout 分組／多步驟
  ReportStatus.tsx              報告進度輪詢 + 下載彈窗（開啟時重新取一次格式清單）
shared/src/index.ts             前後端共用型別（Definition / FieldSpec / SessionStatus…）
schemas/<formId>/*.json         六層表單 Definition（前後端共用單一來源；現有 3 張表單）
```

**送出守門**：`submit` 只在「使用者上一輪已看到摘要（status=confirming）且本輪確認」時才執行，伺服器端硬守，LLM 無法跳過。確認畫面的手動編輯走 `PATCH /fields`，同樣經 `form.engine` 驗證後才存回 `session.values`，因此畫面所見即送出所送。

## 部署拓撲：前端 + BFF + 真 OA

這台 server 的**位置**像 gateway（前端的唯一入口、前端永不直接碰真 OA），但**職責**比薄 gateway 重得多——它擁有 schema、跑 LLM Agent、維護對話 session、做驗證，所以本質是 **BFF / 編排層（orchestration layer）**。

> 嚴格說 BFF 綁單一前端；本 server 還餵 admin、嵌入式 widget、SDK 等多個前端，故更精確是「application backend，同時扮演 BFF + 整合層」。「前端 + BFF」是夠用的心智模型。

**現況**：2 層，第三層真 OA 由 stub 假裝。

```text
[前端 client/widget/admin] ──HTTP──> [BFF：schema + LLM Agent + 驗證 + REST]
                                          └─ getOAConnector() → stubOAConnector（記憶體假資料、簽核以計時器模擬）
```

**上線後**：3 層，stub 換成真連接器。

```text
[前端] ──HTTP──> [BFF / 編排層] ──HTTP──> [真 OA 後端（公司系統，可在另一台伺服器）]
                      └─ getOAConnector() → httpOAConnector（真送單／查額度／查真實簽核狀態）
```

差別只在最後一步：環境變數 `OA_CONNECTOR=stub` 換成 `http`。連接器本身（[`lib/oa/http.connector.ts`](server/src/lib/oa/http.connector.ts)）已實作完成且**不需修改**——端點、送出欄位映射、回應解析全由各表單的 `schemas/<formId>/oa.schema.json` 驅動（見 [`oa.mapper.ts`](server/src/lib/oa/oa.mapper.ts)）。**前端、BFF 邏輯皆不動**，三層各自獨立部署。

**共用 schema 不會把前後端綁死**：schema JSON 只住後端（[`form.loader.ts`](server/src/modules/form/form.loader.ts) 以 `fs` 讀 `schemas/`），前端執行時用 `GET /api/forms/:formId` 取得 Definition，**bundle 內零張 schema**。前後端唯一共用的是 `@hyagent/shared` 的 TypeScript 型別，屬 build 期便利、runtime 會被編譯掉。

**gateway 典型該管的現況**：認證已接 JWT（dev 為 mock 名錄 + 共用密碼，上線前換真實身分來源）、session 已可持久化（`DATA_BACKEND=db`）、限流／配額已補齊（兩層守門：[`tenant-rate-limit.ts`](server/src/middlewares/tenant-rate-limit.ts) 依「租戶＋使用者」防突發轟炸、[`tenant-quota.ts`](server/src/middlewares/tenant-quota.ts) 依 `quotaMonthlyLlmTokens` 對照當月 usage 分桶做月配額，掛在會觸發 LLM 計費的 `/api/conversations`）；**尚未補**：真實身分來源（換掉 mock 名錄）——SSO 現況、五個待辦缺口與驗收清單見 [`docs/HANDOFF-SSO.md`](docs/HANDOFF-SSO.md)。

## 已實作 vs 延後

- ✅ schema-driven 引擎、對話 slot-filling、Claude 抽象、OA stub、確認送出、REST
- ✅ React 前端：對話畫面 + schema-driven 表單（依 `field.component` 渲染、依 `layout` 分組／多步驟、送出前可編輯）
- ✅ 多表單（請假／國內出差／外出登記）、workflow 簽核關卡狀態（Demo 以時間自動推進）
- ✅ 持久化後端切換：`DATA_BACKEND=db`（Prisma + Postgres/Supabase）涵蓋全部 10 個 runtime store（attachments / audit / forms / knowledge / scope-policy / sessions / submissions / tenants / usage / webhooks），另有僅 `db` 才有的報告產出物（`report_docs`）與試算表結構化資料列（`knowledge_tables`）
- ✅ 限流／配額：兩層守門（每租戶＋使用者速率限制 + 每租戶月度 LLM token 配額）
- ✅ 表單 Designer：admin 後台 [`FormDesignerPage`](admin/src/pages/FormDesignerPage.tsx) 建立／編輯／匯出租戶表單（走 `/api/admin/tenants/:id/forms`）
- ✅ OpenAI provider：[`lib/llm/openai.provider.ts`](server/src/lib/llm/openai.provider.ts)（Chat Completions + function calling；`local` 端點重用之）
- ✅ 報告：依知識庫檢索彙整成可下載文件（`md` / `html`，探測到 Chromium 時另有 `pdf`），含由結構化試算表算出的精確圖表（單表／跨表對比）與收尾的綜合觀察節；對話觸發、非同步產生，需另外授予 `service:report` scope（見「報告」一節）
- ✅ 條款連結與明確同意：`FieldSpec.links` 在欄位旁顯示可點擊條款（URL 僅允許 `http(s)://` 或單斜線起始的站內路徑，於 `validateDefinition` 擋下），`requiresTrue` 的欄位**必須由使用者親自勾選**——引擎不把 `false` 當已填，Agent 的欄位說明也明文禁止代為推定同意。後台表單 Designer 可設定，`client/public/legal/` 有三份示範條款頁
- 🔜 延後（架構留 seam）：真 OA HTTP 連接器——連接器與 schema 驅動的映射已完成，缺附件本體與真實簽核狀態查詢，見 [`docs/HANDOFF-OA-HTTP.md`](docs/HANDOFF-OA-HTTP.md)；本機可用 `node presale/oa-mock/server.mjs` 頂替真 OA 開發

## 可抽換層

- LLM：`LLM_PROVIDER`（目前 `anthropic`）— 換廠商只要新增 `lib/llm/<x>.provider.ts`
- 地端模型：`LLM_PROVIDER=local` + `LLM_BASE_URL` 指向自架 OpenAI 相容端點（vLLM / Ollama），資料不出機房；embedding 另以 `EMBEDDING_PROVIDER=local` + `EMBEDDING_BASE_URL` 地端化。選地端時絕不 fallback 回雲端。租戶亦可於後台「AI 模型」選「地端」（沿用部署層端點，租戶不自帶 URL）。
- 租戶 BYO key：每租戶可自帶 OpenAI / Anthropic API key 與 provider/model（`llmConfig`），未設定 fallback 平台 env 金鑰；用量按「模型 × key 來源」歸戶（`/api/admin/tenants/:id/usage` 含預估成本）。設定入口：sk_ 自助 `PUT /api/tenant/llm-config` 或 admin 後台「AI 模型」卡片。
- 持久化：`DATA_BACKEND`（`file` / `db`）— `file` 為記憶體 + JSON 檔（dev 預設）；`db` 為記憶體 + Postgres write-through（Prisma，`DATABASE_URL` 必填、boot fail-fast），涵蓋全部 10 個 runtime store（audit 於 DB 留全史、其餘與 file 同語意），store 介面不變；知識庫索引的兩種後端與檢索差異見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「知識庫檢索後端」。API key 只存 sha256 雜湊（簽發當下顯示一次）；設 `DATA_ENCRYPTION_KEY`（64 hex）後租戶 BYO LLM key 與 ssoSecret 以 AES-256-GCM 加密落地，舊明文資料開機自動補雜湊/加密。DDL 見 `server/db/migrations/`。
- OA：`OA_CONNECTOR`（`stub` / `http`）— `http` 連接器已實作（[`lib/oa/http.connector.ts`](server/src/lib/oa/http.connector.ts)）；切到 `http` 需設 `OA_BASE_URL`（boot 時 fail-fast 檢查）。真 OA 規格到位後**改的是 `schemas/<formId>/oa.schema.json`（端點路徑 / request 欄位映射 / 回應映射），不是連接器程式**。尚未涵蓋的三處（附件本體、真實簽核狀態查詢、`getLeaveBalance` 端點仍寫死於連接器）見 [`docs/HANDOFF-OA-HTTP.md`](docs/HANDOFF-OA-HTTP.md)
