# 知識庫檢索彙整成報告（Report Skill）Design

**日期：** 2026-08-11
**狀態：** 已核可，待撰寫實作計畫

## 背景

知識庫目前唯一的消費端是 `knowledge.agent-service.ts` 的對話問答：一句問題 → 指代改寫 → `pickRetriever` 取候選池 → `rerankChunks` 取 top-5 → 一次 LLM 綜合作答（`maxTokens: 512`），旁路不動 `session.values`。

這條路徑是為「一問一答」調校的：單一 query 決定召回範圍、輸出長度只夠幾段話。使用者要的「一份報告」形狀不同——涵蓋一個主題的多個面向、輸出是結構化長文、要能帶走（檔案），而且跑完的時間遠超過一個聊天輪次能等的長度。

報告內容**完全來自 RAG 檢索結果**，不引入知識庫以外的任何來源。

## 目標

1. 使用者在對話中說「幫我整理一份 ○○ 的報告」即可觸發，沿用既有意圖路由。
2. 由 LLM 依主題拆大綱，**每節各自檢索**，讓涵蓋面不受單一 query 的向量命中限制。
3. 非同步執行 + 輪詢，對話不卡住。
4. 產出可下載的 Markdown 與 HTML 兩種格式。
5. 報告可稽核：每節標來源，查無資料的節據實呈現。

## 非目標

- 不做報告模板 / schema（本輪一律 LLM 拆大綱）。
- 不做 PDF、DOCX。
- 不做 SSE 逐節串流（前端輪詢即可）。
- 不做報告的編輯、版本、重跑既有報告。
- 不做跨租戶或跨知識庫來源的彙整（維持現行單租戶索引視角）。
- 不改動 `knowledge` 模組任何既有行為。

## 架構

新模組 `server/src/modules/report/`，與 `knowledge` **平行**。依賴方向單向：

```
report → knowledge（pickRetriever / rerankChunks / KnowledgeChunk）
```

`knowledge` 不得 import `report` 的任何東西。理由與 `retriever.pick.ts` 檔頭記載的原則一致：知識庫的檢索出口只有一個，所有消費端都走 `pickRetriever`，報告也不例外——繞過它在 db 模式下不會噴錯，只會靜默回 0 命中。

| 檔案 | 職責 | 依賴 |
|---|---|---|
| `report.types.ts` | `ReportJob` / `ReportSection` / `ReportDoc` | 無 |
| `report.outline.ts` | 主題 → 大綱（LLM） | LLM |
| `report.compose.ts` | 逐節：檢索 → rerank → 彙整 | knowledge 檢索出口、LLM |
| `report.render.ts` | `ReportDoc` → Markdown / HTML 字串 | 無（純函式） |
| `report.store.ts` | 產出物存放 + TTL 回收 | `@/lib/db` |
| `report.job.ts` | 非同步 job 生命週期 | outline / compose / render / store |
| `report.agent-service.ts` | `AgentService` 實作 | job、LLM |
| `report.controller.ts` / `report.routes.ts` | 狀態查詢、下載 | store / job |

`report.render.ts` 是純函式、`report.outline.ts` 不認識檢索、`report.compose.ts` 不認識輸出格式——三者可各自單獨測試。

## 資料模型

`report.types.ts`：

```ts
/** 大綱中的一節：標題 + 用來檢索該節材料的查詢句 */
export interface OutlineSection {
  heading: string;
  query: string;
}

export interface Outline {
  title: string;
  sections: OutlineSection[];
}

/** 一節的來源引用（供節末與報告尾端的來源清單使用） */
export interface SectionSource {
  title: string;
  url?: string;
}

/** 彙整完成的一節 */
export interface ReportSection {
  heading: string;
  query: string;
  /** 彙整後內文；查無資料時為固定語句（見「證據紀律」） */
  body: string;
  sources: SectionSource[];
  /** 檢索命中數，0 代表該節查無資料 */
  hits: number;
  /** 該節的 LLM 彙整失敗、已降級為片段列表 */
  degraded?: boolean;
}

export interface ReportDoc {
  title: string;
  /** 使用者原始主題（保留於報告表頭，供讀者對照） */
  topic: string;
  locale: string;
  generatedAt: string;
  sections: ReportSection[];
}

export interface ReportJob {
  id: string;
  tenantId: string;
  userId: string;
  topic: string;
  status: 'queued' | 'outlining' | 'composing' | 'done' | 'empty' | 'failed';
  /** 大綱節數，outlining 完成後才有值 */
  totalSections?: number;
  /** 已完成節數，供前端顯示進度 */
  doneSections: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
```

