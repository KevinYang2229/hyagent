# 設計：知識庫 · 資料夾批次匯入與監控

日期：2026-08-13
狀態：設計待確認

## Context（為什麼做）

目前把文件加進知識庫只有一條路：admin 後台一次上傳一個檔
（[`knowledge.admin.controller.ts` 的 `uploadFile`](../../../server/src/modules/knowledge/knowledge.admin.controller.ts)，
multer `files: 1`）。要匯入幾十份規章文件時，這條路要按幾十次、每次都得等前一份跑完
embedding 才能傳下一份，且瀏覽器必須全程開著。

本設計新增第二條入口：**把檔案丟進約定好的資料夾，由一支長駐的 watcher 自動、依序消化完。**

`2026-07-02-admin-rag-ingestion-design.md` 當時把「排程自動重爬」列為 Non-Goal，
本設計不推翻那個決定——這裡自動化的是**檔案來源**，不是網站重爬。

### 為什麼不開獨立專案

現有管線已經是可直接呼叫的函式，不需要跨專案：

- `knowledge-file.service.ts` 的 `ingestFile(tenantId, name, buf)` 就是完整的
  「解析 → 切塊 → 摘要 → embedding → 併進索引 → 更新 meta」入口，且不依賴 Express request。
- `doc-parse.ts` 已支援 `.txt / .md / .htm / .html / .doc / .docx / .pdf`。
- `server/scripts/` 已有 `knowledge-ingest.ts` 這類 CLI 的慣例與 npm script 掛法。

獨立專案只有兩種活法：複製整條解析／切塊／embedding／索引寫入邏輯（兩邊必然走鐘），
或隔著 HTTP 一個一個打 upload API（繞遠路，還受制於 multer 的單檔與 10MB 限制）。
故：**新增模組於 `server`，不開新 repo。**

### 為什麼 CLI 而非 server 進程內

[`DEPLOY.zeabur.md`](../../../DEPLOY.zeabur.md) 明載正式環境的容器檔案系統為 ephemeral，
`server/data/` 不在映像檔內，**正式環境必須 `DATA_BACKEND=db`**。也就是說部署中的 server
根本沒有持久資料夾可監控；要走進程內 watcher 就得先在 Zeabur 加掛 volume，再另做一套
「檔案怎麼進到那顆 volume」的介面——繞回原點。

反過來，`DATA_BACKEND=db` 時索引存在 Supabase 的 `knowledge_chunks`
（`knowledge.index.repo.ts`）。**任何連得到那個 DB 的 process 跑批次，寫進去的就是正式索引**，
server 不需要在跑。這使本機 CLI 成為成本最低且效果等同的作法。

## 決策（已與使用者確認）

- **不開獨立專案**：新增模組於 `server`，CLI 進入點放 `server/scripts/`。
- **子資料夾名 = tenantId**：一支 watcher 服務所有租戶，新增租戶只需新建資料夾。
- **消化後搬檔**：成功搬 `_done/`，失敗搬 `_failed/`。資料夾本身即狀態，去重自動成立。
- **輪詢而非 fs 事件**：不引入 `chokidar`；以 mtime + size 連續兩輪穩定判定「寫完」。
- **來源抽介面**：本機 fs 為第一個實作，上線形態未定時保留替換空間。
- **以 append-only 寫入消滅競態，不引入任何鎖**（見「併發與競態」，此為對初版設計的更正）。
- **RAG 邏輯與 admin 上傳完全一致**：共用 `ingestFile`，不另闢分支（見「與 admin 上傳的一致性」）。
- **批次時延後推薦問句重生**：`ingestFile` 加 `deferSuggestions` 選項，整輪跑完統一觸發一次。

## Goals / Non-Goals

**Goals**
- 把多個檔案放進一個資料夾，watcher 依序全部消化進對應租戶的知識庫索引。
- 消化結果與 admin 後台單檔上傳完全一致（同一條 `ingestFile` 管線，不另闢分支）。
- 單檔失敗不中斷整批；失敗原因可從資料夾直接看到。
- 批次進行中，後台的上傳／刪檔／推薦詞生成不會與之互相覆寫索引。
- 開跑前可預估規模與成本（`--dry-run`）。

