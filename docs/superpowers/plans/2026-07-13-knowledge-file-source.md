# 知識庫檔案來源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 知識庫新增「檔案」來源：admin 上傳 txt/md/PDF/Word → 解析 → 沿用切塊/embedding → 附加進租戶索引（chunk 標 `fileId`）；與網站來源並存（重爬保留檔案 chunks）、可個別刪除。設計見 [spec](../specs/2026-07-13-knowledge-file-source-design.md)。

**Architecture:** ①後端 `knowledge-file.service`（parse/ingestFile/removeFile + 網站重爬 carry-over）②admin API（multipart 上傳 + 刪除 + GET 含 files）③KnowledgeTab「檔案來源」區塊。既有件：`chunkText`/`squash`（ingest.service）、`getEmbeddingProvider`、`indexPathFor`、`invalidateIndexCache`（retriever.staticIndex）、`knowledgeStore.getMeta/setMeta`、upload middleware 模式（multer memoryStorage）。

## Global Constraints

- 語言：繁體中文註解/訊息/UI。
- 新依賴：`pdf-parse`、`mammoth`（server dependencies；型別缺就補 `@types/pdf-parse` devDep）。
- 格式白名單：`.txt`/`.md`/`.pdf`/`.docx`（副檔名判斷；其他回 400）。單檔上限 10MB。
- 解析出的文字 `squash` 後 < 20 字 → 422「無可抽取文字（可能為掃描檔或空檔）」；**解析成功前不得動索引/meta**（無半套狀態）。
- 模型一致性：附加時 embedding 模型取**現有索引的 `model`**，無索引才用 `source.embeddingModel`。
- 索引改動後必呼 `invalidateIndexCache(tenantId)`。
- 測試：mock embedding 比照 `knowledge-rag.test.ts` 的 `jest.mock('@/lib/embedding', ...)`；新建租戶隔離；pdf/docx 解析不造二進位 fixture（依賴庫行為，typecheck+手動）。
- 收尾：`cd server && npx jest` 全綠、`npm run typecheck`、`npm run build` 通過。

---

### Task 1: 後端核心——解析 + 檔案 ingest/刪除 + 重爬保留

**Files:**
- Modify: `server/src/modules/knowledge/knowledge-index.types.ts`（`IndexedChunk` 加 `fileId?: string`）
- Modify: `server/src/modules/knowledge/knowledge.store.ts`（`KnowledgeIndexMeta` 加 `files?: KnowledgeFileMeta[]`；export `KnowledgeFileMeta`）
- Create: `server/src/modules/knowledge/knowledge-file.service.ts`
- Modify: 網站 ingest 的索引寫入點（READ `ingest.service.ts`/`knowledge.job.ts` 找到組 `KnowledgeIndexFile` 寫檔的唯一位置）：寫入前併回既有索引中帶 `fileId` 的 chunks（carry-over）
- Test: `server/tests/knowledge-file.test.ts`
- 依賴：`npm i -w server pdf-parse mammoth`（必要時 `npm i -w server -D @types/pdf-parse`）

**Interfaces:**
- Produces:
  - `interface KnowledgeFileMeta { fileId: string; name: string; chunks: number; ingestedAt: string }`
  - `parseFileToText(name: string, buf: Buffer): Promise<string>`（依副檔名分派；不支援副檔名丟 `AppError.badRequest`）
  - `ingestFile(tenantId: string, name: string, buf: Buffer): Promise<KnowledgeFileMeta>`（解析→`chunkText`→embed→附加索引→invalidate→meta.files append→回 meta）
  - `removeFile(tenantId: string, fileId: string): boolean`（索引剔除該 fileId chunks + meta 移除；查無回 false）
  - `carryOverFileChunks(existing: KnowledgeIndexFile | null, webChunks: IndexedChunk[]): IndexedChunk[]`（= webChunks + existing 中帶 fileId 者；供網站 ingest 寫入點使用，並單元測試）

- [ ] **Step 1: 寫失敗測試**

`server/tests/knowledge-file.test.ts`:

```ts
/** 檔案來源：txt/md 解析→附加索引（帶 fileId）→刪除；網站重爬 carry-over 保留檔案 chunks。 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  }),
}));
import { readFileSync, existsSync } from 'node:fs';
import {
  parseFileToText,
  ingestFile,
  removeFile,
  carryOverFileChunks,
} from '@/modules/knowledge/knowledge-file.service';
import { indexPathFor } from '@/modules/knowledge/index-path';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { IndexedChunk, KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import { tenantStore } from '@/modules/tenant/tenant.store';

function readIndex(tenantId: string): KnowledgeIndexFile {
  return JSON.parse(readFileSync(indexPathFor(tenantId), 'utf8')) as KnowledgeIndexFile;
}

describe('parseFileToText', () => {
  it('txt/md 直讀；不支援副檔名 400', async () => {
    await expect(parseFileToText('a.txt', Buffer.from('哈囉 規章內容'))).resolves.toContain('規章');
    await expect(parseFileToText('b.md', Buffer.from('# 標題\n內文'))).resolves.toContain('內文');
    await expect(parseFileToText('c.exe', Buffer.from('x'))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('ingestFile / removeFile', () => {
  it('上傳 txt → 索引出現帶 fileId 的 chunks、meta.files 有紀錄；刪除後移除', async () => {
    const t = tenantStore.createTenant('kfile-basic');
    const text = '請假規定：特休依年資計算。'.repeat(80); // 足量文字切出多個 chunk
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from(text));
    expect(meta.chunks).toBeGreaterThan(0);

    const idx = readIndex(t.id);
    const fileChunks = idx.chunks.filter((c) => c.fileId === meta.fileId);
    expect(fileChunks.length).toBe(meta.chunks);
    expect(fileChunks[0].title).toBe('規章.txt');
    expect(knowledgeStore.getMeta(t.id).files?.some((f) => f.fileId === meta.fileId)).toBe(true);

    expect(removeFile(t.id, meta.fileId)).toBe(true);
    expect(readIndex(t.id).chunks.some((c) => c.fileId === meta.fileId)).toBe(false);
    expect(knowledgeStore.getMeta(t.id).files?.some((f) => f.fileId === meta.fileId)).toBe(false);
  });

  it('抽出文字過短（掃描檔/空檔）→ 422、索引不被建立', async () => {
    const t = tenantStore.createTenant('kfile-empty');
    await expect(ingestFile(t.id, '空.txt', Buffer.from('   '))).rejects.toMatchObject({ statusCode: 422 });
    expect(existsSync(indexPathFor(t.id))).toBe(false); // 無半套狀態
  });
});

describe('carryOverFileChunks（網站重爬保留檔案 chunks）', () => {
  it('web chunks 重建時，既有索引中帶 fileId 的 chunks 被搬運保留', () => {
    const fileChunk: IndexedChunk = {
      id: 'f1', url: 'file://規章.txt', title: '規章.txt', text: 'x', vector: [1], fileId: 'FID',
    };
    const oldWeb: IndexedChunk = { id: 'w-old', url: 'https://a', title: 'A', text: 'x', vector: [1] };
    const existing: KnowledgeIndexFile = {
      generatedAt: '', model: 'm', source: 's', chunks: [oldWeb, fileChunk],
    };
    const newWeb: IndexedChunk = { id: 'w-new', url: 'https://b', title: 'B', text: 'y', vector: [2] };
    const merged = carryOverFileChunks(existing, [newWeb]);
    expect(merged.map((c) => c.id).sort()).toEqual(['f1', 'w-new']); // 舊 web 丟棄、檔案保留
    expect(carryOverFileChunks(null, [newWeb])).toEqual([newWeb]);
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`knowledge-index.types.ts` 的 `IndexedChunk` 加：

```ts
  /** 檔案來源的 chunk：來源檔 id（網站爬取的 chunk 無此欄）。刪檔/重爬保留據此篩選 */
  fileId?: string;
```

`knowledge.store.ts`：加 export 介面與欄位：

```ts
export interface KnowledgeFileMeta {
  fileId: string;
  name: string;
  chunks: number;
  ingestedAt: string;
}
```
`KnowledgeIndexMeta` 加 `files?: KnowledgeFileMeta[];`。

`knowledge-file.service.ts`（完整）：

```ts
/**
 * 知識庫檔案來源：上傳檔解析成文字，沿用 chunk/embedding 管線附加進租戶索引（chunk 標 fileId）。
 * 與網站來源並存：網站重爬經 carryOverFileChunks 保留檔案 chunks；刪檔只移除該檔 chunks。
 * 不保存原始檔（重傳即更新）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { getEmbeddingProvider } from '@/lib/embedding';
import { AppError } from '@/utils/app-error';
import { indexPathFor } from './index-path';
import { chunkText, squash } from './ingest.service';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';
import { knowledgeStore, type KnowledgeFileMeta } from './knowledge.store';
import { invalidateIndexCache } from './retriever.staticIndex';

const MIN_TEXT_CHARS = 20;

/** 依副檔名解析為純文字；不支援的副檔名回 400。 */
export async function parseFileToText(name: string, buf: Buffer): Promise<string> {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext === '.txt' || ext === '.md') return buf.toString('utf8');
  if (ext === '.pdf') {
    const out = await pdfParse(buf);
    return out.text ?? '';
  }
  if (ext === '.docx') {
    const out = await mammoth.extractRawText({ buffer: buf });
    return out.value ?? '';
  }
  throw AppError.badRequest(`不支援的檔案格式：${ext}（支援 .txt/.md/.pdf/.docx）`);
}