`empty` 是獨立於 `done` 與 `failed` 的終態：流程全跑完、沒出錯，但所有節都零命中，因此**不產檔**。把它混進 `done` 會給出一份空報告的下載連結，混進 `failed` 則謊稱系統故障——兩者都會誤導使用者判斷「是知識庫沒有這些資料，還是系統壞了」。

## 產生流程

```
使用者：「幫我整理一份馬太鞍溪災害補助的報告」
  │
  ├─ intent-router 依 report.generate 分派給 report service
  ├─ handleTurn：從對話脈絡抽出報告主題（便宜模型）
  ├─ startReportJob() → 立刻回覆「報告產生中…」+ reportId
  │
  └─ 背景（不阻塞回應）：
       outline(topic)                    1 次 LLM
       for each section:                 ≤ 6 節
         pickRetriever().search(query)
         rerankChunks(..., FINAL_K=5)    ≤ 1 次 LLM（rerank 內部）
         composeSection(chunks)          1 次 LLM
       render → md + html → store.save()
       job.status = done | empty
```

前端輪詢 `GET /api/reports/:id`，`done` 後顯示兩個下載連結。

### 主題抽取

`handleTurn` 收到的可能是「幫我整理一份報告」這種沒帶主題、或帶指代的句子。沿用 `knowledge.agent-service.ts` 的 `resolveQuery` 精神：帶最近 6 則訊息、用 `env.LLM_ROUTER_MODEL` 抽出可獨立理解的主題句。

與 `resolveQuery` 不同的是**失敗處理不能 fail-open**：抽不出主題（模型失敗或判定對話中確實沒有主題）時，不啟動 job，直接回問「你想針對什麼主題產生報告？」。拿一句空泛的話去跑 7 次 LLM 呼叫，成本實際發生、產出必定無用。

### 大綱

輸出固定 JSON：`{ "title": "...", "sections": [{ "heading": "...", "query": "..." }] }`。

- 節數上限 `REPORT_MAX_SECTIONS`（預設 6），超出截斷。
- 解析比照 `rerank.ts` 的做法：正則抓第一個 JSON 物件再 `JSON.parse`，容忍模型加前後綴。
- 每節的 `query` 必須是**可獨立檢索的完整問句**，不是標題的複製——這是多節檢索能提升涵蓋面的前提，寫進 system prompt 並在測試中以 mock 驗證。

### 逐節彙整

每節獨立跑，一節的結果不影響另一節：

```
pool   = await (await pickRetriever(tenantId)).search(tenantId, section.query)
chunks = await rerankChunks(tenantId, section.query, pool, FINAL_K)   // FINAL_K = 5
```

`chunks` 為空 → `hits: 0`，`body` 直接填固定語句，**不呼叫 LLM**（沒有材料可彙整，省一次呼叫）。

有材料 → 把 top-k 片段以 `[1] 標題（url）\n內容` 格式交給 LLM，`maxTokens: 1200`。system prompt 沿用 `kbAnswerSystem` 已確立的證據規則，並加上報告特有的：只寫這一節的內容、不要重複標題、不要寫結論或過渡句（節與節的銜接由 render 負責）。

節之間**不共享脈絡**：每節只看自己的參考資料。共享脈絡會讓後面的節帶著前面節的結論走，而那些結論的來源片段已經不在視野內——等於讓模型在無法核對的二手資訊上繼續推論。