**Non-Goals（本輪不做）**
- server 進程內的長駐 watcher 與 Zeabur volume（方案 B）。留待實際壓力出現再升級。
- S3／物件儲存實作。介面留好，實作不做。
- admin UI 的多檔上傳。與本設計正交，要做是另一輪。
- BullMQ／跨機佇列。單 process 序列即足夠。
- 原始檔保存。沿用現行「不保存原始檔」的決定（`knowledge-file.service.ts` 檔頭）。

## 架構總覽

```
<root>/                         ← --root 指定
  default/                      ← 子資料夾名 = tenantId
    年假規則.pdf                 ← 待處理
    出差辦法.docx
    _done/                      ← 消化成功
    _failed/                    ← 永久性失敗 + 同名 .error.txt
  7db2f14abfe2d589/
    ...

        │ 輪詢 readdir（預設 30s）
        ▼
scripts/knowledge-watch.ts      ← CLI 殼：參數、迴圈、log、訊號處理
        │
        ▼
modules/knowledge/folder-ingest.service.ts   ← 純邏輯，可測
        │  1. scan   → PendingItem[]（過濾、穩定性判定）
        │  2. 同名檔先 removeFile()
        │  3. ingestFile(tenantId, name, buf, { deferSuggestions: true })
        │  4. 搬 _done/ 或 _failed/
        │  5. 整輪結束：refreshSuggestedPrompts 一次
        ▼
        既有：解析 → 切塊 → 摘要 → embedding → appendChunks → knowledge_chunks
```

`_` 前綴讓 `_done` / `_failed` 不會被誤判成 tenantId。

## 與 admin 上傳的一致性

batch 與 admin 單檔上傳呼叫**同一個 `ingestFile`**，不是兩份平行實作。因此所有影響
檢索品質的決定點都由既有程式碼共同決定，batch 不引入任何 RAG 語意上的分歧：

| RAG 決定點 | 兩條路皆為 |
|---|---|
| 格式解析 | `parseDocument`（docx/htm→Markdown 保結構；doc/pdf 降級並標 `fidelity`） |
| 文字正規化 | `normalizeDocText`（保留段落換行） |
| 切塊 | `chunkMarkdown(text, source.chunkChars)`，`chunkChars` 取自該租戶設定 |
| 全文摘要 chunk | `pieces.length >= 2` 才生成 |
| embedding 模型 | `existing?.model ?? source.embeddingModel` |
| chunk 結構 | 同樣的 `id` / `url: file://<name>` / `title` / `fileId` |
| meta | 同樣寫 `meta.files`、`chunkCount`、`chunkCountBySource` |

查詢端不受影響且無法區分來源：`splitChunksBySource` 依 chunk 有無 `fileId` 分類，
兩條路產出的 chunk 都帶 `fileId`，一律歸為 `file` 來源。

**刻意的差異只有三處**，皆不影響 RAG 語意：

1. **單檔上限**：admin 10MB（HTTP 請求體保護）vs batch `--max-mb`（預設 50）。
2. **同名檔**：admin 累加成兩份 chunks；batch 先 `removeFile` 再 ingest（見「同名檔視為更新」）。
3. **推薦問句重生時機**：admin 每檔即時觸發；batch 整輪結束統一觸發一次（見「併發與競態 §3」）。

`appendChunks` / `removeFileChunks` 的改動兩條路共用（`ingestFile` 與 `removeFile` 內部），
故 admin 上傳同樣受益於點狀寫入，兩條路的寫入語意仍然一致。

### embedding 模型不由 batch 決定

`ingestFile` 內的 `const model = existing?.model ?? source.embeddingModel` 有兩層語意：

- **租戶已有索引** → 一律沿用索引裡記的 `model`，忽略設定值與環境變數。
  故 batch **不可能**在既有索引中混入第二種模型。
- **全新租戶** → 用 `knowledgeStore.getSource(tenantId).embeddingModel`
  （後台設定值；未設過則 `env.EMBEDDING_MODEL`，預設 `text-embedding-3-large`）。