function loadIndexFile(tenantId: string): KnowledgeIndexFile | null {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
}

function saveIndexFile(tenantId: string, idx: KnowledgeIndexFile): void {
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx));
  invalidateIndexCache(tenantId);
}

/** 網站重爬寫索引前呼叫：新的 web chunks + 既有索引中帶 fileId 的檔案 chunks。 */
export function carryOverFileChunks(
  existing: KnowledgeIndexFile | null,
  webChunks: IndexedChunk[],
): IndexedChunk[] {
  const fileChunks = existing?.chunks.filter((c) => c.fileId) ?? [];
  return [...webChunks, ...fileChunks];
}

/** 上傳檔 ingest：解析→切塊→embed→附加索引→meta.files。解析成功前不動索引/meta。 */
export async function ingestFile(
  tenantId: string,
  name: string,
  buf: Buffer,
): Promise<KnowledgeFileMeta> {
  const text = squash(await parseFileToText(name, buf));
  if (text.length < MIN_TEXT_CHARS) {
    throw AppError.unprocessable('無可抽取文字（可能為掃描檔或空檔）');
  }
  const source = knowledgeStore.getSource(tenantId);
  const pieces = chunkText(text, source.chunkChars);

  const existing = loadIndexFile(tenantId);
  // 模型一致性：同一份索引只能用同一個 embedding 模型
  const model = existing?.model ?? source.embeddingModel;
  const vectors = await getEmbeddingProvider().embed(pieces, model);

  const fileId = randomUUID();
  const fileChunks: IndexedChunk[] = pieces.map((t, i) => ({
    id: `${fileId}-${i}`,
    url: `file://${name}`,
    title: name,
    text: t,
    vector: vectors[i],
    fileId,
  }));

  const idx: KnowledgeIndexFile = existing
    ? { ...existing, generatedAt: new Date().toISOString(), chunks: [...existing.chunks, ...fileChunks] }
    : {
        generatedAt: new Date().toISOString(),
        model,
        source: `file://${name}`,
        chunks: fileChunks,
      };
  saveIndexFile(tenantId, idx);

  const fileMeta: KnowledgeFileMeta = {
    fileId,
    name,
    chunks: fileChunks.length,
    ingestedAt: new Date().toISOString(),
  };
  const meta = knowledgeStore.getMeta(tenantId);
  knowledgeStore.setMeta(tenantId, {
    ...meta,
    status: 'ready',
    chunkCount: idx.chunks.length,
    generatedAt: idx.generatedAt,
    model: idx.model,
    files: [...(meta.files ?? []), fileMeta],
  });
  return fileMeta;
}

/** 刪除檔案：索引剔除該 fileId 的 chunks + meta 移除；查無回 false。 */
export function removeFile(tenantId: string, fileId: string): boolean {
  const meta = knowledgeStore.getMeta(tenantId);
  if (!meta.files?.some((f) => f.fileId === fileId)) return false;
  const existing = loadIndexFile(tenantId);
  if (existing) {
    const chunks = existing.chunks.filter((c) => c.fileId !== fileId);
    saveIndexFile(tenantId, { ...existing, generatedAt: new Date().toISOString(), chunks });
    knowledgeStore.setMeta(tenantId, {
      ...meta,
      chunkCount: chunks.length,
      files: meta.files.filter((f) => f.fileId !== fileId),
    });
  } else {
    knowledgeStore.setMeta(tenantId, { ...meta, files: meta.files.filter((f) => f.fileId !== fileId) });
  }
  return true;
}
```

**網站重爬 carry-over**：READ `ingest.service.ts`（及/或 `knowledge.job.ts`）找到爬完組 `KnowledgeIndexFile` 並 `writeFileSync` 的位置，改為：寫入前先 `loadIndexFile`（或等價讀取既有索引），`chunks: carryOverFileChunks(existing, webChunks)`；`chunkCount` 等 meta 同步用合併後數字。若該處已有 import 循環疑慮（ingest.service ↔ knowledge-file.service 互 import：knowledge-file 用了 ingest 的 chunkText/squash），把 `carryOverFileChunks` 放 knowledge-file.service、ingest.service 引用它——單向（ingest→file service）＋（file→ingest 的 chunkText）會成環；**解法**：把 `chunkText`/`squash` 保持在 ingest.service，`carryOverFileChunks` 改放 `knowledge-index.types.ts` 旁的小工具或直接放 ingest.service 並由 file service import——實作者擇一保持**單向依賴**，並在報告說明選擇。

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/knowledge-file.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/package.json package-lock.json server/src/modules/knowledge/ server/tests/knowledge-file.test.ts
git commit -m "feat(knowledge): 檔案來源核心——解析/附加/刪除 + 網站重爬保留檔案 chunks"
```

