# 知識庫資料夾批次匯入與監控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把多個文件放進約定好的資料夾，由一支長駐 CLI watcher 依序全部消化進對應租戶的知識庫索引，RAG 邏輯與 admin 單檔上傳完全一致。

**Architecture:** 新增 `folder-ingest.service.ts`（純邏輯，可測）+ `scripts/knowledge-watch.ts`（CLI 殼），沿用既有 `ingestFile` 管線。先把 `knowledge.index.repo.ts` 的「整份取代」寫入改為點狀的 `appendChunks` / `removeFileChunks`，從根源消滅跨 process 競態，不引入任何鎖。來源以 `BatchSource` 三方法介面抽象，本輪只實作本機 fs。

**Tech Stack:** TypeScript (NodeNext)、Express、Prisma + Postgres(pgvector)、Jest + ts-jest、tsx（CLI 執行）。**不新增任何 npm 依賴。**

**Spec:** [docs/superpowers/specs/2026-08-13-knowledge-folder-batch-ingest-design.md](../specs/2026-08-13-knowledge-folder-batch-ingest-design.md)

## Global Constraints

- **不新增 npm 依賴**。不裝 `chokidar`；輪詢 + mtime 穩定性判定自行實作。
- **既有呼叫端行為零變更**。`ingestFile` 新增的 `opts` 為選用參數且預設關閉；`saveIndex` / `loadIndex` / `deleteIndex` 三個既有函式**不得修改**（全站重爬仍需整份取代語意）。
- **不修改 `knowledge.admin.controller.ts`**。既有的 `getRunningJobForTenant` 409 守門原封不動保留。
- **所有註解與 log 訊息用繁體中文**，比照該模組既有風格。
- 測試環境固定 `DATA_BACKEND=file`（`tests/setup-env.ts` 已設定），故單元測試涵蓋的是 file 後端路徑；db 後端路徑以型別與 code review 把關。
- 路徑別名 `@/` 對應 `server/src/`。測試放 `server/tests/*.test.ts`。
- commit message 遵循 Conventional Commits，scope 用 `knowledge`。

---

## File Structure

| 檔案 | 責任 | 動作 |
|---|---|---|
| `server/src/modules/knowledge/knowledge.index.repo.ts` | 索引持久化層 | **修改**：新增 `appendChunks` / `removeFileChunks` |
| `server/src/modules/knowledge/knowledge-file.service.ts` | 檔案 ingest 管線 | **修改**：改用點狀寫入 + `opts.deferSuggestions` |
| `server/src/modules/knowledge/batch-source.ts` | `BatchSource` / `PendingItem` 型別 + `LocalFolderSource` | 新增 |
| `server/src/modules/knowledge/folder-ingest.service.ts` | 穩定性判定、錯誤分類、單輪執行 | 新增 |
| `server/scripts/knowledge-watch.ts` | CLI 殼：參數、迴圈、log、訊號處理 | 新增 |
| `server/package.json` | `watch:knowledge` script | **修改** |
| `server/tests/knowledge-index-repo.test.ts` | Task 1 測試 | 新增 |
| `server/tests/batch-source.test.ts` | Task 3 測試 | 新增 |
| `server/tests/folder-ingest.test.ts` | Task 4、5 測試 | 新增 |
| `server/tests/knowledge-file.test.ts` | 既有 | **修改**：補 append-only 與 `deferSuggestions` 回歸測試 |

---

## Task 1: 索引持久化層的點狀寫入

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.index.repo.ts`
- Test: `server/tests/knowledge-index-repo.test.ts`

**Interfaces:**
- Consumes: 既有 `loadIndexFromFile` / `saveIndexToFile` / `connectDb` / `CHUNK_INSERT_BATCH` / `toVectorLiteral` / `SAVE_TX_TIMEOUT_MS` / `invalidateIndexCache` / `invalidatePgvectorModelCache`（皆已存在於該檔）
- Produces:
  ```ts
  export async function appendChunks(
    tenantId: string,
    chunks: IndexedChunk[],
    meta: { model: string; source: string },
  ): Promise<void>;

  export async function removeFileChunks(tenantId: string, fileId: string): Promise<boolean>;
  ```

- [ ] **Step 1: 寫失敗的測試**

建立 `server/tests/knowledge-index-repo.test.ts`：

```ts
/** 索引持久化層的點狀寫入：appendChunks 只加、removeFileChunks 只刪該檔，皆不動其他 chunks。 */
import { existsSync, rmSync } from 'node:fs';
import { appendChunks, loadIndex, removeFileChunks } from '@/modules/knowledge/knowledge.index.repo';
import { indexPathFor } from '@/modules/knowledge/index-path';
import type { IndexedChunk } from '@/modules/knowledge/knowledge-index.types';

function chunk(id: string, fileId?: string): IndexedChunk {
  return {
    id,
    url: fileId ? `file://${fileId}` : 'https://example.com/a',
    title: id,
    text: `內容 ${id}`,
    vector: [0.1, 0.2, 0.3],
    ...(fileId ? { fileId } : {}),
  };
}

/** 每個測試用獨立 tenantId，並清掉可能殘留的索引檔 */
function freshTenant(name: string): string {
  const tenantId = `repo-${name}`;
  const path = indexPathFor(tenantId);
  if (existsSync(path)) rmSync(path);
  return tenantId;
}

describe('appendChunks', () => {
  it('索引不存在時一併建立 metadata', async () => {
    const t = freshTenant('create');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'test-embed', source: 'file://a.txt' });

    const idx = await loadIndex(t);
    expect(idx).not.toBeNull();
    expect(idx!.model).toBe('test-embed');
    expect(idx!.source).toBe('file://a.txt');
    expect(idx!.chunks.map((c) => c.id)).toEqual(['a-0']);
  });

  it('只新增指定 chunks，既有 chunks 原封不動', async () => {
    const t = freshTenant('append');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'test-embed', source: 'file://a.txt' });
    await appendChunks(t, [chunk('b-0', 'b'), chunk('b-1', 'b')], { model: 'test-embed', source: 'file://b.txt' });

    const idx = await loadIndex(t);
    expect(idx!.chunks.map((c) => c.id).sort()).toEqual(['a-0', 'b-0', 'b-1']);
  });

  it('既有索引的 model 不因後續 append 而改變', async () => {
    const t = freshTenant('model');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'first-model', source: 'file://a.txt' });
    await appendChunks(t, [chunk('b-0', 'b')], { model: 'second-model', source: 'file://b.txt' });

    const idx = await loadIndex(t);
    expect(idx!.model).toBe('first-model');
  });

  it('空陣列為 no-op，不建立索引', async () => {
    const t = freshTenant('empty');
    await appendChunks(t, [], { model: 'test-embed', source: 'file://x.txt' });
    await expect(loadIndex(t)).resolves.toBeNull();
  });
});