查詢端 `retriever.pgvector` 讀的是 `knowledge_indexes.model`，與寫入端同一來源，
不會出現「A 模型建索引、B 模型查詢」的錯配。

**故不提供 `--embedding-model` 覆寫參數**——那正好會製造「batch 與 admin 用不同模型」
的可能性，與本設計目標相反。

唯一要留意的是：**全新租戶第一次匯入時模型即定型**，之後改設定不影響既有索引，
要換只能清空重建。因此 watcher 啟動時（與 `--dry-run`）須列出每個租戶即將使用的模型，
並對「本次將建立新索引」的租戶特別標示。

## 來源介面

```ts
/** 批次匯入的來源抽象：本機 fs 為第一個實作，未來可換 S3／NAS 而不動管線 */
export interface BatchSource {
  /** 列出所有 (tenantId, 項目) 待處理配對；已過濾副檔名與保留目錄 */
  list(): Promise<PendingItem[]>;
  /** 讀取項目內容 */
  read(item: PendingItem): Promise<Buffer>;
  /** 標記完成：搬進 _done / _failed（失敗時附 reason 落地成 .error.txt） */
  settle(item: PendingItem, outcome: 'done' | 'failed', reason?: string): Promise<void>;
}

export interface PendingItem {
  tenantId: string;
  /** 送進 ingestFile 的檔名（顯示於知識庫檔案清單） */
  name: string;
  /** 來源內部識別（本機 fs = 絕對路徑） */
  ref: string;
  size: number;
  /** 穩定性判定用；來源若無此概念可回 null（則視為永遠穩定） */
  mtimeMs: number | null;
}
```

管線只依賴這三個方法。`LocalFolderSource` 為本輪唯一實作。

## 掃描與穩定性判定

不引入 `chokidar`。理由不是「Drive 特別不可靠」，而是**任何非原子落地的來源都需要穩定性檢查**
（rsync/scp 傳到一半、SMB 複製大檔、瀏覽器拖放大 PDF）；既然檢查免不了，fs 事件就沒有帶來
額外價值，只帶來一個依賴與一組平台差異。

規則：

1. 每 `--interval` 秒（預設 30）`readdir` 一次 root 下的每個租戶資料夾（不遞迴）。
2. 只收 `SUPPORTED_EXTENSIONS`（`doc-parse.ts` 已 export，單一來源不重複定義）。
3. 忽略 `.` 開頭（`.DS_Store`、同步中繼檔）與 `_` 開頭（保留目錄）。
4. **穩定性**：記住上一輪的 `(mtimeMs, size)`；唯有連續兩輪完全相同才視為寫完、納入處理。
   第一次見到的檔案一律等下一輪。
5. 超過 `MAX_FILE_MB`（預設 50，可用 `--max-mb` 調整）者直接判失敗搬 `_failed/`。
   註：此上限與 admin 上傳的 10MB（`upload.ts` 的 `MAX_FILE_SIZE_MB`）刻意不同——
   後者是 HTTP 請求體的保護，批次是本機讀檔，無此限制，但仍需一個上限避免單檔拖垮整批。

## 併發與競態

索引寫入是「整份載入 → 合併 → 整份取代」（`knowledge.index.repo.ts` 檔頭明載），
沒有任何鎖。四個層次：

### 1. 批次內：嚴格序列

一次處理一個檔，`await` 完才下一個。平行處理必然互相覆寫。
不做平行化——瓶頸在 embedding API，而 `embedInBatches` 內部已分批。

### 2. 批次 vs server：append-only 寫入（不用鎖）

**初版設計此處經過兩次更正，以下為最終結論。**

第一版打算把 watcher 登記進 `knowledge.job.ts` 的 job Map，讓後台既有的 409 守門保護批次。
行不通：那個 Map 是 process 內記憶體（`const jobs = new Map<string, IngestJob>()`），
watcher 是獨立 CLI process，兩邊互相看不見。

第二版改用 Postgres advisory lock。**也不可行**：`pg_try_advisory_lock` 是**連線層級**的鎖，
而 `PrismaClient` 有自己的連線池、Supabase 前面還有 pooler——上鎖與解鎖可能落在不同連線，
解鎖失敗則該鎖留到連線回收為止，之後所有上傳一律 409。

