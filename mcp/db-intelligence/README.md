# @hyagent/db-intelligence

讓 HyAgent 在受控權限內查詢客戶既有的關聯式資料庫，不必為每種問題開發業務 API。
模型只產生結構化 **Query Plan**（不是 SQL），由本服務驗證、套用政策、編譯成參數化 SQL，並在唯讀交易中執行。

規格：[`docs/db-intelligence/development-spec.md`](../../docs/db-intelligence/development-spec.md)；實作進度與規格對照：[`docs/db-intelligence/implementation-status.md`](../../docs/db-intelligence/implementation-status.md)。

## 流程

```text
HyAgent ──JWT──▶ MCP app（mcp-kit 驗簽）──▶ DbIntelligenceService
                                              │ PrincipalResolver：tenant/user 取自 JWT，角色／屬性取自可信目錄
                                              │ Validator：Plan 結構 → 資料來源/租戶 → 資料集/JOIN → 欄位/型別/運算子 → 聚合規則
                                              │ Policy：每個資料集需有「單一」政策完整允許其用法；帶入資料列範圍、遮罩、筆數上限
                                              │ Compiler：Catalog 識別字 + $n 參數 → SQL
                                              │ Executor：BEGIN READ ONLY + statement_timeout + 筆數/位元組上限
                                              └ 遮罩 → 結果快取（綁 tenant/user/政策版本/Catalog 版本/TTL）→ 稽核
```

| 模組 | 檔案 |
| --- | --- |
| 契約：錯誤碼、Catalog、Query Plan、政策 | `src/contracts/*` |
| Schema Discovery（PostgreSQL 系統目錄） | `src/catalog/postgresDiscovery.ts` |
| Catalog 同步／差異、審核、儲存、檢索 | `src/catalog/{sync,review,store,search}.ts` |
| Validator／Policy／Compiler／Executor | `src/query/*` |
| 協調流程、MCP 工具、HTTP app | `src/service.ts`、`src/tools.ts`、`src/app.ts` |
| 管理 API、執行期設定、連線池 | `src/admin.ts`、`src/state.ts`、`src/pools.ts` |

## 快速開始（Demo）

```bash
# 1. Demo DB（postgres:17，port 54330；含唯讀帳號 hyagent_reader）
npm run demo-db -w mcp/db-intelligence

# 2. 掃描 → 審核並發布（Catalog 存在 mcp/db-intelligence/data/，不進版控）
export DBI_DS_PROJECT_01_URL=postgres://hyagent_reader:reader_dev_only@localhost:54330/projects
npm run catalog:sync -w mcp/db-intelligence -- ds_project_01
npm run catalog:review -w mcp/db-intelligence -- ds_project_01 config/demo-review.json

# 3. 啟動 MCP server（port 4300）
HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json MCP_SERVER_ID=db-intelligence \
  npm start -w mcp/db-intelligence
```

在 HyAgent 後台「MCP 服務」登記 `serverId=db-intelligence`、URL `http://localhost:4300/mcp`，並授予 `mcp:db-intelligence`。
Demo 設定（`config/demo.json`）的租戶 ID 是 `demo`，使用者為 `alice`（員工，數位研發部）、`bob`（主管）、`hana`（HR）；
接真實 HyAgent 時，以管理 API 把資料來源、政策、使用者目錄改成實際的 tenant／user（見下方「管理 API」）。

**角色來源**：使用者目錄的 `roles`，加上 JWT scope 推導的角色——在 HyAgent 後台把 `mcp:db-intelligence:manager`
授予部門或帳號，該使用者就有 `manager` 角色。資料列範圍用的屬性（如 `departmentId`）目前只來自使用者目錄。

| 環境變數 | 說明 |
| --- | --- |
| `DBI_DATA_DIR` | 執行期設定 `state.json` 與 Catalog 的目錄，預設 `data` |
| `DBI_CONFIG` | `state.json` 不存在時的種子設定，預設 `config/demo.json` |
| `MCP_SERVER_ID` | 在 HyAgent 登記的 serverId（JWT 受眾、scope 推導角色），預設 `db-intelligence` |
| 各資料來源的 `connectionEnv` | 連線字串（設定檔不放密碼，由 Secret Manager 注入） |
| `DBI_STATEMENT_TIMEOUT_MS` | 單次查詢逾時，預設 10000 |
| `DBI_POOL_MAX` | 每個資料來源的連線數上限，預設 5 |

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `search_schema` | 依問題搜尋**呼叫者可見**的資料集、欄位、指標、關聯，附今天日期與時區 |
| `get_dataset_details` | 單一資料集的欄位型別、可用運算子、主鍵、關聯 |
| `execute_safe_query` | 執行 Query Plan，回傳第一頁、`warnings` 與查詢依據 `basis` |
| `get_query_result` | 以 `result_id` + `next_cursor` 取下一頁 |

