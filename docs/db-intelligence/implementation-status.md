# Database Intelligence 實作進度（對照開發規格書 v0.1）

> 程式：[`mcp/db-intelligence`](../../mcp/db-intelligence/README.md)　規格：[`development-spec.md`](development-spec.md)　更新：2026-10-29

## 已決定的事項（規格書 §12）

| # | 問題 | 本 branch 的做法 |
| --- | --- | --- |
| 1 | 後端語言、MCP Client 位置 | TypeScript／Node.js。HyAgent server 已有 MCP Client，以 ES256 JWT 呼叫自建 MCP server；本服務沿用 `@hyagent/mcp-kit` 驗簽，tenant／user 取自 JWT |
| 3 | 第一版 DB | PostgreSQL（Adapter 介面預留 MSSQL／MySQL） |
| 4 | 權限來源 | 角色＝使用者目錄 ∪ HyAgent JWT scope（`mcp:<serverId>:<role>`，沿用後台部門／帳號授權）；資料列範圍屬性來自使用者目錄。之後可換成 OA API 或 IAM，同一個 `PrincipalResolver` 介面 |
| 5 | 是否採樣真實資料 | 否。Discovery 只查系統目錄 |
| 6 | 結果快取 | 程序內記憶體，綁 tenant／user／政策版本／Catalog 版本，TTL 10 分鐘，上限 500 筆；未加密（不落地） |

**仍待決策：** #2（完全地端模式、雲端模型可否收查詢結果）、#7（客戶能否自備 View／指標）。

## Sprint 對照

| Sprint | 項目 | 狀態 |
| --- | --- | --- |
| 0 | Auth Context（Identity Assertion → JWT → Principal） | ✅ `service.ts` `PrincipalResolver` |
| 0 | Query Plan JSON Schema v1、錯誤碼 | ✅ `contracts/queryPlan.ts`、`contracts/errors.ts` |
| 0 | Policy 規則：資料集、欄位、資料列、輸出 | ✅ `contracts/policy.ts`、`query/policy.ts` |
| 0 | 測試 DB、敏感欄位、唯讀帳號 | ✅ `infra/demo.sql`、`infra/docker-compose.yml` |
| 0 | 威脅模型文件 | ⬜ 測試已涵蓋 §7.4，獨立文件待補 |
| 1 | PostgreSQL Adapter：系統目錄掃描、PK／FK／索引／註解 | ✅ `catalog/postgresDiscovery.ts` |
| 1 | 連線測試（含檢查帳號是否仍有寫入權限） | ✅ `pools.ts` `testConnection` |
| 1 | Connector 安全通道（mTLS／出站連線）與遠端 Credential 管理 | ⬜ 目前 Executor 與 MCP server 同程序部署（需部署在客戶端），連線字串由環境變數注入 |
| 1 | Catalog 版本、差異 | ✅ `catalog/sync.ts`（檔案儲存 `catalog/store.ts`；DB migration 待做） |
| 1 | Admin API | ✅ MCP 端 `admin.ts`；HyAgent server 轉發 `server/src/modules/db-intelligence/`（requireAdmin＋稽核） |
| 1 | 後台 UI | ⬜ |
| 2 | Validator（運算子、型別、聚合、排序、JOIN） | ✅ `query/validator.ts` |
| 2 | Policy Engine ＋ 資料列範圍、遮罩、僅聚合、最小群組 | ✅ |
| 2 | 推論攻擊：限制反覆縮小條件的查詢（差分攻擊） | ⬜ `minGroupSize` 只保證每組筆數，擋不了「全體 − 排除某人」的差分；需依使用者追蹤近期查詢條件 |
| 2 | SQL Compiler（參數化） | ✅ `query/compiler.ts` |
| 2 | Executor（唯讀交易、timeout、筆數／位元組上限） | ✅ `query/executor.ts` |
| 2 | Audit Logging | ✅ `audit.ts`（stdout JSON＋記憶體最近 5000 筆供管理 API 查詢；持久化 sink 待做） |
| 3 | MCP Tools：search_schema、get_dataset_details、execute_safe_query、get_query_result | ✅ `tools.ts`、`app.ts` |
| 3 | Metadata 檢索 | ✅ 關鍵字＋中文二字詞（100+ 表時的效能與向量檢索待評估） |
| 3 | `plan_query`／Planner Prompt | ⬜ 目前由 HyAgent 的 Agent 依工具說明直接產生 Query Plan |
| 3 | 歧義處理、低信心拒答 | 🟡 工具說明要求不猜測；未定義指標回 `QUERY_FIELD_NOT_ALLOWED`／`QUERY_METRIC_UNDEFINED`。尚無信心分數 |
| 3 | 自然語言端對端測試（10 個案例） | ⬜ 需接上 HyAgent 實際跑模型 |
| 4 | 指標、效能、滲透測試、試點 | ⬜ |

## §7.4 威脅測試對照

| 測試 | 結果 | 測試位置 |
| --- | --- | --- |
| 一般員工詢問全公司薪資 | 拒絕（`QUERY_POLICY_DENIED`）並留稽核 | `service.test.ts`、`query.test.ts` |
| Plan 指定另一租戶資料來源 | 拒絕，與不存在的資料來源同一錯誤 | `query.test.ts` |
| 欄位註解含「忽略規則」 | 原始註解不交給模型，只回核准描述 | `service.test.ts`、整合測試 |
| 非法欄位／未核准 JOIN | Validator 拒絕；沒權限者無法藉錯誤探測欄位 | `query.test.ts` |
| SQL 注入字串 | 值走參數、識別字只認 Catalog、別名白名單 | `query.test.ts` |
| 超大量／長時間查詢 | 筆數、位元組截斷；逾時回 `QUERY_TIMEOUT`；寫入被唯讀交易擋下 | 整合測試 |
| Schema 新增敏感欄位 | 預設不可查 | `catalog.test.ts`、整合測試 |
| 快取跨使用者讀取 | 拒絕（含跨租戶、政策／Catalog 版本變更） | `service.test.ts` |

## 與規格書的差異

- **計算指標的引用方式**：規格書範例用 `{ "expression": "..." }`，實作與一般欄位統一用 `field`（Validator 先找欄位再找已核准指標），模型只需學一種寫法。
- **外鍵關聯自動核准**：規格書 §6.2 只要求「無 FK 的推論 JOIN」人工核准；DB 外鍵關聯掃描後即為 `approved`（兩端資料集仍需核准，欄位仍需政策允許）。
- **資料存放位置**：規格書 §6.1 的 Catalog／政策資料表放在 HyAgent 平台；實作改為存在客戶端的 MCP server（`state.json`＋Catalog 檔），HyAgent server 的管理 API 只轉發，客戶資料庫結構不離開客戶端。
- **`request_id`**：由服務端產生；模型帶的 `request_id` 只記為 `client_request_id` 供對照。
- **多政策組合**：同一資料集有多條政策時，必須由**單一**政策完整允許該查詢的用法，不做欄位／範圍聯集，避免「部門明細」＋「全公司僅聚合」被拼成「全公司明細」。