第三版（採用）：**根本不需要鎖，因為競態的根源是「整份取代」這個寫法，而非缺鎖。**

`saveIndexToDb` 目前是「`delete from knowledge_chunks where tenant_id = ?` 刪光，
再分批塞回全部」。但 `ingestFile` 語意上做的事只是「新增這個檔的 chunks」，
`removeFile` 只是「移除這個檔的 chunks」——兩者都不需要重寫其他檔案的資料。
改成點狀操作後，兩個 process 同時匯入不同檔案寫的是不同的列，**根本不會衝突**。

`knowledge.index.repo.ts` 新增兩個對外函式（`saveIndex` / `loadIndex` / `deleteIndex` 保留不動，
全站重爬仍需整份取代語意）：

```ts
/** 附加 chunks 並 upsert 索引 metadata；不觸碰其他 chunks。索引不存在時一併建立 */
export async function appendChunks(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): Promise<void>;

/** 移除指定 fileId 的 chunks 並更新 generatedAt；查無該 fileId 回 false */
export async function removeFileChunks(tenantId: string, fileId: string): Promise<boolean>;
```

- **db 後端**：`appendChunks` 為單一交易內的分批 INSERT（沿用既有的 `CHUNK_INSERT_BATCH`
  與 `on conflict do update`）+ `knowledge_indexes` upsert，**無 delete**。
  `removeFileChunks` 為 `delete from knowledge_chunks where tenant_id = ? and file_id = ?`。
- **file 後端**：JSON 單檔無法點狀更新，仍為 read-modify-write。可接受——該模式下
  watcher 是唯一寫入者（server 不共用同一份檔案系統），本來就無跨 process 競態。
- 兩者皆須沿用 `saveIndex` 既有的快取失效（`invalidateIndexCache` +
  `invalidatePgvectorModelCache`），否則檢索器會撈到舊資料。

**順帶解決的效能問題**：現行每次上傳／刪檔都會「刪 1470 列再塞回」（程式碼註解自述）。
批次匯入 50 個檔即重寫全表 50 次。改點狀操作後只寫新增的數十列。

**server 端無須任何守門改動**——既有的 `getRunningJobForTenant` 409 檢查原封不動保留
（它擋的是同 process 內的爬網，仍然有效且仍然必要）。

### 2.1 剩餘的競態：批次匯入 vs 全站重爬

`runIngest`（爬網）本質就是整份取代，這是它的正確語意；`carryOverFileChunks` 讀的是
爬取開始當下的快照，故批次在爬網期間 append 的 chunks 會被爬網結束時的整份取代抹掉。

**本輪不為此建基礎設施**。重爬是 admin 手動觸發的低頻破壞性操作，處置方式為文件與提示：

- watcher 啟動時印出提醒：重爬期間請勿執行批次匯入。
- 若之後此情境真的發生，正解是把爬網的「進行中」狀態寫進 `knowledge_indexes`
  使其跨 process 可見，而非引入鎖。列入「風險與未決」。

### 3. 批次時延後推薦問句重生

`ingestFile` 結尾有 `void refreshSuggestedPrompts(tenantId, idx).catch(() => {})`
——每匯入一個檔就在背景重新生成一次開場推薦問句，而那是 LLM 呼叫。

單檔上傳時完全合理；批次匯入 N 個檔就是觸發 N 次，每次 1~2 次 LLM 呼叫。
`knowledge.suggest.ts` 的世代編號機制（`beginGeneration` / `isLatestGeneration`）會讓
早發動的呼叫在寫入前發現自己已過期而放棄寫入——**資料不會錯，但那 N~2N 次呼叫裡
只有最後一次的結果會被保留，其餘全是純浪費**，且浪費量與檔案數成正比、有撞 rate limit 之虞。

故：`ingestFile` 增加選用參數 `opts?: { deferSuggestions?: boolean }`（預設 `false`）。

