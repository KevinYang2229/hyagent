# 推薦問句依來源分兩格（網站／檔案）＋ 手動覆寫 Design

**日期：** 2026-08-04
**狀態：** 已核可，待撰寫實作計畫

## 背景

目前每個租戶只有一句開場推薦問句：`KnowledgeIndexMeta.suggestedPrompts` 是單一 `{ 'zh-Hant', en }`，索引異動時整份索引一起抽樣、生成一句，widget 以 `App.tsx` 的 `slice(0, 1)` 渲染一顆 chip。

網站爬取與檔案上傳的內容合併在同一份索引裡，生成時混在一起，只能產出一句涵蓋全部的問句。實際使用上這兩種來源的性質差很多（對外網站內容 vs 內部文件），一句蓋不住。此外生成完全自動、管理者無法干預，句子不理想時只能重跑生成碰運氣。

相關近期變更：已移除 i18n 寫死的後備句（生成失敗即無 chip），並新增後台手動「重新生成」按鈕。

## 目標

1. 推薦問句改為**兩格**：網站來源一句、檔案來源一句，widget 最多顯示兩顆 chip。
2. 管理者可**手動覆寫**任一格，手動值鎖定不被自動生成覆蓋，可隨時恢復自動。
3. 降低生成失敗率（改為兩格後，單次失敗的曝險加倍）。

## 非目標

- 不做每個檔案各一句（多個上傳檔仍合併成「檔案來源」一句）。
- 不做超過兩顆 chip、不做排序設定、不做啟停開關。
- 不改索引檔格式（`IndexedChunk` 既有的 `fileId` 已足以區分來源）。
- 不改對話中的建議回覆（`TurnData.suggestions`），那是另一條路徑。

## 資料模型

`server/src/modules/knowledge/knowledge.store.ts`：

```ts
/** 一組推薦問句（中英各一）；空字串代表該語系不顯示 */
export interface SuggestedPrompts {
  'zh-Hant': string;
  en: string;
}

/** 單一來源的推薦問句格位 */
export interface PromptSlot {
  /** 依該來源的索引內容生成；未生成／生成失敗／來源無內容時不存在 */
  generated?: SuggestedPrompts;
  /** 管理者手動填寫；存在即鎖定，自動生成不覆蓋 */
  manual?: SuggestedPrompts;
}

export interface SuggestedPromptSlots {
  website?: PromptSlot;
  file?: PromptSlot;
}

// KnowledgeIndexMeta
suggestedPrompts?: SuggestedPromptSlots;
/** 各來源的 chunk 數；widget config 據此判斷該格要不要輸出（見 API 契約） */
chunkCountBySource?: { website: number; file: number };
```

**有效句 = `manual ?? generated`**（逐格判斷）。

「鎖定」不另存旗標：`manual` 有值就是鎖定，清除 `manual` 即回到 `generated`。少一個會與資料不同步的狀態。

### 舊資料正規化

既有 meta 的 `suggestedPrompts` 是單一 `{ 'zh-Hant', en }`。於 `knowledgeStore.getMeta` 讀取時就地正規化（自我修復，不需開機遷移）：

- 值有 `zh-Hant` 屬性 → 視為舊格式
- 該租戶的來源設定有 `startUrl` → 放進 `website.generated`；否則放進 `file.generated`

既有租戶升級後不會掉 chip。

## 來源切分與生成

`IndexedChunk.fileId` 有值＝檔案來源，無值＝網站來源。

`refreshSuggestedPrompts(tenantId, idx)` 改為一次處理兩格：

1. 依 `fileId` 把 chunks 切成 `website` / `file` 兩組。
2. 逐格判斷是否需要生成：
   - 該格有 `manual` → **整格跳過，不呼叫 LLM**（省成本，且生成了也用不到）
   - 該組 chunks 為 0 → 清掉該格的 `generated`（不留指向已刪內容的句子）
   - 其餘 → 抽樣並呼叫一次 Haiku
3. 兩格都要生成時以 `Promise.all` 併發。
4. 世代防護維持現行 per-tenant 機制：兩格在同一次 await 結束後，確認世代仍為最新才一起寫入。
5. 回傳這次實際寫入的格位內容，供後台按鈕分辨成功／失敗。

抽樣沿用 `sampleIndexForSuggestion`，只是輸入從整份索引改成單一來源的 chunks。檔案來源的 `title` 是檔名（零訊號），既有的「相異 title 大於 1 才輸出主題清單」邏輯已能處理，不需另外分支。

### 生成重試

`parseSuggestion` 驗證未過時**重試一次**，把失敗原因（超過 20 字元／不是合法 JSON／缺欄位）附加到 user message 再生一次；第二次仍不過才放棄該格。

驗證上限維持 zh-Hant 20 字元、en 12 個單字——chip 的版面寬度就這樣，放寬會擠爆。

## API 契約

### widget config（公開）

`GET /api/widget/config` 的 `suggestedPrompts` 從物件改為**陣列**，網站在前、檔案在後，只放有內容的格：

