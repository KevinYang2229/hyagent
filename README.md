# OA Agent（MVP）

對話式 OA 表單填寫 Agent。員工用自然語言描述需求，Agent 透過對話補齊欄位（slot-filling）、驗證、請使用者確認後送出。**已內建三張表單：請假單（leave-request）、國內出差報銷（business-trip-domestic）、外出登記（outing-registration）**，schema-driven、Claude 驅動、OA 以 stub 模擬。

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
oa-agent/
├─ schemas/            前後端共用：六層表單 JSON Definition（單一來源）
├─ shared/             前後端共用：TS 型別（Definition / FieldSpec / SessionStatus…）
├─ ui/                 設計系統元件庫 @oa-agent/ui（前端共用、純展示）
├─ server/             後端 Express（schema 引擎 + 對話 Agent + REST）
└─ client/             前端 Vite + React + TS（對話 + schema-driven 表單）
```

`server` 與 `client` 都 import `@oa-agent/shared`，型別不再各寫一份。

### 設計系統與 schema-driven 渲染

表單元件由 schema 的 `field.component` 決定，透過一張 registry 對應到 `@oa-agent/ui` 的元件：

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
@import "@oa-agent/ui/styles.css"; /* ← 元件共用 token + base */
```

（`@oa-agent/ui/styles.css` 對應 `ui/src/styles.css`，於 ui 的 package.json `exports` 宣告。）

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

# 3. 啟動（兩個終端機）
npm run dev:server   # 後端 http://localhost:3000
npm run dev:client   # 前端 http://localhost:5173

# 4.（離線）驗證 schema 引擎，不需 key
npm run smoke

# build / typecheck 全部 workspace
npm run build
npm run typecheck
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

> 對話 API 需 JWT：先 `POST /api/auth/login`（dev 環境為 mock 帳號 `kevin`/`hyweb` + `AUTH_DEV_PASSWORD`）取得 accessToken，之後帶 `Authorization: Bearer <token>`。widget/SDK 另可走租戶 `ssoSecret` 的 SSO handoff（`/api/auth/sso/exchange`）。

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

## 架構

```
server/src/
  config/env.ts                 環境變數（含 LLM_/OA_）
  lib/llm/                      LLM provider 抽象 + Claude 實作（tool use + prompt caching）
  lib/oa/                       OA 連接器抽象 + StubOAConnector
  modules/form/                 schema-core：型別 / Ajv 引擎 / loader / registry / 工具生成 / approvals（簽核關卡狀態）
  modules/conversation/         session store（記憶體 + file/db 持久化）+ slot-filling agent loop + REST
  modules/leave/                請假最終驗證 → 送 OA + workflow
  modules/business-trip/        國內出差報銷最終驗證 → 送 OA + workflow
  modules/outing/               外出登記最終驗證 → 送 OA + workflow
client/src/
  api.ts                        對話 / 表單 API client（型別取自 @oa-agent/shared）
  App.tsx                       對話畫面 + 狀態管理
  FormView.tsx                  schema-driven 表單：依 field.component 渲染可編輯元件，依 layout 分組／多步驟
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

差別只在最後一步：環境變數 `OA_CONNECTOR=stub` 換成 `http`、實作 `lib/oa/http.connector.ts`。**前端、schema、BFF 邏輯皆不動**，三層各自獨立部署。

**共用 schema 不會把前後端綁死**：schema JSON 只住後端（[`form.loader.ts`](server/src/modules/form/form.loader.ts) 以 `fs` 讀 `schemas/`），前端執行時用 `GET /api/forms/:formId` 取得 Definition，**bundle 內零張 schema**。前後端唯一共用的是 `@oa-agent/shared` 的 TypeScript 型別，屬 build 期便利、runtime 會被編譯掉。

**gateway 典型該管的現況**：認證已接 JWT（dev 為 mock 名錄 + 共用密碼，上線前換真實身分來源）、session 已可持久化（`DATA_BACKEND=db`）；**尚未補**：限流／配額（對話會按 token 計費）。

## 已實作 vs 延後

- ✅ schema-driven 引擎、對話 slot-filling、Claude 抽象、OA stub、確認送出、REST
- ✅ React 前端：對話畫面 + schema-driven 表單（依 `field.component` 渲染、依 `layout` 分組／多步驟、送出前可編輯）
- ✅ 多表單（請假／國內出差／外出登記）、workflow 簽核關卡狀態（Demo 以時間自動推進）
- ✅ 持久化後端切換：`DATA_BACKEND=db`（Prisma + Postgres/Supabase）涵蓋全部 8 個 runtime store（tenant / sessions / submissions / usage / audit / forms / scope-policy / webhooks）
- 🔜 延後（架構留 seam）：表單 Designer、真 OA HTTP 連接器（含真實簽核狀態查詢）、知識庫索引上 pgvector、OpenAI provider、報告產出

## 可抽換層

- LLM：`LLM_PROVIDER`（目前 `anthropic`）— 換廠商只要新增 `lib/llm/<x>.provider.ts`
- 地端模型：`LLM_PROVIDER=local` + `LLM_BASE_URL` 指向自架 OpenAI 相容端點（vLLM / Ollama），資料不出機房；embedding 另以 `EMBEDDING_PROVIDER=local` + `EMBEDDING_BASE_URL` 地端化。選地端時絕不 fallback 回雲端。租戶亦可於後台「AI 模型」選「地端」（沿用部署層端點，租戶不自帶 URL）。
- 租戶 BYO key：每租戶可自帶 OpenAI / Anthropic API key 與 provider/model（`llmConfig`），未設定 fallback 平台 env 金鑰；用量按「模型 × key 來源」歸戶（`/api/admin/tenants/:id/usage` 含預估成本）。設定入口：sk_ 自助 `PUT /api/tenant/llm-config` 或 admin 後台「AI 模型」卡片。
- 持久化：`DATA_BACKEND`（`file` / `db`）— `file` 為記憶體 + JSON 檔（dev 預設）；`db` 為記憶體 + Postgres write-through（Prisma，`DATABASE_URL` 必填、boot fail-fast），涵蓋全部 8 個 runtime store（audit 於 DB 留全史、其餘與 file 同語意），store 介面不變；知識庫索引（pgvector）另案。API key 只存 sha256 雜湊（簽發當下顯示一次）；設 `DATA_ENCRYPTION_KEY`（64 hex）後租戶 BYO LLM key 與 ssoSecret 以 AES-256-GCM 加密落地，舊明文資料開機自動補雜湊/加密。DDL 見 `server/db/migrations/`。
- OA：`OA_CONNECTOR`（`stub` / `http`）— `http` 連接器骨架已就緒（[`lib/oa/http.connector.ts`](server/src/lib/oa/http.connector.ts)）；切到 `http` 需設 `OA_BASE_URL`（boot 時 fail-fast 檢查）。真 OA 規格到位後只需調整檔內三個「對接點」（端點路徑 / request body 映射 / 回應映射）