- `true` 時跳過結尾的 `refreshSuggestedPrompts` 觸發，其餘行為完全不變。
- batch 逐檔傳 `true`，該租戶本輪全部處理完後，以最終索引統一觸發一次。
- **admin 單檔上傳不傳此參數，行為完全不變**（預設 false）。
- 本輪未處理任何檔案的租戶不觸發。

### 4. 同名檔視為更新

`ingestFile` 不檢查檔名重複——同名檔會在索引留下兩份 chunks 與兩筆 `meta.files`。
批次重丟改版文件時極易踩到。故：ingest 前若 `knowledgeStore.getMeta(tenantId).files`
已有同名項，先 `removeFile(tenantId, fileId)` 再 ingest。

此行為僅作用於批次路徑，不改變 admin 單檔上傳的既有語意（該處保持原樣，避免影響既有操作預期）。

### 既有程式碼的改動清單

本設計會修改的既有檔案僅以下三處，皆為加法，不改變任何既有呼叫端的行為：

| 檔案 | 改動 |
|---|---|
| `knowledge.index.repo.ts` | 新增 `appendChunks` / `removeFileChunks`（§2）；既有三個函式不動 |
| `knowledge-file.service.ts` | `ingestFile` 改用 `appendChunks`、`removeFile` 改用 `removeFileChunks`（§2）；`ingestFile` 加 `opts.deferSuggestions`（§3） |
| `package.json`（server） | 新增 `watch:knowledge` script |

`knowledge.admin.controller.ts` **不需改動**。

## 錯誤處理

錯誤分兩類，處置**不同**——這是本設計最容易做錯的地方：

| 類別 | 例子 | 處置 |
|---|---|---|
| **永久性** | 掃描檔無文字、空檔、不支援格式、magic bytes 不符、超過大小上限 | 搬 `_failed/` + 同名 `.error.txt` 記原因。重試不會有不同結果 |
| **暫時性** | embedding API 逾時、額度用罄、DB 連線中斷或交易失敗 | **不搬檔**。retry 一次（間隔 5s），仍失敗就留在原地，下一輪重試，印 warn |

判定依據：`AppError` 的 `unprocessable` / `badRequest` 視為永久性，其餘（含未預期例外）
視為暫時性。保守方向正確——把暫時性誤判為永久性會丟掉檔案，反之只是多試幾輪。

單檔失敗一律不中斷整批。整輪結束印摘要：`done / failed / retry / skipped` 各幾件。

## CLI 介面

```
npm run watch:knowledge -w server -- --root=<path> [options]

  --root=<path>      必填。要監控的根目錄
  --interval=<sec>   輪詢間隔，預設 30
  --once             掃一輪就結束（可掛 cron，或手動批次）
  --dry-run          只列出將處理什麼與預估規模，不呼叫任何 API、不搬檔
  --max-mb=<n>       單檔上限，預設 50
  --tenant=<id>      只處理指定租戶的子資料夾
```

`package.json` 加 `"watch:knowledge": "tsx scripts/knowledge-watch.ts"`，
與既有 `ingest:knowledge` / `migrate:knowledge` 同慣例。

`SIGINT` / `SIGTERM`：完成當前檔案後才退出（避免留下寫到一半的索引），第二次訊號強制退出。

## 成本可見性

每個切出 ≥2 chunks 的檔會**額外**打一次 LLM 摘要
（`knowledge-file.service.ts` 的 `summarizeText`，用 `LLM_ROUTER_MODEL`）。
批次匯入幾十份文件時這筆費用會累積，故：

- 每輪開跑前印 `將處理 N 個檔 / 共 X MB`，並逐租戶印出即將使用的 embedding 模型；
  對「本次將建立新索引」的租戶特別標示（模型於此刻定型，見「embedding 模型不由 batch 決定」）。
- `--dry-run` 列出完整清單、總量與上述模型資訊，不呼叫任何付費 API。
- 每檔完成印 `✓ <name> — N chunks`。

推薦問句重生的浪費已由 `deferSuggestions` 消除（見「併發與競態 §3」）：
N 個檔從 N~2N 次 LLM 呼叫降為每租戶每輪 1~2 次。摘要呼叫則每檔一次、無法省略。