describe('removeFileChunks', () => {
  it('只移除該 fileId 的 chunks，其他檔案與網站 chunks 保留', async () => {
    const t = freshTenant('remove');
    await appendChunks(
      t,
      [chunk('site-0'), chunk('a-0', 'a'), chunk('b-0', 'b')],
      { model: 'test-embed', source: 'https://example.com' },
    );

    await expect(removeFileChunks(t, 'a')).resolves.toBe(true);

    const idx = await loadIndex(t);
    expect(idx!.chunks.map((c) => c.id).sort()).toEqual(['b-0', 'site-0']);
  });

  it('查無該 fileId 回 false 且不動索引', async () => {
    const t = freshTenant('remove-miss');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'test-embed', source: 'file://a.txt' });

    await expect(removeFileChunks(t, 'nope')).resolves.toBe(false);
    const idx = await loadIndex(t);
    expect(idx!.chunks).toHaveLength(1);
  });

  it('索引不存在回 false', async () => {
    const t = freshTenant('remove-none');
    await expect(removeFileChunks(t, 'a')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd server && npx jest tests/knowledge-index-repo.test.ts
```

Expected: FAIL — `appendChunks is not a function`（模組尚未 export）

- [ ] **Step 3: 實作 file 後端**

在 `knowledge.index.repo.ts` 的 `// ---- db 後端 ----` 分隔線**之前**（file 後端區塊末尾、`deleteIndexFromFile` 之後）加入：

```ts
/**
 * file 後端的附加：JSON 單檔無法點狀更新，仍為 read-modify-write。
 * 該模式下不存在跨 process 寫入者（server 與 watcher 不共用檔案系統），故可接受。
 */
function appendChunksToFile(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): void {
  const existing = loadIndexFromFile(tenantId);
  saveIndexToFile(
    tenantId,
    existing
      ? { ...existing, generatedAt: new Date().toISOString(), chunks: [...existing.chunks, ...chunks] }
      : { generatedAt: new Date().toISOString(), model: meta.model, source: meta.source, chunks },
  );
}

/** file 後端的點狀刪除；該 fileId 沒有任何 chunk 時回 false 且不寫檔 */
function removeFileChunksFromFile(tenantId: string, fileId: string): boolean {
  const existing = loadIndexFromFile(tenantId);
  if (!existing) return false;
  const chunks = existing.chunks.filter((c) => c.fileId !== fileId);
  if (chunks.length === existing.chunks.length) return false;
  saveIndexToFile(tenantId, { ...existing, generatedAt: new Date().toISOString(), chunks });
  return true;
}
```

- [ ] **Step 4: 實作 db 後端**

在 `deleteIndexFromDb` 之後加入：

```ts
/**
 * db 後端的附加：**只 INSERT，不 delete**。
 *
 * 這是與 saveIndexToDb 的關鍵差異，也是本設計不需要任何鎖的原因——
 * 兩個 process 同時匯入不同檔案寫的是不同的列，天然不衝突。
 * saveIndexToDb 的「刪光再塞回」語意保留給全站重爬（那才真的要整份取代）。
 *
 * knowledge_indexes 的 upsert **不更新 model 與 source**：既有索引的 embedding 模型
 * 一旦定型就不能被後續附加改掉（同一份索引只能用同一個模型）。
 */
async function appendChunksToDb(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): Promise<void> {
  const db = await connectDb();
  await db.$transaction(
    async (tx) => {
      for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
        const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
        const values = batch.map(
          (c) => Prisma.sql`(${tenantId}, ${c.id}, ${c.url}, ${c.title}, ${c.text}, ${c.fileId ?? null},
                            ${toVectorLiteral(c.vector)}::halfvec(3072))`,
        );
        await tx.$executeRaw`
          insert into knowledge_chunks (tenant_id, id, url, title, text, file_id, embedding)
          values ${Prisma.join(values)}
          on conflict (tenant_id, id) do update set
            url = excluded.url, title = excluded.title, text = excluded.text,
            file_id = excluded.file_id, embedding = excluded.embedding
        `;
      }

      await tx.$executeRaw`
        insert into knowledge_indexes (tenant_id, generated_at, model, source, updated_at)
        values (${tenantId}, ${new Date()}, ${meta.model}, ${meta.source}, now())
        on conflict (tenant_id) do update set
          generated_at = excluded.generated_at, updated_at = now()
      `;
    },
    { timeout: SAVE_TX_TIMEOUT_MS },
  );
}

/** db 後端的點狀刪除；受影響列數為 0 時回 false */
async function removeFileChunksFromDb(tenantId: string, fileId: string): Promise<boolean> {
  const db = await connectDb();
  const deleted = await db.$executeRaw`
    delete from knowledge_chunks where tenant_id = ${tenantId} and file_id = ${fileId}
  `;
  if (deleted === 0) return false;
  await db.$executeRaw`
    update knowledge_indexes set generated_at = now(), updated_at = now() where tenant_id = ${tenantId}
  `;
  return true;
}
```

- [ ] **Step 5: 加上對外介面**

在 `// ---- 對外介面 ----` 區塊、`deleteIndex` 之後加入：

```ts
/**
 * 附加 chunks 並 upsert 索引 metadata；**不觸碰其他 chunks**。索引不存在時一併建立。
 *
 * 與 saveIndex 的分工：saveIndex 是「整份取代」（全站重爬用），本函式是「點狀附加」
 * （單檔匯入用）。單檔匯入走 saveIndex 會刪光整個租戶的向量再塞回，既是效能浪費，
 * 也讓並行的另一次匯入互相覆寫。
 */
export async function appendChunks(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): Promise<void> {
  if (chunks.length === 0) return;
  if (env.DATA_BACKEND === 'db') await appendChunksToDb(tenantId, chunks, meta);
  else appendChunksToFile(tenantId, chunks, meta);
  invalidateIndexCache(tenantId);
  invalidatePgvectorModelCache(tenantId);
}

/** 移除指定 fileId 的所有 chunks；該檔本來就沒有 chunk 時回 false（不失效快取） */
export async function removeFileChunks(tenantId: string, fileId: string): Promise<boolean> {
  const removed =
    env.DATA_BACKEND === 'db'
      ? await removeFileChunksFromDb(tenantId, fileId)
      : removeFileChunksFromFile(tenantId, fileId);
  if (removed) {
    invalidateIndexCache(tenantId);
    invalidatePgvectorModelCache(tenantId);
  }
  return removed;
}
```

- [ ] **Step 6: 執行測試確認通過**

```bash
cd server && npx jest tests/knowledge-index-repo.test.ts
```

Expected: PASS（10 個測試全過）

- [ ] **Step 7: 確認既有測試未被破壞**

```bash
cd server && npx jest tests/knowledge && npm run typecheck
```

Expected: 全數 PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/knowledge/knowledge.index.repo.ts server/tests/knowledge-index-repo.test.ts
git commit -m "feat(knowledge): 索引持久化層新增點狀寫入 appendChunks/removeFileChunks"
```

---

## Task 2: ingest 管線改用點狀寫入 + deferSuggestions

**Files:**
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts`
- Test: `server/tests/knowledge-file.test.ts`（既有，補測試）

**Interfaces:**
- Consumes: Task 1 的 `appendChunks(tenantId, chunks, meta)` 與 `removeFileChunks(tenantId, fileId)`
- Produces:
  ```ts
  export interface IngestFileOptions {
    /** true 時跳過結尾的推薦問句重生觸發（批次匯入用，整輪結束再統一觸發一次） */
    deferSuggestions?: boolean;
  }
  export async function ingestFile(
    tenantId: string,
    name: string,
    buf: Buffer,
    opts?: IngestFileOptions,
  ): Promise<KnowledgeFileMeta>;
  ```

- [ ] **Step 1: 寫失敗的測試**

在 `server/tests/knowledge-file.test.ts` 檔案**末尾**追加。該檔頂部已 mock 掉 `knowledge.suggest`，先取得該 mock 的參照——在既有的 `import` 區塊之後、`function readIndex` 之前插入：

```ts
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';

const mockRefreshSuggestions = refreshSuggestedPrompts as jest.MockedFunction<
  typeof refreshSuggestedPrompts
>;
```

然後在檔案末尾追加：

```ts
describe('append-only 寫入與 deferSuggestions', () => {
  it('連續匯入兩個檔案，先前檔案的 chunks 仍在', async () => {
    const t = tenantStore.createTenant('kfile-append');
    const long = '公司規章內容說明，適用於全體員工。'.repeat(20);

    const first = await ingestFile(t.id, '規章一.txt', Buffer.from(long));
    const second = await ingestFile(t.id, '規章二.txt', Buffer.from(long));

    const idx = readIndex(t.id);
    const fileIds = new Set(idx.chunks.map((c) => c.fileId));
    expect(fileIds.has(first.fileId)).toBe(true);
    expect(fileIds.has(second.fileId)).toBe(true);
    expect(idx.chunks.length).toBe(first.chunks + second.chunks);
  });

  it('刪除其中一個檔案不影響另一個檔案的 chunks', async () => {
    const t = tenantStore.createTenant('kfile-append-del');
    const long = '公司規章內容說明，適用於全體員工。'.repeat(20);
    const first = await ingestFile(t.id, '規章一.txt', Buffer.from(long));
    const second = await ingestFile(t.id, '規章二.txt', Buffer.from(long));

    await expect(removeFile(t.id, first.fileId)).resolves.toBe(true);

    const idx = readIndex(t.id);
    expect(idx.chunks.every((c) => c.fileId === second.fileId)).toBe(true);
    expect(idx.chunks.length).toBe(second.chunks);
  });

  it('不傳 opts 時仍觸發推薦問句重生（admin 單檔上傳行為未變）', async () => {
    const t = tenantStore.createTenant('kfile-suggest-default');
    mockRefreshSuggestions.mockClear();

    await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)));

    expect(mockRefreshSuggestions).toHaveBeenCalledTimes(1);
  });

  it('deferSuggestions=true 時不觸發推薦問句重生', async () => {
    const t = tenantStore.createTenant('kfile-suggest-defer');
    mockRefreshSuggestions.mockClear();

    await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)), {
      deferSuggestions: true,
    });

    expect(mockRefreshSuggestions).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd server && npx jest tests/knowledge-file.test.ts -t "deferSuggestions"
```

Expected: FAIL — `deferSuggestions=true` 那則仍會呼叫（參數尚未實作）

- [ ] **Step 3: 改 import 與型別**

在 `knowledge-file.service.ts` 中，把既有的

```ts
import { loadIndex, saveIndex } from './knowledge.index.repo';
```

改為

```ts
import { appendChunks, loadIndex, removeFileChunks } from './knowledge.index.repo';
```

並在 `const MIN_TEXT_CHARS = 20;` 之前加入型別：

```ts
export interface IngestFileOptions {
  /**
   * true 時跳過結尾的推薦問句重生觸發。
   *
   * 批次匯入專用：`refreshSuggestedPrompts` 每次都會打 LLM，而它的世代編號機制會讓
   * 早發動的呼叫放棄寫入——N 個檔連續匯入等於白花 N-1 次呼叫。改由批次跑完統一觸發一次。
   */
  deferSuggestions?: boolean;
}
```

- [ ] **Step 4: 改寫 ingestFile 的寫入段**

把 `ingestFile` 的簽章改為：

```ts
export async function ingestFile(
  tenantId: string,
  name: string,
  buf: Buffer,
  opts?: IngestFileOptions,
): Promise<KnowledgeFileMeta> {
```

然後把「組 `idx` → `saveIndex` → `setMeta` → `refreshSuggestedPrompts`」整段（自 `const idx: KnowledgeIndexFile = existing` 起至函式結尾）替換為：

```ts
  // 點狀附加：只寫本檔的 chunks，不重寫整份索引（見 knowledge.index.repo 的 appendChunks 註解）
  await appendChunks(tenantId, fileChunks, {
    model,
    source: existing?.source ?? `file://${name}`,
  });

  // meta 的計數與推薦問句素材需要「整份索引」的視角。這裡用 existing 快照加上本次新增
  // 就地算出，而不是回讀（db 後端回讀整份索引是 9MB 級的操作，而計數僅供顯示）。
  // 併發匯入時計數可能短暫偏低，下一次任何索引異動即自我修正。
  const allChunks = [...(existing?.chunks ?? []), ...fileChunks];
  const generatedAt = new Date().toISOString();

  const fileMeta: KnowledgeFileMeta = {
    fileId,
    name,
    chunks: fileChunks.length,
    ingestedAt: generatedAt,
    format: parsed.format,
    fidelity: parsed.fidelity,
  };
  const meta = knowledgeStore.getMeta(tenantId);
  knowledgeStore.setMeta(tenantId, {
    ...meta,
    status: 'ready',
    chunkCount: allChunks.length,
    generatedAt,
    model,
    files: [...(meta.files ?? []), fileMeta],
    chunkCountBySource: countBySource(allChunks),
  });

  if (!opts?.deferSuggestions) {
    void refreshSuggestedPrompts(tenantId, {
      generatedAt,
      model,
      source: existing?.source ?? `file://${name}`,
      chunks: allChunks,
    }).catch(() => {});
  }
  return fileMeta;
}
```

- [ ] **Step 5: 改寫 removeFile 的刪除段**

把 `removeFile` 整支替換為：

```ts
/** 刪除已上傳檔案：索引剔除該 fileId 的 chunks + meta 移除；查無回 false。 */
export async function removeFile(tenantId: string, fileId: string): Promise<boolean> {
  const meta = knowledgeStore.getMeta(tenantId);
  if (!meta.files?.some((f) => f.fileId === fileId)) return false;

  // 先讀一份快照供計數與推薦問句素材使用；實際刪除走點狀 SQL，不把整份索引寫回去
  const existing = await loadIndex(tenantId);
  await removeFileChunks(tenantId, fileId);

  const files = meta.files.filter((f) => f.fileId !== fileId);
  if (existing) {
    const chunks = existing.chunks.filter((c) => c.fileId !== fileId);
    knowledgeStore.setMeta(tenantId, {
      ...meta,
      chunkCount: chunks.length,
      files,
      chunkCountBySource: countBySource(chunks),
    });
    void refreshSuggestedPrompts(tenantId, { ...existing, chunks }).catch(() => {});
  } else {
    knowledgeStore.setMeta(tenantId, { ...meta, files });
  }
  return true;
}
```

- [ ] **Step 6: 清掉不再使用的 import**

確認 `KnowledgeIndexFile` 型別是否仍被本檔使用（`carryOverFileChunks` 的簽章可能仍需要）。若 `saveIndex` 已無任何引用，確保它不在 import 清單中。執行：

```bash
cd server && npm run lint
```

Expected: 無 `no-unused-vars` 錯誤

- [ ] **Step 7: 執行測試確認通過**

```bash
cd server && npx jest tests/knowledge-file.test.ts tests/knowledge-file-admin.test.ts tests/knowledge-index-repo.test.ts
```

Expected: 全數 PASS

- [ ] **Step 8: 全套測試 + 型別檢查**

```bash
cd server && npm test && npm run typecheck
```

Expected: 全數 PASS

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/knowledge/knowledge-file.service.ts server/tests/knowledge-file.test.ts
git commit -m "feat(knowledge): 檔案 ingest 改用點狀寫入，並支援 deferSuggestions"
```

