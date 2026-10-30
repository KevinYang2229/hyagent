# 接入新資料庫：操作手冊

> 對象：為客戶導入 Database Intelligence 的平台管理員／導入工程師　更新：2026-10-30
> 相關：[規格書](development-spec.md)、[實作進度](implementation-status.md)、[服務 README](../../mcp/db-intelligence/README.md)

讓 HyAgent 的 AI 在受控權限內查詢一個既有的 PostgreSQL 資料庫。整個流程分兩層權限，**兩層都要設**才查得到資料：

| 層 | 設定位置 | 決定什麼 |
| --- | --- | --- |
| HyAgent 授權 | 後台 → 租戶 →「權限」分頁 | 誰能用這個服務、帶什麼角色 |
| 資料存取政策 | 後台 → 租戶 →「資料庫查詢」分頁 | 某角色能查哪些表、欄位、資料列 |

預設一律拒絕：掃描完成不代表可以查。沒有核准的資料集、沒勾可查詢的欄位、沒有政策涵蓋的角色，AI 都查不到。

---

## 一、前置條件

- [ ] 資料庫是 **PostgreSQL**（MySQL／SQL Server 尚未支援）。
- [ ] db-intelligence 服務部署在**看得到資料庫**的網路內（通常是客戶端），並已在 HyAgent 後台「MCP 服務」登記。首次登記見第七節。
- [ ] HyAgent server 已設定 `MCP_SIGNING_KEY`。「MCP 服務」頁的狀態應為「正常」。

## 二、資料庫端：建立唯讀帳號（DBA 執行）

```sql
CREATE ROLE hyagent_reader LOGIN PASSWORD '強密碼';
ALTER ROLE hyagent_reader SET default_transaction_read_only = on;
ALTER ROLE hyagent_reader SET statement_timeout = '30s';
GRANT CONNECT ON DATABASE erp TO hyagent_reader;
GRANT USAGE ON SCHEMA public TO hyagent_reader;
-- 逐表授權，不要用 ON ALL TABLES：未授權的表在掃描時完全看不到
GRANT SELECT ON public.orders, public.customers, public.products TO hyagent_reader;
```

建議：

| 項目 | 建議 |
| --- | --- |
| 授權範圍 | 只授權要開放的表。這是第一道、也是最可靠的範圍控管 |
| 敏感資料 | 只想開放部分欄位或部分資料列時，建 View（如 `v_orders_summary`）並只授權 View |
| 寫入權限 | 帳號不得有 INSERT／UPDATE／DELETE。後台「連線測試」會列出仍可寫入的物件，結果必須為空 |
| 連線 | 遠端資料庫使用 TLS（連線字串加 `sslmode=require`），並限制來源 IP |
| 負載 | 可行的話連到 Read Replica |

## 三、服務端：設定連線字串

在 db-intelligence 的 `.env`（本機為 `mcp/db-intelligence/.env`，正式環境由 Secret Manager 注入）加入：

```bash
DBI_DS_ERP_URL=postgres://hyagent_reader:密碼@db-host:5432/erp?sslmode=require
```

- 變數名稱自訂，限英數與底線。後台只填**變數名稱**，密碼不會經過 HyAgent，也不會出現在設定檔、Catalog 或 log。
- 新增或修改後要**重新啟動 db-intelligence**，`.env` 只在啟動時讀取。

## 四、後台：登記資料來源

後台 → 租戶 →「資料庫查詢」→「資料來源」→「新增資料來源」

| 欄位 | 範例 | 規則 |
| --- | --- | --- |
| 資料來源 ID | `ds_erp` | 英數、底線、連字號，64 字內；建立後不可修改，也不能改綁其他租戶 |
| 連線字串環境變數 | `DBI_DS_ERP_URL` | 第三節的變數名稱 |
| 允許掃描的 Schema | `public` | 逗號分隔；範圍外的 Schema 不會被掃描 |
| 時區 | `Asia/Taipei` | AI 換算「今年」「上個月」用 |

儲存後依序執行：