```json
{
  "data": {
    "appearance": { },
    "knowledgeEnabled": true,
    "suggestedPrompts": [
      { "zh-Hant": "智慧閱讀有哪些方案？", "en": "What plans are available?" },
      { "zh-Hant": "育兒補助要附什麼？", "en": "" }
    ]
  }
}
```

前端不需要知道哪句來自哪個來源。

輸出規則（沿用並擴充現有守門）：

- `knowledgeEnabled` 為 false → 空陣列
- `meta.status !== 'ready'` 或 `chunkCount === 0` → 空陣列
- **某來源的 chunks 為 0 → 該格不輸出，即使有 `manual`**（否則刪光檔案後，手動填的句子仍會指向不存在的內容）

第三條需要知道每個來源的 chunk 數。於 `KnowledgeIndexMeta` 增加 `chunkCountBySource?: { website: number; file: number }`，在既有的索引寫入點（爬取完成、上傳、刪檔）一併更新，避免 widget 這支免登入端點為了算數量去讀整份索引檔。

### admin（需 requireAdmin）

| 方法 | 路徑 | body | 用途 |
| --- | --- | --- | --- |
| POST | `/admin/tenants/:id/knowledge/suggestion` | `{ source: 'website' \| 'file' }` | 重新生成該格 |
| PUT | `/admin/tenants/:id/knowledge/suggestion` | `{ source, manual: SuggestedPrompts \| null }` | 設定／清除手動值 |

POST 沿用現有實作並加上 `source`（已上線行為的調整）：解析任務進行中回 409、該來源無 chunks 回 422、生成失敗回 422（不拿殘留舊句充數）。

PUT 的 `manual: null` 代表恢復自動。`manual` 的 `zh-Hant` 為必填非空、`en` 可為空字串。

兩支都回傳異動後的該格內容，後台據此更新畫面而不必重抓整份 meta：

```json
{ "data": { "source": "website", "slot": { "generated": { }, "manual": { } } } }
```

## 前端

`client/src/knowledgePrompt.ts`：

```ts
export function pickKnowledgePrompts(opts: {
  knowledgeEnabled: boolean;
  language: string;
  suggested?: SuggestedPrompts[];
}): string[]
```

停用回空陣列；否則逐筆取該語系字串、濾掉空值。`App.tsx` 移除 `slice(0, 1)`，渲染全部（最多兩顆），其餘（chip 樣式、點擊即送出）不變。

`embedConfig.ts` 的 `WidgetConfig.suggestedPrompts` 型別改陣列，解析時若不是陣列一律當空（防舊 server 回舊格式）。

## 後台 UI

索引狀態卡的「開場推薦詞」從一列改為兩列（網站來源／檔案來源），每列包含：

- 目前有效句（中英），或「尚未生成，widget 不會顯示」
- `自動` / `手動` 標籤
- `[重新生成]`：只重生該格；該來源無內容時 disabled
- `[編輯]`：展開中英兩格輸入（英文可留空），存檔即寫入 `manual`
- `[恢復自動]`：僅在該格有 `manual` 時出現

## 測試

### 純函式（不打 LLM／不碰 IO）

- 來源切分：有 `fileId` 分到 file、無 `fileId` 分到 website、兩者混合、單一來源
- 舊資料正規化：舊單句 + 有 `startUrl` → website；舊單句 + 無 `startUrl` → file；新格式原樣通過
- `pickKnowledgePrompts`：停用回空、兩筆都有該語系回兩筆、其中一筆該語系為空只回一筆、未知語系回空

### 生成（mock LLM）

- 兩種來源都有 → 兩格各生成一句，LLM 被呼叫兩次
- 某格有 `manual` → 該格不呼叫 LLM，`generated` 不變
- 某來源 chunks 為 0 → 清掉該格 `generated`，另一格不受影響
- 驗證未過 → 重試一次；第二次成功則寫入、兩次都失敗則該格不寫入
- 世代防護：await 期間有更新的呼叫 → 放棄過期寫入

### 契約（supertest）

- widget config 回兩筆／一筆／零筆
- `manual` 覆蓋 `generated`
- 某來源 chunks 為 0 時該格不輸出（即使有 `manual`）
- 知識庫服務關閉 → 空陣列

### 端點（supertest）

- POST 重生單格：成功、該來源無內容 422、生成失敗 422、解析中 409、未帶 admin key 401
- PUT 設定手動值、`manual: null` 清除、`zh-Hant` 為空回 400

## 風險與取捨

**LLM 呼叫成本加倍。** 兩格各一次 Haiku，加上失敗重試最多四次。以 Haiku 與 200 max tokens 計，單次索引異動的成本仍可忽略；`manual` 格跳過生成也會抵掉一部分。

**widget config 契約破壞性變更。** `suggestedPrompts` 從物件改陣列。已確認消費者只有 `client/`（`sdk` 與 `presale` 用的 `suggestions` 是對話建議回覆，不同路徑），server 與 client 同版部署即可。前端仍加防禦：不是陣列就當空。

**`chunkCountBySource` 需與索引寫入點同步維護。** 漏更新會讓 chip 顯示或消失的判斷失準。緩解：集中在既有的三個索引寫入點（`knowledge.job`、`ingestFile`、`removeFile`），並在測試中覆蓋每一個。