---

## Task 3: BatchSource 介面與本機資料夾實作

**Files:**
- Create: `server/src/modules/knowledge/batch-source.ts`
- Test: `server/tests/batch-source.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_EXTENSIONS`（`./doc-parse` 既有 export）
- Produces:
  ```ts
  export interface PendingItem {
    tenantId: string;
    name: string;
    ref: string;
    size: number;
    mtimeMs: number | null;
  }
  export type SettleOutcome = 'done' | 'failed';
  export interface BatchSource {
    list(): Promise<PendingItem[]>;
    read(item: PendingItem): Promise<Buffer>;
    settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void>;
  }
  export const DONE_DIR = '_done';
  export const FAILED_DIR = '_failed';
  export class LocalFolderSource implements BatchSource {
    constructor(root: string);
  }
  ```

- [ ] **Step 1: 寫失敗的測試**

建立 `server/tests/batch-source.test.ts`：

```ts
/** 本機資料夾來源：子資料夾名=tenantId，過濾保留目錄與不支援副檔名，settle 搬檔。 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFolderSource, type PendingItem } from '@/modules/knowledge/batch-source';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'batch-source-'));
});

function write(rel: string, content = '內容'): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function byName(items: PendingItem[]): string[] {
  return items.map((i) => `${i.tenantId}/${i.name}`).sort();
}

describe('LocalFolderSource.list', () => {
  it('子資料夾名成為 tenantId，收支援的副檔名', async () => {
    write('default/規章.txt');
    write('default/手冊.docx');
    write('acme/辦法.pdf');

    const items = await new LocalFolderSource(root).list();
    expect(byName(items)).toEqual(['acme/辦法.pdf', 'default/手冊.docx', 'default/規章.txt']);
  });

  it('忽略 _done / _failed / 點開頭 / 不支援副檔名', async () => {
    write('default/規章.txt');
    write('default/_done/舊檔.txt');
    write('default/_failed/壞檔.txt');
    write('default/.DS_Store');
    write('default/圖片.png');
    write('_done/不該被當成租戶.txt');
    write('.hidden/也不該.txt');

    const items = await new LocalFolderSource(root).list();
    expect(byName(items)).toEqual(['default/規章.txt']);
  });

  it('不遞迴進租戶資料夾底下的子目錄', async () => {
    write('default/規章.txt');
    write('default/子目錄/深層.txt');

    const items = await new LocalFolderSource(root).list();
    expect(byName(items)).toEqual(['default/規章.txt']);
  });

  it('回報 size 與 mtimeMs', async () => {
    write('default/規章.txt', '一二三');
    const [item] = await new LocalFolderSource(root).list();
    expect(item.size).toBeGreaterThan(0);
    expect(typeof item.mtimeMs).toBe('number');
  });

  it('root 不存在時回空陣列而非拋錯', async () => {
    const items = await new LocalFolderSource(join(root, '不存在')).list();
    expect(items).toEqual([]);
  });
});

describe('LocalFolderSource.read / settle', () => {
  it('read 讀回檔案內容', async () => {
    write('default/規章.txt', '特休規定');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();
    await expect(source.read(item)).resolves.toEqual(Buffer.from('特休規定', 'utf8'));
  });

  it('settle done 把檔案搬進 _done，原位置消失', async () => {
    write('default/規章.txt');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'done');

    expect(existsSync(item.ref)).toBe(false);
    expect(existsSync(join(root, 'default/_done/規章.txt'))).toBe(true);
  });

  it('settle failed 搬進 _failed 並寫 .error.txt', async () => {
    write('default/壞檔.txt');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'failed', '無可抽取文字（可能為掃描檔或空檔）');

    expect(existsSync(item.ref)).toBe(false);
    expect(existsSync(join(root, 'default/_failed/壞檔.txt'))).toBe(true);
    expect(readFileSync(join(root, 'default/_failed/壞檔.txt.error.txt'), 'utf8')).toContain('掃描檔');
  });

  it('settle 目標已有同名檔時直接覆蓋', async () => {
    write('default/_done/規章.txt', '舊的');
    write('default/規章.txt', '新的');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'done');

    expect(readFileSync(join(root, 'default/_done/規章.txt'), 'utf8')).toBe('新的');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd server && npx jest tests/batch-source.test.ts
```