1. **連線測試**：應顯示「連線成功」。若出現「此帳號仍可寫入：…」，回第二節收回權限。
2. **掃描 Schema**：只讀系統目錄，不讀資料列。完成後顯示新增的資料集、欄位、關聯數量。

只想掃描 Schema 中的部分表時，優先用第二節的帳號授權控制。另有 `includeObjects`（如 `["public.orders"]`），目前只能透過管理 API 設定。

## 五、Catalog 審核與發布

「資料庫查詢」→「Catalog 審核」→ 選資料來源。

| 設定 | 預設值 | 該怎麼設 |
| --- | --- | --- |
| 資料集審核狀態 | 待審 | 要開放的改「核准」；不開放的維持待審或改拒絕 |
| 欄位「可查詢」 | 全部不勾 | 只勾需要的欄位。JSON、陣列、二進位等型別不支援查詢 |
| 敏感度 | 內部 | 見下方「敏感度等級」 |
| 業務描述 | 空白 | **務必填寫**。AI 只看得到這裡的描述，看不到資料庫原始註解。代碼欄位要寫出意義，例如「訂單狀態：1 待處理、2 已出貨、9 取消」 |
| 同義詞 | 空白 | 使用者的說法，例如資料表 `orders` 填「訂單、銷貨單」，幫助 AI 找到正確的表 |
| JOIN 關聯 | 外鍵自動核准 | 不該讓 AI 串接的外鍵可改為拒絕 |

### 敏感度等級

| 等級 | 適用 | 政策 `"*"` 涵蓋 | 開放時 | 查詢限制 |
| --- | --- | --- | --- | --- |
| 公開 | 可對外公開的資訊（部門名稱、產品名稱） | ✅ | — | 無 |
| 內部（預設） | 一般營運資料（專案、工時、日期） | ✅ | — | 無 |
| 機密 | 特定角色才能看的營運資料（金額、成本、客戶聯絡方式） | ❌ 須逐欄列出 | 儲存政策時要確認 | 依政策；查詢稽核標記「敏感欄位」 |
| 限制 | 個資、法規管制資料（薪資、身分證號、病歷） | ❌ 須逐欄列出 | 儲存政策時要確認 | **不論政策怎麼寫**：只能做筆數、加總、平均等統計且每組至少 3 筆；不能取最大／最小值；不能用於篩選、分組、排序；只有政策設定遮罩時才能顯示；不能透過計算指標直接顯示 |

「限制」的規則由系統強制，用來防止政策寫錯時外洩明細。能不開放就不開放：不勾「可查詢」，或在資料庫層不授權給唯讀帳號。

完成後按「儲存審核」，再按「**發布**」。未發布的 Catalog 不能查詢。之後再次掃描時，新增的欄位一律不可查詢、型別變更的欄位會退回不可查詢，已發布狀態則保留。

### 計算指標、無外鍵的關聯（目前用審核檔）

AI 不能自行組 SQL 運算式。像「毛利率」這類計算，要先由管理員定義成指標。後台目前只能檢視指標，新增要寫審核檔，在服務目錄執行：

```bash
cd mcp/db-intelligence && npm run catalog:review -- ds_erp review-erp.json
```

`review-erp.json` 範例：

```json
{
  "datasets": [
    {
      "id": "public.orders",
      "metrics": [
        {
          "key": "gross_margin_ratio",
          "description": "毛利率＝毛利 ÷ 營收",
          "synonyms": ["毛利率"],
          "expression": { "op": "div", "args": [{ "column": "gross_profit" }, { "column": "revenue" }] }
        }
      ]
    }
  ],
  "addRelationships": [
    {
      "from": { "dataset": "public.orders", "columns": ["sales_rep_code"] },
      "to": { "dataset": "public.employees", "columns": ["code"] },
      "approvalStatus": "approved"
    }
  ]
}
```

- 指標只能使用同一資料集的**數值**欄位，支援加減乘除（`add`、`sub`、`mul`、`div`）；除以零會得到空值。
- 審核檔立即生效，不必重啟。格式參考 `mcp/db-intelligence/config/demo-review.json`。