## 證據紀律

沿用 `knowledge` 已確立的規則，並補上報告特有的：

1. 每節只把 top-k 片段進 LLM，**整份索引永不進 LLM**（與現行問答一致，成本可預期）。
2. 內容只能出自參考資料；未涵蓋的部分明說「資料中未提及」，不得杜撰。
3. 每節末以 `（來源：標題）` 標註，報告尾端彙整完整來源清單（去重，有 url 者附連結）。
4. **零命中的節保留標題**，內文固定為「知識庫查無相關資料。」而非刪掉該節。報告是要拿去看的文件，缺口本身就是資訊——讀者需要知道「這個面向沒有資料」而不是以為它不存在。這是報告與聊天回覆最重要的差別。
5. 全部節都零命中 → `status: 'empty'`，不產檔，對話直說查無資料。

## 失敗處理

| 失敗點 | 處理 | 理由 |
|---|---|---|
| 主題抽取 | 不啟動 job，回問主題 | 見上；不能 fail-open |
| 大綱生成 / JSON 解析 | fail-fast，`status: 'failed'` | 沒有大綱就沒有報告，無從降級 |
| 單節檢索 | 該節記為 `hits: 0` | 不讓一節拖垮整份 |
| 單節彙整 LLM | 降級為片段列表 + `degraded: true` | 比照 `fallbackReply`；有材料就別浪費 |
| 同租戶已有進行中 job | `AppError.conflict`（409） | 比照 `startIngestJob`；報告是重任務 |
| 下載對象非建立者 / 跨租戶 | 404 | 不洩漏報告是否存在 |

`degraded` 要落在產出物上（render 時於該節標註），否則使用者拿到一份品質不一致的報告卻不知道哪幾節是降級來的。

## 產出物與下載

`report.store.ts` 比照 `attachment.store.ts`：記憶體 `Map` + `DATA_BACKEND=db` 時 `DbWriteQueue` write-through。與附件不同的兩點：

- **讀取路徑必須實作**。`attachment.store` 的檔頭明載「目前無任何呼叫端讀 bytes」，所以 `get` 只讀記憶體；報告的下載就是讀取路徑，db 模式下必須能從 Postgres 讀回，否則重啟後連結全失效。因此 `get` 一開始就是 async。
- **TTL 回收**：`REPORT_TTL_HOURS`（預設 24）過期清除，記憶體與 DB 皆然。附件靠對話結束清理，報告沒有對應的生命週期終點。

新表 `report_docs`（`server/db/migrations/` 新增 SQL 檔 + `prisma/schema.prisma` 同步，並 `enable row level security`，沿用 `0004_attachments.sql` 慣例）。

### 路由

於 `app.ts` 掛在 `/api/reports`，中介層比照 `/api/conversations`：`resolveTenant, requireAuth, tenantRateLimit`（不掛 `tenantMonthlyQuota`——那是對話輪次額度，報告的成本已由同租戶單一任務與節數上限守住）。

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/reports/:id` | job 狀態 + 進度（`doneSections` / `totalSections`） |
| GET | `/api/reports/:id/download?format=md\|html` | 下載；`format` 預設 `md` |

下載回應帶 `Content-Disposition: attachment; filename="<slug>.md"`，MIME 分別為 `text/markdown; charset=utf-8` 與 `text/html; charset=utf-8`。

### HTML 渲染

單一內嵌 `<style>` 的極簡模板，**零外部資源**（無 CDN、無字型連結），確保離線與內網可開、可直接列印。所有由 LLM 或知識庫來的字串（標題、內文、來源標題、url）一律 escape 後再插入——內容來自被爬取的外部網站，必須當作不可信輸入處理。

## 對話與前端契約

`AgentTurnResult` 目前只有 `reply`，`TurnResult` 只有 `reply / status / values / submission / suggestions`，沒有能承載「產出物參考」的欄位。兩者各加一個選填欄位：

```ts
// shared/src/index.ts
export interface ReportRef {
  id: string;
  /** 建立當下恆為 queued；後續狀態由前端輪詢取得 */
  status: 'queued';
}