Expected: FAIL — 找不到模組 `@/modules/knowledge/batch-source`

- [ ] **Step 3: 實作**

建立 `server/src/modules/knowledge/batch-source.ts`：

```ts
/**
 * 批次匯入的來源抽象。
 *
 * 管線（folder-ingest.service）只依賴 list / read / settle 三個方法，不知道背後是本機
 * 資料夾、網路磁碟機還是物件儲存。上線形態確定後新增實作即可，管線與測試不需改寫。
 *
 * 穩定性判定（檔案有沒有寫完）刻意**不放這裡**：那需要跨輪次的狀態，屬於執行者的職責，
 * 放進來會讓每個 source 實作都得自己重做一次。見 folder-ingest.service 的 selectStable。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { SUPPORTED_EXTENSIONS } from './doc-parse';

/** 一個待處理的匯入項目 */
export interface PendingItem {
  /** 歸屬租戶（本機來源＝子資料夾名） */
  tenantId: string;
  /** 送進 ingestFile 的檔名，會顯示在知識庫檔案清單 */
  name: string;
  /** 來源內部識別（本機來源＝絕對路徑） */
  ref: string;
  size: number;
  /** 穩定性判定用；來源無此概念時為 null（視為永遠穩定） */
  mtimeMs: number | null;
}

export type SettleOutcome = 'done' | 'failed';

export interface BatchSource {
  /** 列出所有待處理項目；已過濾副檔名與保留目錄，不做穩定性判定 */
  list(): Promise<PendingItem[]>;
  read(item: PendingItem): Promise<Buffer>;
  /** 標記完成；failed 時 reason 會落地成 <name>.error.txt */
  settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void>;
}

/** 消化成功的歸檔目錄名 */
export const DONE_DIR = '_done';
/** 永久性失敗的歸檔目錄名 */
export const FAILED_DIR = '_failed';

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

/** `_` 開頭為保留目錄、`.` 開頭為系統或同步中繼檔，兩者都不是租戶也不是待處理檔 */
function isReserved(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.');
}

/** 本機（或已掛載的網路）資料夾來源：<root>/<tenantId>/<檔案> */
export class LocalFolderSource implements BatchSource {
  constructor(private readonly root: string) {}

  async list(): Promise<PendingItem[]> {
    const tenantDirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const items: PendingItem[] = [];

    for (const dir of tenantDirs) {
      if (!dir.isDirectory() || isReserved(dir.name)) continue;
      const tenantPath = join(this.root, dir.name);
      const entries = await readdir(tenantPath, { withFileTypes: true }).catch(() => []);

      for (const entry of entries) {
        // 不遞迴：租戶資料夾底下的子目錄一律略過（_done/_failed 也在此被擋掉）
        if (!entry.isFile() || isReserved(entry.name)) continue;
        if (!SUPPORTED.has(extname(entry.name).toLowerCase())) continue;

        const ref = join(tenantPath, entry.name);
        const st = await stat(ref).catch(() => null);
        if (!st) continue; // 掃描期間被刪掉／搬走，下一輪自然不會再出現
        items.push({ tenantId: dir.name, name: entry.name, ref, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return items;
  }

  async read(item: PendingItem): Promise<Buffer> {
    return readFile(item.ref);
  }

  async settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void> {
    const destDir = join(this.root, item.tenantId, outcome === 'done' ? DONE_DIR : FAILED_DIR);
    await mkdir(destDir, { recursive: true });
    // rename 在 POSIX 為原子操作且會覆蓋同名目標——重丟改版檔時直接取代舊的歸檔
    await rename(item.ref, join(destDir, item.name));
    if (outcome === 'failed' && reason) {
      await writeFile(join(destDir, `${item.name}.error.txt`), reason, 'utf8');
    }
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
cd server && npx jest tests/batch-source.test.ts
```

Expected: PASS（10 個測試全過）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/batch-source.ts server/tests/batch-source.test.ts
git commit -m "feat(knowledge): 新增批次匯入的來源抽象與本機資料夾實作"
```

---

## Task 4: 穩定性判定與錯誤分類（純函式）

**Files:**
- Create: `server/src/modules/knowledge/folder-ingest.service.ts`
- Test: `server/tests/folder-ingest.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `PendingItem`；既有 `AppError`
- Produces:
  ```ts
  export interface SeenEntry { size: number; mtimeMs: number | null }
  export function selectStable(
    items: PendingItem[],
    seen: Map<string, SeenEntry>,
  ): { stable: PendingItem[]; next: Map<string, SeenEntry> };
  export function isPermanentFailure(err: unknown): boolean;
  export function describeError(err: unknown): string;
  ```

- [ ] **Step 1: 寫失敗的測試**

建立 `server/tests/folder-ingest.test.ts`：