---

### Task 2: admin API（上傳/刪除/查詢含 files）

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.admin.controller.ts`（`uploadFile`/`deleteFile`；`get` 回應含 files——READ 現況確認 get 是否已回 meta 整包）
- Modify: `server/src/modules/admin/admin.routes.ts`（`POST /tenants/:id/knowledge/files`＋multer、`DELETE /tenants/:id/knowledge/files/:fileId`）
- Create（或沿用）：知識檔案上傳 multer 實例（memoryStorage、10MB、單檔；比照 `middlewares/upload.ts` 模式，可於 routes 內建立）
- Test: `server/tests/knowledge-file-admin.test.ts`（supertest，比照 `knowledge-admin.test.ts` 既有模式）

**Interfaces:**
- `POST /api/admin/tenants/:id/knowledge/files`（multipart field `file`）→ `{ data: KnowledgeFileMeta }`；格式不符 400、無文字 422、超限 413（multer）。
- `DELETE /api/admin/tenants/:id/knowledge/files/:fileId` → `{ data: { fileId } }`；查無 404。
- `GET /api/admin/tenants/:id/knowledge` 回應（既有 meta）含 `files`。

- [ ] **Step 1: 寫失敗測試**（supertest：上傳 txt buffer → 201 且 GET 可見 files；上傳 .exe → 400；刪除 → 200 且 GET 消失；刪不存在 → 404。mock embedding 同 Task 1。READ `knowledge-admin.test.ts` 取 app/KEY 建立模式與租戶建立方式照抄。）
- [ ] **Step 2: 失敗 → 實作**（controller 兩方法薄包 service：`ingestFile(tenant.id, req.file.originalname, req.file.buffer)`；routes 加 multer 單檔 + 白名單副檔名檢查在 service 內已有、400 由 parse 丟。）
- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

```bash
git commit -m "feat(admin): 知識庫檔案上傳/刪除端點（multipart，10MB）"
```

---

### Task 3: admin 前端 KnowledgeTab「檔案來源」區塊

**Files:**
- Modify: `admin/src/api.ts`（`KnowledgeFileMeta` 型別；`KnowledgeMeta` 加 `files?`；`uploadKnowledgeFile(id, file)`（FormData、不設 content-type 讓瀏覽器帶 boundary——READ `req<T>` helper 確認可傳 FormData，否則加專用 fetch）；`deleteKnowledgeFile(id, fileId)`）
- Modify: `admin/src/pages/tabs/KnowledgeTab.tsx`（READ 現況；新增「檔案來源」卡片區塊：`<input type="file" accept=".txt,.md,.pdf,.docx">` 上傳、上傳中禁用、成功後刷新；已上傳清單（檔名/塊數/時間/刪除鈕））

- [ ] **Step 1: 實作上述**（沿用 KnowledgeTab 既有卡片/清單/toast 樣式與 onError 模式）
- [ ] **Step 2: 驗收**：`npm run typecheck` 無誤、`npm run build` 成功；手動：dev 起 server+admin → 知識庫分頁上傳一個 .md → 清單出現、chunk 數 >0 → 測試查詢可檢索到內容 → 刪除消失。
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(admin): 知識庫分頁檔案來源區塊（上傳/清單/刪除）"
```

---

## 完成後狀態（驗收）
- admin 可上傳 txt/md/PDF/Word 餵知識庫；chunks 與網站來源同索引、可被問答檢索；重爬不掉檔案內容；可個別刪除。
- 掃描 PDF/空檔如實 422；超限 413；格式白名單 400。
- 全套測試綠、typecheck/build 綠。

## Self-Review 註記
- **Spec 覆蓋**：D1 四格式（pdf-parse/mammoth）、D2 同索引+fileId+carry-over+個別刪除、D3 同步 ingest、D4 不存原始檔。
- **一致性**：模型取現有索引 model；`invalidateIndexCache` 於每次索引寫入後；解析先於任何狀態變更（422 測試驗證無半套）。
- **循環依賴風險**：已在 Task 1 明示（carryOverFileChunks 擺放位置由實作者保持單向並回報）。
- **誠實邊界**：pdf/docx 解析品質依賴庫行為，測試只覆蓋 txt/md 與管線；掃描 PDF 無 OCR（v1 非目標）。