// AgentTurnResult 與 TurnResult 皆加：
report?: ReportRef;
```

命名就叫 `report`，不做泛化的 `artifact`——目前只有這一種產出物，泛化會憑空多一層而沒有第二個使用者。

前端在收到帶 `report` 的回合後，於訊息下方顯示狀態區塊，輪詢 `GET /api/reports/:id`：進行中顯示進度、`done` 顯示 Markdown / HTML 兩個下載連結、`empty` 顯示查無資料、`failed` 顯示失敗訊息。

## 服務註冊與授權

`report.agent-service.ts` 實作 `AgentService`：

```ts
id: 'report'
label: '知識庫報告'
sticky: false            // 旁路服務：不奪走填表流程，不動 session.values / status
serviceScope: 'service:report'
intents: [{ id: 'report.generate', keywords: ['報告', '彙整', '整理一份', 'report', '總結'], ... }]
```

於 `service.registry.ts` 註冊，並在 `authz/scope-catalog.ts` 新增 `service:report`。

用**獨立 scope** 而非掛在 `service:knowledge` 底下：報告的成本是單次問答的數倍，租戶必須能只開問答、不開報告。共用 scope 會讓這個決定無法表達。

### 意圖區隔

`report.generate` 與 `kb.query` 都在知識庫上工作，關鍵字有重疊風險（「說明」「整理」）。區隔寫進 intent description：**要一份可帶走的文件 → report；要一個問題的答案 → kb.query**。並補測試：「請假規定是什麼」→ knowledge、「幫我整理一份請假規定的報告」→ report。

## 成本

一份報告的 LLM 呼叫上界：

| 階段 | 次數 | 模型 | maxTokens |
|---|---|---|---|
| 主題抽取 | 1 | `LLM_ROUTER_MODEL` | 128 |
| 大綱 | 1 | 預設 | 512 |
| rerank | ≤ 6 | `LLM_ROUTER_MODEL` | 128 |
| 節彙整 | ≤ 6 | 預設 | 1200 |

最壞情況 14 次，其中 7 次走便宜模型。每次都必須過 `usageStore.recordLLMUsage(tenantId, result)`，成本才在既有的用量統計裡可見。

## 設定

| 環境變數 | 預設 | 用途 |
|---|---|---|
| `REPORT_MAX_SECTIONS` | 6 | 大綱節數上限 |
| `REPORT_SECTION_TOP_K` | 5 | 每節交給彙整 LLM 的片段數 |
| `REPORT_TTL_HOURS` | 24 | 產出物保存時數 |

語系跟 `session.locale` 走（`normalizeLocale`），中英兩套 prompt 與固定語句，比照 `kbAnswerSystem` 現行做法。

## 測試

一律不打真資料庫、不打真 LLM（比照現行 `server/tests/` 慣例，以假 client 注入）。

- **outline**：正常 JSON；帶前後綴的 JSON；非 JSON → 判定 failed；節數超限截斷。
- **compose**：零命中節保留標題且不呼叫 LLM；單節 LLM 失敗 → `degraded` 且內容為片段列表；節之間不共享脈絡（驗證傳給 LLM 的 input 不含他節內容）。
- **render**：md / html 快照，含來源清單去重、`degraded` 標註、HTML escape（餵入含 `<script>` 的標題）。
- **job**：狀態流轉 queued→outlining→composing→done；全零命中 → `empty` 且未存檔；同租戶併發 → 409。
- **store**：TTL 過期回收；db 模式 write-through 後可讀回（假 Prisma client）。
- **agent-service**：主題抽取失敗 → 不建 job 並回問；旁路不變式（`session.values` / `session.status` 未被觸碰）。
- **意圖路由**：問答句 → knowledge、報告句 → report。
- **授權**：無 `service:report` scope → 服務不在 `enabledFor`；跨租戶 / 非建立者下載 → 404。