## 六、存取政策

「資料庫查詢」→「存取政策」。可按「插入範本」產生骨架。

```json
[
  {
    "id": "sales-own-region-orders",
    "tenantId": "default",
    "dataSourceId": "ds_erp",
    "dataset": "public.orders",
    "principals": { "roles": ["sales"], "users": [] },
    "columns": ["*"],
    "rowScope": [{ "column": "region_code", "attribute": "regionCode" }],
    "masked": { "customer_phone": "partial" },
    "maxRows": 200
  },
  {
    "id": "manager-orders-statistics",
    "tenantId": "default",
    "dataSourceId": "ds_erp",
    "dataset": "public.orders",
    "principals": { "roles": ["manager"], "users": [] },
    "columns": ["region_code", "amount", "order_date"],
    "aggregateOnly": true,
    "minGroupSize": 5
  }
]
```

| 欄位 | 說明 |
| --- | --- |
| `dataset` | `schema.表名`，與 Catalog 審核頁顯示的 ID 相同 |
| `principals` | 符合任一角色或任一帳號即適用 |
| `columns` | 允許的欄位；`"*"` 只涵蓋公開、內部欄位 |
| `rowScope` | 資料列範圍：欄位值必須等於使用者的屬性（屬性為陣列時視為「其中之一」）。屬性取自下方使用者目錄；使用者沒有該屬性時這條政策不適用，沒有其他政策允許就會被拒絕 |
| `masked` | 遮罩欄位：只能顯示（`redact` 全遮、`partial` 保留頭尾），不能用來篩選、排序、分組或計算 |
| `aggregateOnly` + `minGroupSize` | 只能做統計，且每組至少 N 筆，用於薪資等機敏資料 |
| `maxRows` | 單次最多回傳筆數，系統上限為 1000 |

注意：

- 一個查詢必須由**單一**政策完整允許。多條政策不會合併成更大的權限。
- 政策**新開放**了機密或限制欄位時，儲存前會跳出清單要求確認（直接呼叫 API 未確認會回 409）。未變動的既有授權不會重複詢問。
- 儲存後若出現「沒有欄位 xxx」之類的警告，代表政策引用了 Catalog 不存在的欄位。這不會阻擋儲存，但請修正。
- 下方「使用者目錄」用來設定資料列範圍需要的屬性，格式：

  ```json
  { "hyweb": { "roles": ["sales"], "attributes": { "regionCode": "N" } } }
  ```

  帳號要與 HyAgent 登入的使用者 ID 相同。

所有設定存在 db-intelligence 的 `data/state.json`。之後一律從後台修改；直接編輯檔案要重啟服務才生效。

## 七、HyAgent 授權

### 首次登記服務（每個 db-intelligence 部署做一次）

後台 →「MCP 服務」→ 新增：

| 欄位 | 範例 |
| --- | --- |
| serverId | `db-intelligence`（必須與服務的 `MCP_SERVER_ID` 相同） |
| URL | `https://dbi.客戶網域/mcp` |
| 能力描述 | 查詢公司 ERP 中的訂單、客戶、產品與業績資料。AI 依此決定何時使用 |
| 路由關鍵字 | 訂單、業績、客戶、產品 |
| 角色 | `sales, manager`：政策裡用到的角色都要在這裡宣告，才能在權限分頁授予 |

儲存後按「重新整理」，應出現 4 個工具。**每個都勾「核准唯讀」**，否則每次查詢都會跳出確認卡片。

新的資料表若讓服務涵蓋了新主題，記得更新「能力描述」與「路由關鍵字」，否則相關問題可能不會被分派給 AI 代理。

### 授予使用者（租戶 →「權限」分頁）

每位要使用的人（或部門）需要**三類**權限：

| 權限（畫面名稱） | scope | 說明 |
| --- | --- | --- |
| 智慧代理 | `service:agent` | **必要**。MCP 工具透過智慧代理呼叫；缺這項時 AI 會說「尚未開通任何可用服務」 |
| （服務名稱） | `mcp:db-intelligence` | 可使用這個服務 |
| （服務名稱）：角色 | `mcp:db-intelligence:sales` | 角色；只授予角色不會開放服務 |