```ts
/** 批次匯入執行器：穩定性判定、錯誤分類、單輪執行流程。 */
import {
  describeError,
  isPermanentFailure,
  selectStable,
  type SeenEntry,
} from '@/modules/knowledge/folder-ingest.service';
import type { PendingItem } from '@/modules/knowledge/batch-source';
import { AppError } from '@/utils/app-error';

function item(name: string, size: number, mtimeMs: number | null = 1000): PendingItem {
  return { tenantId: 'default', name, ref: `/tmp/default/${name}`, size, mtimeMs };
}

describe('selectStable', () => {
  it('第一次見到的檔案不處理，但記進 next', () => {
    const { stable, next } = selectStable([item('a.txt', 100)], new Map());
    expect(stable).toEqual([]);
    expect(next.get('/tmp/default/a.txt')).toEqual({ size: 100, mtimeMs: 1000 });
  });

  it('size 與 mtime 連續兩輪相同才視為寫完', () => {
    const first = selectStable([item('a.txt', 100)], new Map());
    const second = selectStable([item('a.txt', 100)], first.next);
    expect(second.stable.map((i) => i.name)).toEqual(['a.txt']);
  });

  it('兩輪之間檔案還在變大 → 持續不處理', () => {
    const first = selectStable([item('a.txt', 100)], new Map());
    const second = selectStable([item('a.txt', 250)], first.next);
    expect(second.stable).toEqual([]);

    const third = selectStable([item('a.txt', 400)], second.next);
    expect(third.stable).toEqual([]);
  });

  it('size 相同但 mtime 變了 → 不處理（內容可能被覆寫）', () => {
    const first = selectStable([item('a.txt', 100, 1000)], new Map());
    const second = selectStable([item('a.txt', 100, 2000)], first.next);
    expect(second.stable).toEqual([]);
  });

  it('mtimeMs 為 null 的來源視為永遠穩定，第一輪就處理', () => {
    const { stable } = selectStable([item('a.txt', 100, null)], new Map());
    expect(stable.map((i) => i.name)).toEqual(['a.txt']);
  });

  it('next 不保留已消失的檔案，避免 Map 無限成長', () => {
    const seen = new Map<string, SeenEntry>([['/tmp/default/舊檔.txt', { size: 1, mtimeMs: 1 }]]);
    const { next } = selectStable([item('a.txt', 100)], seen);
    expect(next.has('/tmp/default/舊檔.txt')).toBe(false);
  });
});

describe('isPermanentFailure', () => {
  it('4xx AppError 視為永久性（重試不會有不同結果）', () => {
    expect(isPermanentFailure(AppError.unprocessable('無可抽取文字'))).toBe(true);
    expect(isPermanentFailure(AppError.badRequest('不支援的副檔名'))).toBe(true);
  });

  it('429 視為暫時性（rate limit 等一下就好）', () => {
    expect(isPermanentFailure(AppError.tooManyRequests())).toBe(false);
  });

  it('5xx AppError 與一般例外視為暫時性', () => {
    expect(isPermanentFailure(AppError.internal())).toBe(false);
    expect(isPermanentFailure(new Error('socket hang up'))).toBe(false);
  });
});

describe('describeError', () => {
  it('AppError 取其 message', () => {
    expect(describeError(AppError.unprocessable('無可抽取文字'))).toContain('無可抽取文字');
  });

  it('非 Error 值也能轉成字串而不拋錯', () => {
    expect(typeof describeError('壞掉了')).toBe('string');
    expect(typeof describeError(undefined)).toBe('string');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd server && npx jest tests/folder-ingest.test.ts
```

Expected: FAIL — 找不到模組 `@/modules/knowledge/folder-ingest.service`

- [ ] **Step 3: 實作純函式**

建立 `server/src/modules/knowledge/folder-ingest.service.ts`：

```ts
/**
 * 資料夾批次匯入的執行器。
 *
 * 與 admin 單檔上傳共用同一條 ingestFile 管線——本檔不含任何解析、切塊或 embedding 邏輯，
 * 只負責「挑出該處理哪些檔、依序餵進去、把結果歸檔」。
 */
import { AppError } from '@/utils/app-error';
import type { PendingItem } from './batch-source';

/** 上一輪看到的檔案指紋，用來判斷檔案是否已經寫完 */
export interface SeenEntry {
  size: number;
  mtimeMs: number | null;
}

/**
 * 穩定性判定：只有 (size, mtime) 連續兩輪完全相同的檔案才算「寫完」。
 *
 * 沒有這道閘，rsync/scp 傳到一半、SMB 複製大檔、瀏覽器拖放大 PDF 都會被讀成截斷的內容，
 * 而截斷的 PDF 往往還能解析出前幾頁——那會安靜地把半份文件灌進知識庫，比直接失敗更糟。
 *
 * 回傳的 next 只包含本輪仍存在的檔案，讓已消化或被移走的項目自然淘汰（Map 不會無限成長）。
 */
export function selectStable(
  items: PendingItem[],
  seen: Map<string, SeenEntry>,
): { stable: PendingItem[]; next: Map<string, SeenEntry> } {
  const next = new Map<string, SeenEntry>();
  const stable: PendingItem[] = [];

  for (const it of items) {
    const entry: SeenEntry = { size: it.size, mtimeMs: it.mtimeMs };
    next.set(it.ref, entry);

    // 來源沒有 mtime 概念（例如未來的物件儲存）：無從判定，視為永遠穩定
    if (it.mtimeMs === null) {
      stable.push(it);
      continue;
    }
    const prev = seen.get(it.ref);
    if (prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs) stable.push(it);
  }
  return { stable, next };
}

/**
 * 錯誤分類：永久性失敗才歸檔到 _failed，暫時性失敗留在原地下輪重試。
 *
 * 判定保守方向刻意偏向「暫時性」——把暫時性誤判為永久性會讓檔案被歸檔而不再重試
 * （形同丟掉），反之只是多試幾輪。故僅 4xx（且非 429）視為永久性。
 */
export function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.statusCode === 429) return false; // rate limit：等一下就好
  return err.statusCode >= 400 && err.statusCode < 500;
}

/** 把任意拋出物轉成可寫進 .error.txt 的字串 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
cd server && npx jest tests/folder-ingest.test.ts
```

Expected: PASS（11 個測試全過）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/folder-ingest.service.ts server/tests/folder-ingest.test.ts
git commit -m "feat(knowledge): 批次匯入的穩定性判定與錯誤分類"
```

---

## Task 5: 單輪執行器

**Files:**
- Modify: `server/src/modules/knowledge/folder-ingest.service.ts`
- Test: `server/tests/folder-ingest.test.ts`（Task 4 建立，補測試）

**Interfaces:**
- Consumes: Task 3 的 `BatchSource` / `PendingItem`；Task 4 的 `selectStable` / `isPermanentFailure` / `describeError`；Task 2 的 `ingestFile(tenantId, name, buf, opts)`；既有 `removeFile` / `loadIndex` / `knowledgeStore` / `refreshSuggestedPrompts`
- Produces:
  ```ts
  export interface RoundOptions {
    dryRun?: boolean;
    maxBytes: number;
    tenantFilter?: string;
    /** 暫時性失敗的重試間隔（毫秒）；測試傳 0 以免拖慢 */
    retryDelayMs?: number;
  }
  export interface RoundResult {
    done: number; failed: number; retry: number; skipped: number;
    tenants: string[];
  }
  export interface WatchState { seen: Map<string, SeenEntry> }
  export function createWatchState(): WatchState;
  export async function runFolderIngestRound(
    source: BatchSource,
    state: WatchState,
    opts: RoundOptions,
  ): Promise<RoundResult>;
  ```

- [ ] **Step 1: 寫失敗的測試**

在 `server/tests/folder-ingest.test.ts` **頂部**（所有 import 之前）加入 mock，並在檔案末尾追加 describe 區塊。

檔案頂部加入：

```ts
const mockIngestFile = jest.fn();
const mockRemoveFile = jest.fn();
jest.mock('@/modules/knowledge/knowledge-file.service', () => ({
  __esModule: true,
  ingestFile: (...args: unknown[]) => mockIngestFile(...args),
  removeFile: (...args: unknown[]) => mockRemoveFile(...args),
}));
const mockRefreshSuggestions = jest.fn();
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: (...args: unknown[]) => mockRefreshSuggestions(...args),
}));
const mockLoadIndex = jest.fn();
jest.mock('@/modules/knowledge/knowledge.index.repo', () => ({
  __esModule: true,
  loadIndex: (...args: unknown[]) => mockLoadIndex(...args),
}));
const mockGetMeta = jest.fn();
jest.mock('@/modules/knowledge/knowledge.store', () => ({
  __esModule: true,
  knowledgeStore: { getMeta: (...args: unknown[]) => mockGetMeta(...args) },
}));
```

檔案末尾追加：

```ts
import {
  createWatchState,
  runFolderIngestRound,
  type RoundOptions,
} from '@/modules/knowledge/folder-ingest.service';
import type { BatchSource, PendingItem, SettleOutcome } from '@/modules/knowledge/batch-source';

