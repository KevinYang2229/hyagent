# 門市 Demo 後端能力擴充：表格區塊、可編輯確認卡片、影像辨識與門市 MCP

**日期**：2026-10-03
**狀態**：設計（已逐段確認，待實作計畫）
**前置**：[後端 MCP Client](2026-10-03-mcp-client-design.md)（分支 `feature/mcp-client`，本分支由其開出）
**驅動力**：對 7-ELEVEN 門市店員的 POC Demo。前台為 Expo app（平板為主、手機可用），依使用者提供的平板設計稿製作；本文件是其**子專案 1：後端能力**。app 本身另開 spec（子專案 2）。

---

## 0. 背景與範圍

Demo 必須展示五個情境：

| # | 情境 | 依賴的後端能力 |
|---|---|---|
| S1 | 語音對話 | 無新需求（app 端用系統語音辨識轉文字後走既有對話 API） |
| S2 | 拍照辨識貨架（缺貨／即期品／擺放錯誤，照片上框選） | §5 影像辨識、§6 門市 MCP |
| S3 | 問庫存 → 表格回覆 → 建立補貨單（可勾選、改數量、選日期） | §3 表格區塊、§4 可編輯確認卡片、§6 |
| S4 | 知識庫問答（如「咖啡機紅燈怎麼處理」） | 既有知識庫；只需上傳 Demo 文件 |
| S5 | 客人詢問活動或優惠券（口述／輸入券號、拍券、掃條碼） | §3、§5 優惠券模式、§6 |

**非目標**：首頁「今日重點」、任務、通知的真實資料（app 端用靜態或假資料）；對話中任意附圖（架構預留，見 §5.6）；拍活動海報；重新整理後還原表格；多副本部署。

---

## 1. 決策紀錄

| # | 決策 |
|---|---|
| D1 | 定位 POC Demo；門市資料由假資料的自建 MCP 服務提供（走真實 AI → MCP 鏈路，日後替換服務即可接真實系統） |
| D2 | 先做後端能力（本文件），再做 Expo app；後端能力先在 web 前台驗證 |
| D3 | 貨架辨識全部走真實辨識（Claude 影像理解），包含概略框選座標；Demo 前以實際照片反覆調校提示詞 |
| D4 | 可編輯確認卡片由工具輸入 schema 自動產生，使用標準 JSON Schema 關鍵字（`readOnly`、`format`、`enum`、`minimum`…） |
| D5 | 工具結果直接成為畫面區塊（blocks），由 MCP 工具在 `_meta` 宣告顯示提示；Demo 只支援 `table` |
| D6 | 活動與優惠券放在門市 MCP；查券可口述／輸入、拍照（Claude 讀印刷券號）、或 app 端掃條碼 |
| D7 | 拍照只做專屬流程（`shelf`、`coupon` 兩種模式），不做對話中任意附圖 |

---

## 2. 元件總覽

```
mcp/store-demo/            門市 Demo MCP 服務（@hyagent/mcp-kit）＋ JSON 假資料 ＋ 商品圖片
server/src/lib/llm/        LLM 層：image 內容區塊、toolChoice 強制工具呼叫
server/src/modules/
  display/                 顯示提示 → blocks（table）的解析與驗證
  conversation/            TurnResult.blocks；確認卡片 form；confirm 接受修改；propose 端點
  vision/                  POST /api/vision/analyze（shelf / coupon）
  mcp/                     tool-source／connection 把 _meta 顯示提示帶回來
shared/src/index.ts        DisplayBlock、ConfirmForm 等共用型別
client/src/                web 前台：table 區塊、可編輯確認卡片（驗證用，簡易版）
```

---

## 3. 畫面區塊（blocks）

### 3.1 MCP 工具宣告

工具回傳的 `CallToolResult` 照常把資料放在 `structuredContent`，另在 `_meta["hyagent/display"]` 放顯示提示：

