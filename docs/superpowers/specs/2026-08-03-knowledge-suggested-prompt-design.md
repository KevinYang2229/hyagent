# 依知識庫內容生成 widget 推薦用詞

**日期**：2026-08-03
**狀態**：設計已確認，待實作

## 背景與問題

widget 在對話開始前會顯示一排 chip：可用表單，加上一句知識庫推薦問句。那句推薦問句寫死在
`client/src/i18n.ts:77`：

```ts
knowledgePrompts: ["公司有哪些產品或服務？", "聯絡電話與地址在哪？", "相關規定與常見問題"],
```

`client/src/App.tsx:870` 是 `knowledgePrompts.slice(0, 1)`，只渲染第一個。所以：

- 實際上永遠只會出現「公司有哪些產品或服務？」，與該租戶索引了什麼內容完全無關
- 陣列後兩句從未被渲染過，是死碼

泛問對訪客沒有價值。真正該做的是讓這句 chip 反映這個租戶的知識庫實際涵蓋什麼，訪客一眼就知道
問這個 bot 什麼有意義。

## 目標

- 推薦問句依租戶索引內容生成，取代寫死的泛問
- 顯示數量維持 1 個，UI 結構不動
- 支援 zh-Hant / en 兩種語系，可在執行期切換
- 生成失敗、無索引、舊資料一律安全回落到現有寫死句，不得讓半殘內容出現在訪客面前

### 非目標

- 不做 admin 手動編輯／覆寫推薦詞（尚無此需求）
- 不做多於一句的推薦詞輪播
- 不改動 chip 的視覺樣式或 picker 的展開行為

## 設計決策

### 生成時機：ingest 完成時一次，結果快取進 meta

在索引異動時生成一次並存進 `KnowledgeIndexMeta`，widget 載入時直接讀快取。

考慮過但否決的替代方案：

- **widget 每次載入即時生成**：LLM 呼叫落在開場關鍵路徑上，訪客要等或看到字跳動，且流量直接
  轉成 token 成本。
- **lazy（首次請求時才生成）**：省下的成本有限（一次 ingest 一次呼叫），卻要處理併發重入鎖與
  首位訪客的閃爍。不划算。

推薦詞的內容只在索引變動時才需要變，與 ingest 同步是最自然的邊界。

### 程式位置：獨立模組，不塞進 ingest 流程

新增 `server/src/modules/knowledge/knowledge.suggest.ts`。

考慮過但否決：把生成邏輯放進 `ingest.service.ts` 的 `runIngest`。否決原因有二 ——
檔案上傳路徑（`knowledge-file.service.ts`）根本不走 `runIngest`，會變成要實作兩次；且把 LLM
呼叫綁進 ingest 的 try 區塊，生成失敗有機會把整個索引標記成 failed。`runIngest` 已超過 300 行，
不該再長。

獨立模組讓生成邏輯只有一份，且失敗完全不影響索引本身。

## 資料形狀

`KnowledgeIndexMeta`（`server/src/modules/knowledge/knowledge.store.ts`）新增選填欄位：

```ts
/**
 * 依索引內容生成的開場推薦問句（widget 開場 chip 用）。
 * 無索引、生成失敗或驗證未過時不存在——前端據此回落 i18n 預設句。
 */
suggestedPrompts?: { 'zh-Hant': string; en: string };
```

選填欄位，與既有的 `files?` / `format?` 同一種漸進加欄位風格，舊 meta 天然相容。

注意 knowledge store 目前仍是 JSON 檔後端（九個 store 中唯一尚未接 db 者），此設計不改變這點。

## 抽樣策略

索引動輒數百 chunk，不能整包餵給 LLM。

**先前假設已被實測推翻。** 原本打算依 title 出現次數排序取代表性主題，實際檢查兩份索引後不成立：

```text
data/knowledge-index.default.json          285 chunks | distinct titles: 1
  285 | 1784768063225.html                          ← 上傳 PDF：title 只是檔名，零訊號

data/knowledge-index.7db2f14abfe2d589.json  39 chunks | distinct titles: 37
    2 | 凌網資訊 › 智慧閱讀服務                        ← 爬站：title 資訊豐富，但次數幾乎全為 1
    1 | 凌網資訊 › 電子化政府
```

兩種來源各壞一半：檔案來源的 title 是檔名、毫無主題資訊；網站來源的 title 很有價值但次數全是 1，
依次數排序等同隨機。次數這個訊號兩邊都不可用。

改為不做任何排名、只保證覆蓋度：

1. **等距取文字**：以 `max(1, floor(chunkCount / 10))` 為間距跨整份索引取最多 10 個 chunk，
   各取 `text` 前 150 字。這是檔案來源唯一有效的訊號，等距則保證涵蓋文件頭中尾，不會只看到封面。
2. **附主題清單**：蒐集不重複 title，數量 > 1 時一併附上（最多 20 個）。先計算所有 title 的
   最長共同前綴並剝除——網站來源的 title 是 `凌網資訊 › XXX` 這種麵包屑，站名重複 20 次只是
   浪費 token 並稀釋重點，剝除後的 `智慧閱讀服務` / `電子化政府` 才是真正的主題。
   單一 title 時不剝除（否則會把整串剝光）。
3. 組出的素材整體裁切至 2000 字元上限。