/** 可程式化的假來源：list 回預設清單，settle 記錄呼叫 */
class FakeSource implements BatchSource {
  settled: { name: string; outcome: SettleOutcome; reason?: string }[] = [];
  constructor(private items: PendingItem[]) {}
  async list(): Promise<PendingItem[]> {
    return this.items;
  }
  async read(): Promise<Buffer> {
    return Buffer.from('內容');
  }
  async settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void> {
    this.settled.push({ name: item.name, outcome, reason });
    this.items = this.items.filter((i) => i.ref !== item.ref);
  }
}

const OPTS: RoundOptions = { maxBytes: 50 * 1024 * 1024, retryDelayMs: 0 };

/** 跑兩輪：第一輪讓穩定性判定記錄指紋，第二輪才真的處理 */
async function runTwice(source: BatchSource, opts: RoundOptions = OPTS) {
  const state = createWatchState();
  await runFolderIngestRound(source, state, opts);
  return runFolderIngestRound(source, state, opts);
}

beforeEach(() => {
  mockIngestFile.mockReset().mockResolvedValue({ fileId: 'f1', name: 'x', chunks: 3 });
  mockRemoveFile.mockReset().mockResolvedValue(true);
  mockRefreshSuggestions.mockReset().mockResolvedValue(undefined);
  mockLoadIndex.mockReset().mockResolvedValue({ generatedAt: '', model: 'm', source: 's', chunks: [] });
  mockGetMeta.mockReset().mockReturnValue({ files: [] });
});