```jsonc
{
  "type": "table",
  "title": "御飯糰庫存",              // 選填
  "rows": "items",                     // structuredContent 中物件陣列的屬性名稱
  "columns": [
    { "key": "name",      "label": "商品名稱", "image": "image" },          // image：同列中圖片網址欄位
    { "key": "stock",     "label": "目前庫存", "unit": "個" },
    { "key": "suggested", "label": "建議補貨", "unit": "個", "format": "delta" },
    { "key": "status",    "label": "狀態", "badge": { "庫存偏低": "danger", "正常": "success" } }
  ]
}
```

- `format`：`"text"`（預設）、`"delta"`（>0 顯示強調色「+N 單位」，0 或空值顯示「–」）、`"date"`。
- `badge`：值 → 色調；色調只有 `success`、`warning`、`danger`、`neutral`。未列出的值以 `neutral` 顯示。

### 3.2 後端處理

1. `McpConnection.callTool` 除正規化結果外，另取 `_meta["hyagent/display"]`；以帶品牌的包裝 `ToolOutput { data, display? }` 回傳給 tool-source handler。
2. Agent 的 `dispatchTool` 拆包：`data` 交給 LLM（tool_result），`display` 交給 `buildDisplayBlock(display, data)`。
3. `buildDisplayBlock` 驗證並解析出 `DisplayBlock`：

   ```ts
   interface TableBlock {
     type: 'table';
     title?: string;
     columns: { key: string; label: string; unit?: string; format?: 'text' | 'delta' | 'date';
                image?: string; badge?: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> }[];
     rows: Record<string, string | number | null>[];
   }
   ```

   - 最多 50 列、12 欄；儲存格只接受字串、數字或 null（其他型別轉 null）。
   - `image` 指向的欄位值必須是 http(s) URL，否則該格不顯示圖片。
   - 顯示提示不合法：不產生區塊、記 warn，回覆照常。
4. 本輪產生的區塊依序收集到 `AgentTurnResult.blocks` → `TurnResult.blocks`，接在 AI 文字回覆之後呈現。
5. 給 LLM 的 tool_result 附註：「結果已以表格顯示給使用者，請簡述重點，不要逐列重複數字。」

### 3.3 不做

區塊不寫入對話歷史；重新載入對話只剩文字。

---

## 4. 可編輯確認卡片

### 4.1 結構

`PendingActionView` 保留 `summary`（舊前台相容），新增 `form`：

```ts
interface ConfirmForm {
  title: string;
  fields: ConfirmField[];
}
type ConfirmField =
  | { kind: 'text' | 'number' | 'date' | 'select'; key: string; label: string; value: unknown;
      editable: boolean; min?: number; max?: number; options?: { value: string; label: string }[] }
  | { kind: 'table'; key: string; label: string; selectable: boolean;
      columns: { key: string; label: string; kind: 'text' | 'number' | 'date' | 'select';
                 editable: boolean; unit?: string; min?: number; max?: number; image?: string }[];
      rows: Record<string, unknown>[] };
```

### 4.2 由 schema 推導

| schema | 欄位 |
|---|---|
| `readOnly: true` | 不可編輯 |
| `number` / `integer` | `number`，`minimum`／`maximum` → `min`／`max` |
| `format: "date"` | `date` |
| `enum` | `select`（`x-enumLabels` 可選，提供顯示文字） |
| `string` | `text`；`x-display: "html"` 者不可編輯 |
| 物件陣列 | `table`；`selectable` = 項目 schema 至少有一個 `readOnly` 欄位（作為列識別）且 `minItems` 允許減少 |
| `x-unit`、`x-image` | 欄位單位、圖片欄位（顯示用延伸關鍵字） |

標籤取 `title` → `description` → key（沿用既有規則）。

### 4.3 確認時附上修改

`POST /api/conversations/:id/actions/:actionId/confirm` 可帶 body `{ input?: object }`。帶 `input` 時，後端依序驗證，任一失敗回 **422**（`ACTION_INPUT_INVALID`，附原因）且**保留**待確認動作：

1. Ajv 依工具 schema 驗證。
2. 只允許 schema 中存在的鍵。
3. 唯讀不變：純量唯讀欄位值須等於原值；表格每一列須能以「全部唯讀欄位相同」對應到原本某一列，且不得重複對應 —— 允許刪列與修改可編輯欄位，**不允許新增列或改唯讀值**。不可勾選（`selectable: false`）的表格，列數與順序須與原本相同。