## 前置條件（操作者必讀）

本機執行時 `server/.env` 必須是 `DATA_BACKEND=db` 且指向正式的 Supabase，
並具備 `OPENAI_API_KEY`（或租戶自帶金鑰）。

若為 `DATA_BACKEND=file`，消化結果會寫進本機 `server/data/knowledge-index.*.json`，
**正式環境完全看不到**。watcher 啟動時印出目前的 `DATA_BACKEND` 與目標，
且在 `file` 模式下印一行明確警告。

## 測試計畫

`server/tests/folder-ingest.test.ts`（tmpdir 建假資料夾樹，mock `ingestFile` 與 `removeFile`）：

- 掃描產出正確的 `(tenantId, name)` 配對；巢狀子資料夾不遞迴
- `_done` / `_failed` / `.` 開頭 / 不支援副檔名 一律被忽略
- 首次見到的檔案不處理；`(mtime, size)` 連續兩輪相同後才處理
- 兩輪之間檔案仍在變大 → 持續不處理
- 成功 → 搬進 `_done/`；永久性失敗 → 搬進 `_failed/` 且產出 `.error.txt`
- 暫時性失敗 → 檔案留在原地、未搬動，且下一輪會重試
- 同名檔已存在於 `meta.files` → 先呼叫 `removeFile` 再 `ingestFile`
- 超過 `--max-mb` → 判永久性失敗
- `--dry-run` → `ingestFile` 零呼叫、檔案零搬動
- 逐檔皆以 `deferSuggestions: true` 呼叫；整輪結束後 `refreshSuggestedPrompts` 恰觸發一次
- 本輪未處理任何檔案的租戶 → `refreshSuggestedPrompts` 零觸發

`server/tests/knowledge-file.test.ts`（既有）需補：
`ingestFile` 不傳 `opts` 時仍會觸發 `refreshSuggestedPrompts`（確保 admin 行為未變）。

`server/tests/knowledge-index-repo.test.ts`（新增）：

- `appendChunks` 只新增指定 chunks，既有 chunks 原封不動
- 對不存在的租戶 `appendChunks` 會一併建立索引 metadata
- `removeFileChunks` 只移除該 `fileId` 的 chunks，其他檔案與網站 chunks 保留
- `removeFileChunks` 對不存在的 fileId 回 `false`
- 兩者皆會呼叫 `invalidateIndexCache` 與 `invalidatePgvectorModelCache`

`server/tests/knowledge-file.test.ts`（既有）需補：
`ingestFile` 不傳 `opts` 時仍會觸發 `refreshSuggestedPrompts`（確保 admin 行為未變）；
連續兩次 `ingestFile` 不同檔案後，先前檔案的 chunks 仍在（append-only 回歸測試）。

## 風險與未決

- **批次匯入 vs 全站重爬**（見「併發與競態 §2.1」）：爬網的整份取代會抹掉批次在
  爬網期間 append 的 chunks。本輪以文件與 watcher 啟動提示處理，不建基礎設施。
  若真的發生，正解是把爬網的「進行中」狀態寫進 `knowledge_indexes` 使其跨 process 可見。
- **`DATA_BACKEND=file` 下 `appendChunks` 仍是 read-modify-write**：JSON 單檔無法點狀更新。
  該模式下 watcher 是唯一寫入者，無跨 process 競態，可接受。
- **watcher 只在執行時運作**：本輪明確接受。若之後「必須 24/7 無人值守」成真，
  升級路徑是把 `folder-ingest.service` 整塊搬進 server 進程 + Zeabur volume，
  service 層不需改寫（`--once` 與 `BatchSource` 介面就是為此留的接縫）。
- **上線形態未定**：`BatchSource` 介面吸收此不確定性。若上線走 S3，
  新增 `S3BatchSource` 實作即可——`@aws-sdk/client-s3` 與 `S3_*` 環境變數已在
  `server/package.json` 與 `config/env.ts` 中宣告但**尚無任何程式碼使用**，屆時一併接上。
- **`_done/` 會無限增長**：本輪不做自動清理，由操作者自行處置。