describe('runFolderIngestRound', () => {
  it('穩定後逐檔呼叫 ingestFile，並一律帶 deferSuggestions', async () => {
    const source = new FakeSource([item('規章.txt', 100), item('手冊.txt', 200)]);
    const result = await runTwice(source);

    expect(result.done).toBe(2);
    expect(mockIngestFile).toHaveBeenCalledTimes(2);
    for (const call of mockIngestFile.mock.calls) {
      expect(call[3]).toEqual({ deferSuggestions: true });
    }
  });

  it('成功的檔案 settle done', async () => {
    const source = new FakeSource([item('規章.txt', 100)]);
    await runTwice(source);
    expect(source.settled).toEqual([{ name: '規章.txt', outcome: 'done', reason: undefined }]);
  });

  it('永久性失敗 settle failed 並帶原因', async () => {
    mockIngestFile.mockRejectedValue(AppError.unprocessable('無可抽取文字'));
    const source = new FakeSource([item('壞檔.txt', 100)]);
    const result = await runTwice(source);

    expect(result.failed).toBe(1);
    expect(source.settled[0].outcome).toBe('failed');
    expect(source.settled[0].reason).toContain('無可抽取文字');
  });

  it('暫時性失敗不搬檔，重試一次後計入 retry', async () => {
    mockIngestFile.mockRejectedValue(new Error('socket hang up'));
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.retry).toBe(1);
    expect(source.settled).toEqual([]);
    expect(mockIngestFile).toHaveBeenCalledTimes(2); // 首次 + 重試一次
  });

  it('暫時性失敗的重試成功時計入 done', async () => {
    mockIngestFile
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ fileId: 'f1', name: 'x', chunks: 3 });
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.done).toBe(1);
    expect(source.settled[0].outcome).toBe('done');
  });

  it('超過 maxBytes 判永久性失敗，不呼叫 ingestFile', async () => {
    const source = new FakeSource([item('巨檔.txt', 999)]);
    const result = await runTwice(source, { ...OPTS, maxBytes: 500 });

    expect(result.failed).toBe(1);
    expect(mockIngestFile).not.toHaveBeenCalled();
    expect(source.settled[0].reason).toContain('上限');
  });

  it('meta 已有同名檔時先 removeFile 再 ingestFile', async () => {
    mockGetMeta.mockReturnValue({ files: [{ fileId: 'old-1', name: '規章.txt' }] });
    const source = new FakeSource([item('規章.txt', 100)]);
    await runTwice(source);

    expect(mockRemoveFile).toHaveBeenCalledWith('default', 'old-1');
    expect(mockRemoveFile.mock.invocationCallOrder[0]).toBeLessThan(
      mockIngestFile.mock.invocationCallOrder[0],
    );
  });

  it('整輪結束後每個有處理過的租戶各觸發一次推薦問句重生', async () => {
    const source = new FakeSource([item('規章.txt', 100), item('手冊.txt', 200)]);
    await runTwice(source);
    expect(mockRefreshSuggestions).toHaveBeenCalledTimes(1);
  });

  it('本輪未處理任何檔案時不觸發推薦問句重生', async () => {
    const source = new FakeSource([item('規章.txt', 100)]);
    const state = createWatchState();
    await runFolderIngestRound(source, state, OPTS); // 只跑第一輪：尚未穩定
    expect(mockRefreshSuggestions).not.toHaveBeenCalled();
  });

  it('dryRun 不呼叫 ingestFile 也不搬檔', async () => {
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source, { ...OPTS, dryRun: true });

    expect(mockIngestFile).not.toHaveBeenCalled();
    expect(source.settled).toEqual([]);
    expect(result.done).toBe(0);
  });

  it('tenantFilter 只處理指定租戶', async () => {
    const other: PendingItem = {
      tenantId: 'acme',
      name: '辦法.txt',
      ref: '/tmp/acme/辦法.txt',
      size: 100,
      mtimeMs: 1000,
    };
    const source = new FakeSource([item('規章.txt', 100), other]);
    const result = await runTwice(source, { ...OPTS, tenantFilter: 'acme' });

    expect(result.done).toBe(1);
    expect(mockIngestFile).toHaveBeenCalledWith('acme', '辦法.txt', expect.any(Buffer), {
      deferSuggestions: true,
    });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd server && npx jest tests/folder-ingest.test.ts -t "runFolderIngestRound"
```

Expected: FAIL — `createWatchState is not a function`

- [ ] **Step 3: 實作執行器**

在 `folder-ingest.service.ts` 的 import 區塊補上：

```ts
import { logger } from '@/lib/logger';
import type { BatchSource, PendingItem } from './batch-source';
import { ingestFile, removeFile } from './knowledge-file.service';
import { loadIndex } from './knowledge.index.repo';
import { knowledgeStore } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';
```

並在檔案末尾加入：

```ts
export interface RoundOptions {
  /** 只列出將處理什麼，不呼叫任何付費 API、不搬檔 */
  dryRun?: boolean;
  /** 單檔大小上限（位元組）；超過判永久性失敗 */
  maxBytes: number;
  /** 只處理此租戶 */
  tenantFilter?: string;
  /** 暫時性失敗的重試間隔（毫秒），預設 5000；測試傳 0 */
  retryDelayMs?: number;
}

export interface RoundResult {
  done: number;
  failed: number;
  /** 暫時性失敗、留在原地待下輪重試 */
  retry: number;
  /** 尚未穩定（可能還在寫入）而本輪略過 */
  skipped: number;
  /** 本輪實際有成功匯入檔案的租戶 */
  tenants: string[];
}

/** 跨輪次保留的狀態；由 CLI 持有，每輪傳入 */
export interface WatchState {
  seen: Map<string, SeenEntry>;
}

export function createWatchState(): WatchState {
  return { seen: new Map() };
}

const DEFAULT_RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同名檔視為更新：先移除既有的同名檔，否則索引會留下兩份 chunks */
async function replaceSameName(tenantId: string, name: string): Promise<void> {
  const existing = knowledgeStore.getMeta(tenantId).files?.find((f) => f.name === name);
  if (existing) await removeFile(tenantId, existing.fileId);
}

/**
 * 執行一輪：掃描 → 穩定性判定 → 依租戶分組後**嚴格序列**逐檔匯入 → 歸檔。
 *
 * 序列而非平行：瓶頸在 embedding API（embedInBatches 內部已分批），而平行匯入只會
 * 讓錯誤處理與進度回報變複雜，換不到吞吐量。
 */
export async function runFolderIngestRound(
  source: BatchSource,
  state: WatchState,
  opts: RoundOptions,
): Promise<RoundResult> {
  const all = await source.list();
  const scoped = opts.tenantFilter ? all.filter((i) => i.tenantId === opts.tenantFilter) : all;

  const { stable, next } = selectStable(scoped, state.seen);
  state.seen = next;

  const result: RoundResult = {
    done: 0,
    failed: 0,
    retry: 0,
    skipped: scoped.length - stable.length,
    tenants: [],
  };
  if (stable.length === 0) return result;

  if (opts.dryRun) {
    for (const it of stable) {
      logger.info({ tenantId: it.tenantId, name: it.name, size: it.size }, '[dry-run] 將匯入');
    }
    return result;
  }

  const touched = new Set<string>();
  for (const it of stable) {
    const outcome = await ingestOne(source, it, opts);
    if (outcome === 'done') {
      result.done += 1;
      touched.add(it.tenantId);
    } else if (outcome === 'failed') {
      result.failed += 1;
    } else {
      result.retry += 1;
    }
  }

  // 推薦問句每租戶只重生一次：逐檔觸發會讓 N-1 次呼叫因世代防護而白花
  for (const tenantId of touched) {
    const idx = await loadIndex(tenantId);
    if (idx) await refreshSuggestedPrompts(tenantId, idx).catch(() => {});
  }
  result.tenants = [...touched];
  return result;
}

/** 單檔處理；回傳本檔的結局。永久性失敗歸檔，暫時性失敗留在原地 */
async function ingestOne(
  source: BatchSource,
  item: PendingItem,
  opts: RoundOptions,
): Promise<'done' | 'failed' | 'retry'> {
  if (item.size > opts.maxBytes) {
    const reason = `檔案 ${(item.size / 1024 / 1024).toFixed(1)}MB 超過上限 ${(opts.maxBytes / 1024 / 1024).toFixed(0)}MB`;
    await source.settle(item, 'failed', reason);
    logger.warn({ name: item.name }, reason);
    return 'failed';
  }

  const attempt = async (): Promise<void> => {
    const buf = await source.read(item);
    await replaceSameName(item.tenantId, item.name);
    // deferSuggestions：推薦問句留到整輪結束統一重生
    const meta = await ingestFile(item.tenantId, item.name, buf, { deferSuggestions: true });
    logger.info({ tenantId: item.tenantId, name: item.name, chunks: meta.chunks }, '匯入完成');
  };

  try {
    await attempt();
    await source.settle(item, 'done');
    return 'done';
  } catch (err) {
    if (isPermanentFailure(err)) {
      const reason = describeError(err);
      await source.settle(item, 'failed', reason);
      logger.warn({ tenantId: item.tenantId, name: item.name, reason }, '匯入失敗（永久性）');
      return 'failed';
    }
    // 暫時性：重試一次；仍失敗就留在原地，下一輪再來
    await sleep(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    try {
      await attempt();
      await source.settle(item, 'done');
      return 'done';
    } catch (retryErr) {
      logger.warn(
        { tenantId: item.tenantId, name: item.name, err: retryErr },
        '匯入失敗（暫時性），保留原檔待下輪重試',
      );
      return 'retry';
    }
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
cd server && npx jest tests/folder-ingest.test.ts
```

Expected: PASS（Task 4 的 11 則 + 本任務的 11 則）

- [ ] **Step 5: 全套測試 + 型別檢查**

```bash
cd server && npm test && npm run typecheck && npm run lint
```

Expected: 全數 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/folder-ingest.service.ts server/tests/folder-ingest.test.ts
git commit -m "feat(knowledge): 批次匯入單輪執行器"
```

---

## Task 6: CLI watcher

**Files:**
- Create: `server/scripts/knowledge-watch.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: Task 3 的 `LocalFolderSource`；Task 5 的 `createWatchState` / `runFolderIngestRound`；既有 `env` / `connectDb` / `closeDb` / `knowledgeStore` / `loadIndex`

- [ ] **Step 1: 實作 CLI**

建立 `server/scripts/knowledge-watch.ts`：

```ts
/*
 * 資料夾批次匯入 watcher。
 *
 * 執行：npm run watch:knowledge -w server -- --root=<path> [--interval=30] [--once]
 *                                            [--dry-run] [--max-mb=50] [--tenant=<id>]
 *
 * 資料夾結構：<root>/<tenantId>/*.pdf|docx|...，消化成功搬 <root>/<tenantId>/_done/，
 * 永久性失敗搬 _failed/ 並附 .error.txt。
 *
 * 前提：DATA_BACKEND=db 且 DATABASE_URL 指向正式 Supabase，否則寫進本機 JSON、正式環境看不到。
 */
import { env } from '../src/config/env';
import { closeDb, connectDb } from '../src/lib/db';
import { LocalFolderSource } from '../src/modules/knowledge/batch-source';
import {
  createWatchState,
  runFolderIngestRound,
  type RoundOptions,
} from '../src/modules/knowledge/folder-ingest.service';
import { loadIndex } from '../src/modules/knowledge/knowledge.index.repo';
import { knowledgeStore } from '../src/modules/knowledge/knowledge.store';

interface Args {
  root: string;
  intervalSec: number;
  once: boolean;
  dryRun: boolean;
  maxMb: number;
  tenant?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=');
  const has = (key: string): boolean => argv.includes(`--${key}`);

  const root = get('root');
  if (!root) {
    console.error('缺少 --root=<path>');
    console.error('用法：npm run watch:knowledge -w server -- --root=<path> [--interval=30] [--once] [--dry-run] [--max-mb=50] [--tenant=<id>]');
    process.exit(1);
  }
  return {
    root,
    intervalSec: Number(get('interval') ?? 30),
    once: has('once'),
    dryRun: has('dry-run'),
    maxMb: Number(get('max-mb') ?? 50),
    tenant: get('tenant'),
  };
}

/**
 * 開跑前把「會寫到哪、用哪個模型」攤開來講。
 *
 * 全新租戶的第一次匯入會定型該租戶的 embedding 模型（之後改設定也不會影響既有索引），
 * 所以要特別標示——這是唯一一個事後只能清空重建的決定。
 */
async function printPreflight(tenantIds: string[]): Promise<void> {
  console.log(`DATA_BACKEND=${env.DATA_BACKEND}`);
  if (env.DATA_BACKEND !== 'db') {
    console.warn('⚠️  非 db 模式：索引會寫進本機 server/data/*.json，正式環境看不到。');
  }
  console.warn('⚠️  全站重爬期間請勿執行批次匯入——重爬是整份取代，會抹掉期間新增的檔案 chunks。');

  for (const tenantId of tenantIds) {
    const idx = await loadIndex(tenantId);
    if (idx) {
      console.log(`  ${tenantId}：沿用既有索引，模型 ${idx.model}`);
    } else {
      const model = knowledgeStore.getSource(tenantId).embeddingModel;
      console.log(`  ${tenantId}：★ 將建立新索引，模型 ${model}（一經建立即定型）`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (env.DATA_BACKEND === 'db') await connectDb();

  const source = new LocalFolderSource(args.root);
  const state = createWatchState();
  const opts: RoundOptions = {
    dryRun: args.dryRun,
    maxBytes: args.maxMb * 1024 * 1024,
    tenantFilter: args.tenant,
  };

  console.log(`監控 ${args.root}（間隔 ${args.intervalSec}s${args.once ? '，單輪' : ''}${args.dryRun ? '，dry-run' : ''}）`);
  const initial = await source.list();
  await printPreflight([...new Set(initial.map((i) => i.tenantId))]);

  // 完成當前檔案後才退出：中途硬殺可能留下「chunks 已寫入但檔案未歸檔」的狀態，
  // 下一輪會重跑該檔（同名檔會先 removeFile，故不會重複），但仍以乾淨收尾為佳。
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) {
        console.log('\n強制退出。');
        process.exit(130);
      }
      stopping = true;
      console.log('\n收到中斷訊號，完成當前輪次後退出（再按一次強制退出）…');
    });
  }

  do {
    const pending = await source.list();
    if (pending.length > 0) {
      const totalMb = pending.reduce((sum, i) => sum + i.size, 0) / 1024 / 1024;
      console.log(`待處理 ${pending.length} 個檔 / 共 ${totalMb.toFixed(1)}MB`);
    }

    const result = await runFolderIngestRound(source, state, opts);
    if (result.done || result.failed || result.retry) {
      console.log(
        `本輪：done ${result.done} / failed ${result.failed} / retry ${result.retry} / skipped ${result.skipped}`,
      );
    }
    if (args.once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, args.intervalSec * 1000));
  } while (!stopping);

  await closeDb();
  console.log('結束。');
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 2: 加 npm script**

在 `server/package.json` 的 `scripts` 中，`"ingest:knowledge"` 之後加入一行：

```json
    "watch:knowledge": "tsx scripts/knowledge-watch.ts",
```

- [ ] **Step 3: 驗證參數缺漏時的行為**

```bash
cd server && npx tsx scripts/knowledge-watch.ts
```

Expected: 印出「缺少 --root=<path>」與用法，exit code 1

- [ ] **Step 4: 以 dry-run 實際驗證掃描**

```bash
cd server
mkdir -p /tmp/kw-test/default/_done
printf '公司特休規定說明，依年資計算。' > /tmp/kw-test/default/規章.txt
printf 'x' > /tmp/kw-test/default/圖片.png
npx tsx scripts/knowledge-watch.ts --root=/tmp/kw-test --once --dry-run
```

Expected: 列出 `default` 租戶與其模型、`[dry-run] 將匯入` 不含 `圖片.png`；不呼叫任何 API。
（`--once` 在單次呼叫內自足完成兩輪——掃描 → 等待 `--interval` 秒 → 再掃描，只在第二輪
處理——故單次執行即可看到結果，不需要重跑指令；預設 `--interval=30` 會使這步等約 30 秒，
嫌久可加 `--interval=5`。）

- [ ] **Step 5: 型別檢查與 lint**

```bash
cd server && npm run typecheck && npm run lint
```

Expected: 全數 PASS

- [ ] **Step 6: 清理測試資料夾**

```bash
rm -rf /tmp/kw-test
```

- [ ] **Step 7: Commit**

```bash
git add server/scripts/knowledge-watch.ts server/package.json
git commit -m "feat(knowledge): 新增資料夾批次匯入 watcher CLI"
```

---

## Task 7: 文件與收尾

**Files:**
- Modify: `README.md`（或 `docs/ARCHITECTURE.md`，依既有慣例擇一）

- [ ] **Step 1: 確認既有文件慣例**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -n "ingest:knowledge\|migrate:knowledge" README.md docs/ARCHITECTURE.md DEPLOY.zeabur.md
```

依結果決定新段落要加在哪一份文件（既有 CLI 說明在哪就加在哪）。

- [ ] **Step 2: 補上操作說明**

在該文件的知識庫章節加入：

````markdown
### 資料夾批次匯入

把文件放進 `<root>/<tenantId>/`，watcher 會依序消化並歸檔到 `_done/`（失敗則到
`_failed/` 並附 `.error.txt`）。

```bash
npm run watch:knowledge -w server -- --root=/path/to/inbox
```

| 參數 | 預設 | 說明 |
|---|---|---|
| `--root` | 必填 | 監控的根目錄 |
| `--interval` | 30 | 輪詢間隔（秒） |
| `--once` | — | 單次呼叫內自足完成兩輪（掃描 → 等待 `--interval` 秒 → 再掃描，只在第二輪處理），可掛 cron；代價是單次執行至少要等一個 `--interval` |
| `--dry-run` | — | 只列出將處理什麼，不呼叫任何 API |
| `--max-mb` | 50 | 單檔大小上限 |
| `--tenant` | — | 只處理指定租戶 |

**注意事項**

- `server/.env` 需為 `DATA_BACKEND=db` 且 `DATABASE_URL` 指向正式 Supabase，
  否則索引寫進本機 JSON、正式環境看不到。
- 檔案需連續兩輪 size 與 mtime 相同才會被處理（避免讀到傳輸中的半份檔案），
  故剛丟進去的檔案最快在第二輪被消化。
- 同名檔視為更新：會先移除既有同名檔的 chunks 再重新匯入。
- **全站重爬期間請勿執行批次匯入**：重爬是整份取代，會抹掉期間新增的檔案 chunks。
````

- [ ] **Step 3: 全套驗證**

```bash
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test && npm run lint
```

Expected: 全數 PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(knowledge): 補上資料夾批次匯入的操作說明"
```

---

## Self-Review 紀錄

**Spec 覆蓋檢查：**

| Spec 章節 | 對應任務 |
|---|---|
| 資料夾約定（子資料夾=tenantId、`_done`/`_failed`） | Task 3 |
| 來源介面 `BatchSource` | Task 3 |
| 掃描與穩定性判定（不用 chokidar、mtime+size 兩輪） | Task 4 |
| 併發 §1 嚴格序列 | Task 5（`runFolderIngestRound` 的 for-await） |
| 併發 §2 append-only（`appendChunks`/`removeFileChunks`） | Task 1、Task 2 |
| 併發 §2.1 重爬提示 | Task 6（`printPreflight`）、Task 7（文件） |
| 併發 §3 `deferSuggestions` | Task 2（參數）、Task 5（整輪一次） |
| 併發 §4 同名檔視為更新 | Task 5（`replaceSameName`） |
| 與 admin 一致性（共用 `ingestFile`） | Task 2、Task 5 |
| embedding 模型不由 batch 決定 + 新索引標示 | Task 6（`printPreflight`） |
| 錯誤處理（永久 vs 暫時、retry 一次） | Task 4（分類）、Task 5（`ingestOne`） |
| CLI 介面六個參數 | Task 6 |
| 成本可見性（規模、dry-run、逐檔進度） | Task 5、Task 6 |
| 前置條件警告（DATA_BACKEND） | Task 6 |
| 測試計畫 | Task 1、3、4、5 的測試步驟 |

無未覆蓋項目。

**型別一致性檢查：** `PendingItem` / `SeenEntry` / `RoundOptions` / `RoundResult` /
`IngestFileOptions` 在定義處與各使用處名稱與欄位一致；`appendChunks(tenantId, chunks, meta)`
的三參數形式在 Task 1 定義、Task 2 使用，一致。

**已知的刻意取捨（非缺漏）：**

- 測試環境固定 `DATA_BACKEND=file`，故 Task 1 的 db 後端分支不受單元測試覆蓋。
  首次以 `db` 模式執行時，建議先用 `--dry-run` 與單一檔案小規模驗證。
- `ingestFile` 的 meta 計數改用 `existing` 快照就地計算，併發匯入時可能短暫偏低，
  下一次索引異動即自我修正（已寫入程式碼註解）。

---

## 執行順序與相依

```
Task 1（repo 點狀寫入）
   └─ Task 2（ingest 管線改用 + deferSuggestions）
         └─ Task 5（單輪執行器）
Task 3（BatchSource）──────┘
Task 4（穩定性 + 錯誤分類）┘
                             └─ Task 6（CLI）
                                   └─ Task 7（文件）
```

Task 1 → 2 必須依序；Task 3 與 Task 4 可與 1、2 並行；Task 5 需要 2、3、4 皆完成。