通過後以修改後的 input 執行；逐字稿附註差異（如「鮭魚御飯糰 補貨數量 24→30；移除 沙拉－和風雞肉」）。

既有的一次性保證不變：比對 id 後才清除並 `saveCritical`；422 的情況在清除之前就回傳。

### 4.4 不經 AI 的提議

`POST /api/conversations/:id/actions/propose`，body `{ toolId, input }`：

- 只接受寫入工具（`isWriteTool`）；權限與輸入驗證同 AI 提議（`toolRegistry.assertInvocable`）。
- 取代該對話既有的待確認動作，回傳 `{ pendingAction: PendingActionView }`。
- 仍需使用者確認才執行。供 §5「建立補貨單」按鈕使用。

### 4.5 既有工具的影響

`email.send` 的收件人與主旨變為可編輯，內文（`x-display: html`）維持唯讀。

---

## 5. 影像辨識

### 5.1 LLM 層

- `LLMContentBlock` 新增 `{ type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }`（base64）；Anthropic、OpenAI provider 各自轉換。
- `LLMCreateParams` 新增 `toolChoice?: { name: string }`，強制呼叫指定工具。
- 影像辨識使用租戶既有的 LLM 設定（`getLLMProvider(tenant.llmConfig)`），用量照常記入。

### 5.2 API

`POST /api/vision/analyze`（multipart）：

| 欄位 | 說明 |
|---|---|
| `image` | jpeg／png／webp，≤ 5MB；app 上傳前將長邊縮至 1568px |
| `mode` | `shelf` 或 `coupon` |

- 中介層：`resolveTenant`、`requireAuth`、`tenantRateLimit`、`tenantMonthlyQuota`。
- 需 `service:agent`；查詢經 Tool Registry，故實際也需要門市 MCP 的 `mcp:store-demo`。
- 照片只在記憶體處理，不落地。
- 錯誤：格式或大小不符 422；LLM 失敗 502；MCP 不可用時仍回辨識結果，但缺補齊欄位並附 `warnings`。

### 5.3 `shelf` 模式

1. LLM（強制呼叫 `report_shelf`）回傳每個可辨識商品：`name`、`status`（`out_of_stock` | `misplaced` | `ok`）、`box`（0–1 相對座標 `{x,y,w,h}`）、`note`。
2. 以 `product_lookup` 模糊比對名稱 → `productId`；比對不到者保留但不列入補貨。
3. 以 `inventory_query` 取庫存、建議補貨量、到期日；**到期日 ≤ 明天者標 `expiring`**（即期判斷不靠照片）。
4. 回傳：

```ts
{ mode: 'shelf',
  findings: { name: string; productId?: string; status: 'out_of_stock' | 'expiring' | 'misplaced' | 'ok';
              box: { x: number; y: number; w: number; h: number };
              stock?: number; suggestedQty?: number; expiryDate?: string; note?: string }[];
  counts: { outOfStock: number; expiring: number; misplaced: number };
  replenishment?: { toolId: string; input: Record<string, unknown> };   // 缺貨且有 productId 者
  warnings?: string[] }
```

### 5.4 `coupon` 模式

1. LLM（強制呼叫 `report_coupon`）讀出券上印刷的 `code`、`title`、`expiry`。
2. 有 `code` → 呼叫 `coupon_check`，結果與其顯示區塊一併回傳。
3. 回傳 `{ mode: 'coupon', extracted: { code?, title?, expiry? }, result?, block?, message? }`；讀不到券號時 `message`＝「讀不到券號，請掃條碼或手動輸入」。

條碼掃描在 app 端完成，掃到的號碼直接走對話或 `coupon_check`，不經本 API。

### 5.5 提示詞與調校

兩種模式的系統提示詞放在 `server/src/modules/vision/prompts.ts`；附 `server/scripts/vision-eval.ts`：讀取指定資料夾的照片，逐張呼叫並輸出 findings 與框選疊圖（HTML），供 Demo 前人工檢視與調整。

### 5.6 預留