角色也可以改寫在第六節的使用者目錄。兩者會取聯集。

## 八、驗證

1. **查詢預覽**（「資料庫查詢」→「查詢預覽」）：以實際使用者帳號，並在 scope 填入該使用者的角色 scope，預覽一個查詢。確認套用的政策、資料列範圍、SQL 都符合預期。
2. **對話前台**：以該使用者登入實際提問，至少涵蓋：
   - 一般查詢、統計查詢
   - 應被資料列範圍限制的查詢（例如「我的區域」）
   - 應被拒絕的查詢（例如查詢未開放的表）
   - 沒有定義的指標：AI 應該反問，而不是自行計算
3. **查詢稽核**（「資料庫查詢」→「查詢稽核」）：確認每次查詢的使用者、政策、筆數、狀態都正確。

## 九、常見問題

| 現象 | 原因與處理 |
| --- | --- |
| 對話前台無法登入 | 帳密登入只認該租戶「使用者目錄」中的帳號；目錄有任何帳號時，內建的開發帳號（kevin、hyweb）就失效。密碼是 server `.env` 的 `AUTH_DEV_PASSWORD` |
| AI 回「尚未開通任何可用服務」 | 缺「智慧代理」。另請確認「MCP 服務」狀態為「正常」、已啟用，且擁有租戶是空白或本租戶 |
| AI 回「此查詢超出可存取資料範圍」 | 使用者沒有適用的政策。最常見的是沒授予角色 scope，或政策的角色名稱打錯。用「查詢預覽」帶入角色 scope 比對 |
| AI 回「找不到可查詢的資料集」 | 資料集未核准，或 Catalog 未發布 |
| AI 說沒有這類資料／沒有用到資料庫 | 使用者缺 `mcp:db-intelligence`；或描述、關鍵字沒涵蓋這個主題，導致問題沒被分派給 AI 代理 |
| 權限分頁找不到「服務：角色」選項 | 「MCP 服務」登記時沒有宣告該角色 |
| 每次查詢都跳確認卡片 | 工具未「核准唯讀」 |
| 資料來源顯示「連線字串未設定」 | 服務 `.env` 沒有該變數，或改完沒重啟 |
| MCP 服務狀態「驗證失敗」 | server 未設定 `MCP_SIGNING_KEY` 或改完沒重啟；或服務的 `HYAGENT_JWKS_URL`、`MCP_SERVER_ID` 與登記不符 |
| AI 答錯欄位意義、找錯表 | 補強 Catalog 的業務描述與同義詞，這是改善答案品質最有效的方式 |

## 附錄：設定清單

| # | 項目 | 在哪裡 | 完成 |
| --- | --- | --- | --- |
| 1 | 唯讀帳號、逐表授權、連線加密 | 資料庫 | ☐ |
| 2 | 連線字串環境變數，重啟服務 | db-intelligence `.env` | ☐ |
| 3 | 資料來源（ID、變數名、Schema、時區） | 後台 → 資料庫查詢 → 資料來源 | ☐ |
| 4 | 連線測試通過，無可寫入物件 | 同上 | ☐ |
| 5 | 掃描 Schema | 同上 | ☐ |
| 6 | 核准資料集、勾選欄位、敏感度、業務描述、同義詞 | 資料庫查詢 → Catalog 審核 | ☐ |
| 7 | 計算指標、無外鍵關聯（如需要） | 審核檔 + `catalog:review` | ☐ |
| 8 | 發布 Catalog | 資料庫查詢 → Catalog 審核 | ☐ |
| 9 | 存取政策、使用者目錄 | 資料庫查詢 → 存取政策 | ☐ |
| 10 | 宣告角色、更新能力描述與關鍵字 | MCP 服務 | ☐ |
| 11 | 授予智慧代理、服務、角色 | 租戶 → 權限 | ☐ |
| 12 | 查詢預覽、對話實測、查詢稽核 | 資料庫查詢 | ☐ |