Query Plan 範例（「哪些專案超時 20%」）：

```json
{
  "version": "1.0",
  "data_source_id": "ds_project_01",
  "dataset": "projects",
  "select": [{ "field": "name" }, { "field": "actual_hours_over_estimated_ratio", "alias": "ratio" }],
  "filters": [
    { "field": "start_date", "op": "gte", "value": "2026-01-01" },
    { "field": "actual_hours_over_estimated_ratio", "op": "gt", "value": 1.2 }
  ],
  "order_by": [{ "field": "ratio", "direction": "desc" }],
  "limit": 100
}
```

計算指標（如上例的 ratio）與一般欄位同樣用 `field` 引用；只能使用 Catalog 中已核准的指標。
join 進來的資料集欄位加 `"dataset": "departments"`。完整格式見 `src/contracts/queryPlan.ts`。

## 管理 API

平台管理員在 HyAgent 後台操作，HyAgent server 驗證管理員、記稽核後轉發（`/api/admin/db-intelligence/<serverId>/...` →
本服務 `/admin/...`）。本服務只接受 HyAgent 簽發、帶 `hyagent:admin` scope 的系統 JWT。
資料來源、政策、Catalog 都存在本服務（客戶端），HyAgent 平台不保存客戶資料庫結構。

| Method | Path（本服務 `/admin` 之下） | 用途 |
| --- | --- | --- |
| GET | `/data-sources?tenant_id=` | 資料來源列表，附 Catalog 摘要與連線字串是否已設定 |
| PUT／DELETE | `/data-sources/:id` | 新增或修改（不接收密碼，只填 `connectionEnv` 變數名）／刪除 |
| POST | `/data-sources/:id/connection-test` | 連線測試：版本、是否預設唯讀、**帳號仍可寫入的物件**（應為空） |
| POST | `/data-sources/:id/schema-sync` | 掃描並回傳差異 |
| GET／PATCH | `/data-sources/:id/catalog` | 取得 Catalog（含原始註解，供審核）／套用審核（格式同 `config/demo-review.json`） |
| GET／PUT | `/tenants/:tenantId/policies` | 租戶的存取政策（整包取代，回傳與 Catalog 對不上的警告） |
| GET／PUT | `/tenants/:tenantId/principals` | 租戶的使用者目錄（角色與資料列範圍屬性） |
| POST | `/query/preview` | 以指定使用者身分（可模擬 scope）預覽 Query Plan 的 SQL、參數與套用的政策，不執行 |
| GET | `/audit?request_id=&tenant_id=&status=&limit=` | 最近的查詢稽核（記憶體保留 5000 筆；長期保存看 stdout log） |

CLI（`catalog:sync`、`catalog:review`）仍可用於本機開發。

## 管理 Catalog 與政策

- **掃描**（`catalog:sync`）：只查系統目錄、不讀資料列；只收唯讀帳號有 SELECT 權限的物件。新資料集 `pending`、新欄位 `isQueryable=false`、型別變更退回不可查、引用被改欄位的指標退回待審。DB 外鍵自動核准，人工關聯需審核。
- **審核**（`catalog:review`，格式見 `config/demo-review.json`）：核准資料集、開放欄位、設定敏感度與業務描述、定義指標、發布。DB 原始註解只供管理員參考，模型只看得到核准過的描述。
- **政策**（`PUT /admin/tenants/:tenantId/policies`）：預設拒絕。`columns: ["*"]` 只涵蓋 public／internal 欄位；`rowScope` 以可信身分屬性限制資料列；`masked` 欄位只能直接顯示；`aggregateOnly` + `minGroupSize` 用於機敏統計。

## 測試

```bash
npm test -w mcp/db-intelligence          # 單元＋HTTP 測試（不需 DB）

# 真實 PostgreSQL 整合測試
npm run demo-db -w mcp/db-intelligence
DBI_TEST_READER_URL=postgres://hyagent_reader:reader_dev_only@localhost:54330/projects \
DBI_TEST_OWNER_URL=postgres://dbi_owner:owner_dev_only@localhost:54330/projects \
  npm test -w mcp/db-intelligence
```