對話中任意附圖未做；LLM 層的 image 區塊已備妥，日後可在對話 API 加附件並把圖片放入 user 訊息。

---

## 6. 門市 Demo MCP 服務（`mcp/store-demo/`）

以 `@hyagent/mcp-kit` 撰寫，`serverId` 預設 `store-demo`。

| 工具 | 讀寫 | 輸入 | 輸出（含顯示提示） |
|---|---|---|---|
| `product_lookup` | 讀 | `names: string[]` | 每個名稱的最佳比對 `{ query, productId?, name?, score }` |
| `inventory_query` | 讀 | `keyword?`、`category?`、`productIds?` | `items[]`：名稱、圖片、庫存、安全庫存、建議補貨、到期日、狀態；表格區塊 |
| `replenishment_create` | **寫** | `items[]`（`productId`／`name`／`stock` 唯讀、`quantity` 可改）、`arrivalDate`（date） | 補貨單編號、品項、到貨日 |
| `promotion_list` | 讀 | `keyword?`、`category?`、`date?` | `promotions[]`：名稱、內容、適用商品、期間；表格區塊 |
| `coupon_check` | 讀 | `code` | 能否使用、原因、適用商品、期限、條件；表格區塊 |

- 資料：`data/products.json`（約 20 項：御飯糰、三明治、沙拉、便當、飲料、關東煮…）、`promotions.json`（5 個）、`coupons.json`（5 張，含已過期、已使用、不適用等案例）。
- **日期以相對天數儲存**（`expiryInDays`、`validFromDays`／`validToDays`），執行時換算；任何一天 Demo 都有即期品與有效券。
- 補貨單存在記憶體，重啟清空（Demo 用）。
- 商品圖片放在 `assets/`，由服務以 `GET /assets/*` 公開提供；`image` 欄位為完整 URL（依環境變數 `PUBLIC_BASE_URL` 組成）。
- 寫工具標註遵守 kit 規範；`replenishment_create` 拒絕 `caller.system`。

---

## 7. Web 前台（驗證用）

- 對話訊息下方渲染 `TableBlock`（圖片、單位、delta、badge）。
- 確認卡片依 `form` 渲染可編輯欄位與可勾選表格；送出時附 `input`；422 時在卡片內顯示原因並保留可再送出。
- 不做影像辨識畫面（屬 app）。

---

## 8. 測試

- **單元**：`buildDisplayBlock`（合法、超限、錯誤 image URL、未知 badge 值）；schema → `ConfirmForm` 推導（各 kind、`selectable` 條件、html 唯讀）；修改驗證（改唯讀值、加列、刪列、重複對應、多出鍵、Ajv 失敗 → 422 且動作保留）；provider 的 image／toolChoice 轉換。
- **整合**：以 kit fixture 提供含 `_meta` 顯示提示的工具，驗證 agent 回覆帶 `blocks` 且 LLM 拿到的 tool_result 不含 `_meta`；`propose` → `confirm(input)` 完整流程；`vision/analyze` 以假 LLM（固定回傳 `report_shelf`／`report_coupon` 工具呼叫）加 store-demo 測試資料跑兩種模式，含 MCP 不可用時的 `warnings`。
- **store-demo**：各工具的 vitest（相對日期換算、券的各種狀態、`replenishment_create` 拒絕 system）。
- **人工**：`vision-eval.ts` 以實際照片調校；web 前台走 S3、S5 流程。

---

## 9. 風險

| 風險 | 緩解 |
|---|---|
| 框選座標不準 | §5.5 以實際 Demo 照片反覆調校；座標僅作標註，數量與補貨來自 MCP 資料 |
| 商品名稱比對錯誤 | `product_lookup` 回傳分數，低於門檻不帶 `productId`，不列入補貨 |
| 可編輯卡片被用來竄改唯讀值 | §4.3 後端以原始 input 比對，前端不可信 |
| `propose` 被濫用繞過 AI | 只建立待確認動作，執行仍需使用者確認並重檢權限，與 AI 提議等價 |
| 影像辨識成本與延遲 | 縮圖至 1568px；套用既有限流與月配額 |