單次呼叫 input 約 1–2k token，一次 ingest 一次，成本可忽略。抽樣為純函式，不涉 IO。

## 生成契約

要求 LLM 回傳嚴格 JSON：

```json
{ "zh-Hant": "神農計畫補助要準備哪些文件？", "en": "What documents are needed for the grant?" }
```

Prompt 的硬性規則：

- 必須是訪客真的會輸入的問句，不是標題改寫
- 必須是這份知識庫答得出來的
- zh-Hant 20 個字元以內；en 12 個英文單字以內
- 禁止產出「有哪些產品或服務」這類套到任何組織都成立的泛問——泛問正是現行寫死句的缺陷，
  換成另一句一樣泛的沒有意義

模型指定 `env.LLM_ROUTER_MODEL`（預設 Haiku），與 intent-router、rerank 等輔助性 LLM 呼叫一致。
產生一句開場問句屬於同一類廉價任務，不需動用主模型。

租戶鎖定自有 provider（`lockModel`）的情形不需在此特別處理——provider 內部即以
`pickModel(settings, params.model)` 決定實際模型（見 `anthropic.provider.ts:82`），鎖定時會
自動忽略呼叫端的 model 覆寫。

### 輸出驗證

回應後逐項驗證：JSON 可解析、兩個 key 皆存在、皆為非空字串、長度在上限內。

**任一項未過即整筆丟棄，不寫入 meta。** 前端繼續使用 fallback。寧可退回舊行為，不讓半殘字串
出現在訪客面前。

## 觸發點

三個索引異動路徑各加一行非阻塞呼叫：

| 路徑 | 位置 |
| --- | --- |
| 網站爬取完成 | `server/src/modules/knowledge/knowledge.job.ts:92` |
| 上傳檔案 | `server/src/modules/knowledge/knowledge-file.service.ts:155` |
| 刪除檔案 | `server/src/modules/knowledge/knowledge-file.service.ts:174` |

```ts
void refreshSuggestedPrompts(tenantId).catch(() => {});   // 失敗只留 log，不影響索引
```

刪檔後索引若變空（`chunkCount === 0`），清除 `suggestedPrompts`，不保留指向已刪內容的問句。

租戶未設 LLM key 或呼叫失敗：`logger.warn` 後原樣返回，meta 不變。

## 傳遞與前端

`GET /api/widget/config`（`server/src/modules/widget/widget.controller.ts:20`，前端呼叫端為
`client/src/embedConfig.ts:63` 的 `fetchAppearance`）回應新增欄位：

```ts
res.status(200).json({ data: { appearance, knowledgeEnabled, suggestedPrompts } });
```

回傳整個 `{ 'zh-Hant', en }` 物件，不在後端挑語系——widget 語系可於執行期切換
（`client/src/App.tsx:672` 有切換器），後端挑定就切不動了。

`client/src/App.tsx:573` 改為生成句優先、i18n 墊底：

```ts
const kbPromptsRaw = t('app.knowledgePrompts', { returnObjects: true });
const fallback = Array.isArray(kbPromptsRaw) ? (kbPromptsRaw as string[]) : [];
// i18n.language 只會是 'zh-Hant' | 'en'（i18n.ts 的 resources 僅此兩者、fallbackLng 為 zh-Hant），
// 但仍以查表 miss 即回落處理，未來加語系時不需同步改這裡
const generated = suggestedPrompts?.[i18n.language as keyof typeof suggestedPrompts];
const knowledgePrompts = !knowledgeEnabled ? [] : generated ? [generated] : fallback;
```

未知語系（查表 miss）與生成失敗走同一條路：回落 `fallback`。

`slice(0, 1)` 維持不變。同時修改 `client/src/i18n.ts:77` 與 `:269` 的註解，說明這些句子現在的
角色是 fallback——否則下一個讀到的人仍會誤以為後兩句有在使用。

## 成本與可見性

生成消耗的 token 透過 `usageStore.recordLLMUsage(tenantId, result)` 記帳，與對話用量同一本帳。
這是租戶消耗的資源，不記帳會在月配額上造成對不起來的缺口。

Admin 的「索引狀態」卡片（`admin/src/pages/tabs/KnowledgeTab.tsx:471`）加一行顯示目前的推薦詞。
否則管理者無從得知訪客看到什麼，生成失效也不會有人發現。

## 測試

抽樣與驗證皆為純函式，是測試重點：

- 等距抽樣在 chunk 數少於 10 時不重複取用同一 chunk
- 最長共同前綴在只有單一 title 時不剝除（避免剝光）
- 網站來源 title（共同前綴為站名加分隔符）正確剝除為主題名
- 檔案來源（單一檔名 title）仍能從等距文字取得素材
- 壞 JSON、缺 key、空字串、超長字串一律回 `undefined`

整合測試：

- mock LLM，走完 ingest 完成路徑，確認 meta 寫入 `suggestedPrompts`
- LLM 拋錯時 ingest 仍成功、meta 的 `status` 仍為 `ready`
- 刪檔至索引為空後 `suggestedPrompts` 被清除

前端測試：

- meta 有 `suggestedPrompts` 時 chip 顯示生成句
- 缺欄位時回落 i18n 預設句
- 切換語系時 chip 內容跟著切換
