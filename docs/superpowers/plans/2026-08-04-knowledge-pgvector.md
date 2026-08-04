# Knowledge 模組持久化至 Supabase pgvector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓知識庫的向量索引與來源設定活過容器重啟——把 `server/data/*.json` 搬到既有 Supabase Postgres 的 pgvector。

**Architecture:** 沿用其他八個 store 的 `env.DATA_BACKEND` 雙後端模式（file 保留給本機開發，db 走 Postgres）。索引存取收斂到新的 `knowledge.index.repo.ts`，file / db 兩種實作；查詢熱路徑不再全量載入，改由 `retriever.pgvector.ts` 以 HNSW 索引在資料庫端取 top-k。檢索評分公式抽成共用模組，讓兩個 retriever 行為可被測試證明一致。

**Tech Stack:** TypeScript / Express / Prisma（僅 `knowledge_sources`、`knowledge_indexes` 兩表；`knowledge_chunks` 因 `halfvec` 型別 Prisma 無法表達，一律走 `$queryRaw`）/ pgvector ≥ 0.7 / Jest。

## Global Constraints

- 向量型別固定 `halfvec(3072)`，對應 `text-embedding-3-large`。**不得**降維——降維要重跑四個租戶的 ingest，重複支出 embedding 費用。
- ANN 索引固定 `hnsw (embedding halfvec_cosine_ops)`。`vector` 型別的 HNSW 上限是 2000 維，3072 維只有 `halfvec` 能建索引。
- 檢索行為必須與現行 `retriever.staticIndex.ts` 等價，包含這三個常數：`MIN_SCORE = 0.2`、`LEXICAL_BOOST = 0.15`、`LEXICAL_BOOST_CAP = 0.45`，以及保留條件 `cosine >= MIN_SCORE || hits > 0`（**或**，不是且）與 `POOL_SIZE = 20`。
- 測試一律不打真資料庫。`tests/setup-env.ts` 固定 `DATA_BACKEND=file`；db 路徑以假 Prisma client 注入驗證。
- DDL 以 `server/db/migrations/` 的 SQL 檔管理並經 Supabase 套用，`server/prisma/schema.prisma` 僅作型別來源，兩邊必須同步（沿用檔頭既有規範）。
- 所有新表 `enable row level security`（沿用 `0004_attachments.sql` 慣例）。
- 註解與 commit message 用繁體中文，沿用 repo 現行風格。

---

### Task 1: 抽出共用檢索評分模組

把 `retriever.staticIndex.ts` 裡的評分邏輯抽成獨立模組，讓 file 與 db 兩個 retriever 共用同一份公式。此任務**不改變任何行為**，是後續等價性的基礎。

**Files:**
- Create: `server/src/modules/knowledge/retriever.scoring.ts`
- Modify: `server/src/modules/knowledge/retriever.staticIndex.ts:17-45`（移除 `asciiTerms`／`lexicalHits`／常數，改為 import）
- Test: `server/tests/knowledge-scoring.test.ts`

**Interfaces:**
- Consumes: 無（此為第一個任務）
- Produces:
  - `asciiTerms(text: string): string[]`
  - `lexicalHits(terms: string[], hay: string): number`
  - `cosineSimilarity(a: number[], b: number[]): number`
  - `scoreOf(cosine: number, hits: number): number`
  - `keepChunk(cosine: number, hits: number): boolean`
  - `POOL_SIZE: number`、`MIN_SCORE: number`
  - `retriever.staticIndex.ts` 繼續 re-export `cosineSimilarity`（`knowledge-rag.test.ts:22` 由該路徑 import，不可破壞）

- [ ] **Step 1: 先寫失敗的測試**

建立 `server/tests/knowledge-scoring.test.ts`：

```typescript
/**
 * 檢索評分共用模組：專有名詞抽取、lexical 命中加權、保留條件。
 * 這些常數與公式是 file / pgvector 兩個 retriever 的共同契約，改動即為行為變更。
 */
import {
  asciiTerms,
  cosineSimilarity,
  keepChunk,
  lexicalHits,
  MIN_SCORE,
  POOL_SIZE,
  scoreOf,
} from '@/modules/knowledge/retriever.scoring';

describe('asciiTerms', () => {
  it('抽出 ASCII 專有名詞並轉小寫', () => {
    expect(asciiTerms('請問 HyEIP 跟 SpaceMe 差在哪')).toEqual(['hyeip', 'spaceme']);
  });
  it('單一字元與純中文不算專有名詞', () => {
    expect(asciiTerms('請問 A 方案的價格')).toEqual([]);
  });
});

describe('lexicalHits', () => {
  it('大小寫不敏感計數', () => {
    expect(lexicalHits(['hyeip', 'hylib'], 'HyEIP 入口網 與 hylib')).toBe(2);
  });
  it('未命中回 0', () => {
    expect(lexicalHits(['hyeip'], '無關內容')).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('相同向量為 1、正交為 0、長度不符為 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('scoreOf', () => {
  it('每個命中加 0.15', () => {
    expect(scoreOf(0.5, 2)).toBeCloseTo(0.8);
  });
  it('加權上限 0.45（3 個命中封頂）', () => {
    expect(scoreOf(0.5, 10)).toBeCloseTo(0.95);
  });
  it('無命中即原始餘弦值', () => {
    expect(scoreOf(0.42, 0)).toBeCloseTo(0.42);
  });
});

describe('keepChunk', () => {
  it('語意夠近即保留', () => {
    expect(keepChunk(MIN_SCORE, 0)).toBe(true);
  });
  it('語意遠但有專有名詞命中仍保留（強訊號）', () => {
    expect(keepChunk(0.01, 1)).toBe(true);
  });
  it('語意遠且無命中即淘汰', () => {
    expect(keepChunk(0.19, 0)).toBe(false);
  });
});

describe('常數契約', () => {
  it('鎖定現行值', () => {
    expect(MIN_SCORE).toBe(0.2);
    expect(POOL_SIZE).toBe(20);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-scoring`
Expected: FAIL — `Cannot find module '@/modules/knowledge/retriever.scoring'`

- [ ] **Step 3: 建立 retriever.scoring.ts**

```typescript
/**
 * 檢索評分的共用公式：file 靜態索引與 pgvector 兩個 retriever 共用同一份，
 * 確保換後端不會悄悄改變排序與召回。常數即行為契約，改動請連同測試一起。
 */

/** 回傳候選池上限（供後續 LLM 重排挑最終前幾筆）；未開重排時消費端自行取前 K */
export const POOL_SIZE = 20;
/** 語意相似度過低者視為不相關，避免硬湊 */
export const MIN_SCORE = 0.2;
/** 每個命中的專有名詞/代碼加權（HyEIP、SpaceMe…） */
export const LEXICAL_BOOST = 0.15;
export const LEXICAL_BOOST_CAP = 0.45;

/** 取查詢中的 ASCII 專有名詞/產品代碼（≥2 字元），供 lexical 命中加權 */
export function asciiTerms(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9]{1,}/g) ?? []).map((t) => t.toLowerCase());
}

/** lexical 命中數：查詢中的專有名詞出現在 chunk 標題/內容者計數（大小寫不敏感） */
export function lexicalHits(terms: string[], hay: string): number {
  const lower = hay.toLowerCase();
  return terms.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 混合檢索最終分數：語意相似度 + 專有名詞精確命中加權（有上限） */
export function scoreOf(cosine: number, hits: number): number {
  return cosine + Math.min(hits * LEXICAL_BOOST, LEXICAL_BOOST_CAP);
}

/** 保留條件：語意夠近「或」有專有名詞精確命中（強訊號）。注意是 or 不是 and */
export function keepChunk(cosine: number, hits: number): boolean {
  return cosine >= MIN_SCORE || hits > 0;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- knowledge-scoring`
Expected: PASS（14 個案例）

- [ ] **Step 5: 改寫 retriever.staticIndex.ts 使用共用模組**

刪除 `retriever.staticIndex.ts:17-45` 的常數與三個函式定義，改為在 import 區塊加入：

```typescript
import {
  asciiTerms,
  cosineSimilarity,
  keepChunk,
  lexicalHits,
  POOL_SIZE,
  scoreOf,
} from './retriever.scoring';

// knowledge-rag.test.ts 由本模組 import cosineSimilarity，維持既有匯出路徑
export { cosineSimilarity };
```

並把 `search` 內的評分段落改成：

```typescript
    const terms = asciiTerms(q);
    return idx.chunks
      .map((c) => {
        const cosine = cosineSimilarity(queryVec, c.vector);
        const hits = terms.length ? lexicalHits(terms, `${c.title}\n${c.text}`) : 0;
        return { id: c.id, title: c.title, content: c.text, url: c.url, cosine, hits, score: scoreOf(cosine, hits) };
      })
      .filter((c) => keepChunk(c.cosine, c.hits))
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL_SIZE)
      .map(({ id, title, content, url, score }) => ({ id, title, content, url, score }));
```

- [ ] **Step 6: 執行既有測試確認行為未變**

Run: `npm test -w server -- knowledge-rag knowledge-scoring && npm run typecheck -w server`
Expected: 全部 PASS。`knowledge-rag.test.ts` 是這次重構的回歸網，一個案例都不能掛。

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/retriever.scoring.ts \
        server/src/modules/knowledge/retriever.staticIndex.ts \
        server/tests/knowledge-scoring.test.ts
git commit -m "refactor(knowledge): 抽出檢索評分共用模組"
```

---

### Task 2: 資料庫 schema（migration + Prisma 模型）

**Files:**
- Create: `server/db/migrations/0005_knowledge.sql`
- Modify: `server/prisma/schema.prisma`（檔尾追加兩個 model）

**Interfaces:**
- Consumes: 無
- Produces:
  - 表 `knowledge_sources(tenant_id text pk, source jsonb, meta jsonb, updated_at timestamptz)`
  - 表 `knowledge_indexes(tenant_id text pk, generated_at timestamptz, model text, source text, updated_at timestamptz)`
  - 表 `knowledge_chunks(tenant_id text, id text, url text, title text, text text, file_id text, embedding halfvec(3072), pk(tenant_id, id))`
  - Prisma model `KnowledgeSourceRow`、`KnowledgeIndexRow`（`knowledge_chunks` **不入** Prisma）

- [ ] **Step 1: 撰寫 migration SQL**

建立 `server/db/migrations/0005_knowledge.sql`：

```sql
-- 0005: 知識庫落地（DATA_BACKEND=db；先前為 server/data/*.json，容器重啟即遺失）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
-- knowledge_chunks 不入 Prisma：halfvec 為 pgvector 型別，Prisma schema 無法表達，一律走 $queryRaw。

create extension if not exists vector;

-- 每租戶的來源設定（KnowledgeSource）與索引狀態（KnowledgeIndexMeta）
create table if not exists knowledge_sources (
  tenant_id  text primary key,
  source     jsonb not null default '{}',
  meta       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- 索引層級 metadata（對應 KnowledgeIndexFile 的 generatedAt / model / source）。
-- 與 meta 分開存：meta 是給 admin 顯示的狀態，可能落後；本表是索引本身的事實，
-- ingestFile 的「同一份索引只能用同一個 embedding 模型」據此判定，不能取用可能過期的值。
create table if not exists knowledge_indexes (
  tenant_id    text primary key,
  generated_at timestamptz not null,
  model        text not null,
  source       text not null,
  updated_at   timestamptz not null default now()
);

-- 向量 chunks。halfvec(3072) 對應 text-embedding-3-large：
-- vector 型別的 HNSW 索引上限為 2000 維，3072 維只有 halfvec 建得了索引。
create table if not exists knowledge_chunks (
  tenant_id text not null,
  id        text not null,
  url       text not null,
  title     text not null,
  text      text not null,
  file_id   text,
  embedding halfvec(3072) not null,
  primary key (tenant_id, id)
);

-- 檢索熱路徑：where tenant_id = $1 order by embedding <=> $2 limit 20
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding halfvec_cosine_ops);

-- 刪檔／重爬時以 fileId 篩選 chunks
create index if not exists knowledge_chunks_file_idx
  on knowledge_chunks (tenant_id, file_id);

alter table knowledge_sources enable row level security;
alter table knowledge_indexes enable row level security;
alter table knowledge_chunks  enable row level security;
```

- [ ] **Step 2: 在 Supabase 套用 migration 並驗證**

在 Supabase SQL Editor（或 MCP `apply_migration`）執行上述 SQL，接著驗證：

```sql
select extname, extversion from pg_extension where extname = 'vector';
```

Expected: 回一列，`extversion` ≥ `0.7.0`。**若低於 0.7，`halfvec` 不存在，migration 會在建表時失敗** —— 此時停下來回報，不要自行改用降維方案（見 Global Constraints）。

```sql
select indexname from pg_indexes where tablename = 'knowledge_chunks';
```

Expected: 含 `knowledge_chunks_embedding_idx`、`knowledge_chunks_file_idx`。

- [ ] **Step 3: 追加 Prisma 模型**

在 `server/prisma/schema.prisma` 檔尾追加：

```prisma
model KnowledgeSourceRow {
  tenantId  String   @id @map("tenant_id")
  /// KnowledgeSource（startUrl / maxPages / chunkChars / embeddingModel / rerank…）
  source    Json     @default("{}")
  /// KnowledgeIndexMeta（status / chunkCount / files / suggestedPrompts…）
  meta      Json     @default("{}")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("knowledge_sources")
}

model KnowledgeIndexRow {
  tenantId    String   @id @map("tenant_id")
  generatedAt DateTime @map("generated_at")
  model       String
  source      String
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("knowledge_indexes")
}

/// 註：knowledge_chunks 刻意不建 model——embedding 欄位為 pgvector 的 halfvec(3072)，
/// Prisma schema 無對應型別。該表的讀寫一律經 lib/db 的 $queryRaw / $executeRaw。
```

- [ ] **Step 4: 重新產生 Prisma client 並型別檢查**

Run: `npm run db:generate -w server && npm run typecheck -w server`
Expected: 產生成功、typecheck 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/0005_knowledge.sql server/prisma/schema.prisma
git commit -m "feat(knowledge): 新增 pgvector 索引與來源設定資料表"
```

---

### Task 3: knowledge.store 接上 db 後端

`knowledge.store.ts` 是唯一沒有 `DATA_BACKEND` 分支的 store。補上，語意比照 `webhook.store.ts`：file 模式維持模組載入即同步還原，db 模式由 `initKnowledgeStore()` 在 listen 前載回。

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.store.ts:95-160`
- Modify: `server/src/index.ts:5-30`
- Test: `server/tests/knowledge-store-db.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `KnowledgeSourceRow`
- Produces:
  - `initKnowledgeStore(): Promise<void>`
  - `knowledgeStore.saveSource` / `setMeta` 在 db 模式改走寫入佇列

- [ ] **Step 1: 先寫失敗的測試**

建立 `server/tests/knowledge-store-db.test.ts`：

```typescript
/**
 * knowledge.store 的 db 後端：以假 Prisma client 驗證 upsert 內容與開機還原，
 * 不打真資料庫（tests/setup-env.ts 固定 DATA_BACKEND=file，此處以 isolateModules 覆寫）。
 */
const upsert = jest.fn().mockResolvedValue(undefined);
const findMany = jest.fn().mockResolvedValue([]);

jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ knowledgeSourceRow: { upsert, findMany } }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void {
      void task({ knowledgeSourceRow: { upsert, findMany } });
    }
    flush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

/** 在 DATA_BACKEND=db 下重新載入 store（env 於模組載入時定型，必須 isolateModules） */
function loadStoreInDbMode(): typeof import('@/modules/knowledge/knowledge.store') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/knowledge/knowledge.store');
  jest.isolateModules(() => {
    mod = require('@/modules/knowledge/knowledge.store');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  upsert.mockClear();
  findMany.mockClear();
});

describe('knowledgeStore（db 後端）', () => {
  it('saveSource 寫入 knowledge_sources，帶 tenant_id 與 source', async () => {
    const { knowledgeStore } = loadStoreInDbMode();
    knowledgeStore.saveSource('t1', {
      startUrl: 'https://x.com', maxPages: 50, chunkChars: 600,
      embeddingModel: 'text-embedding-3-large', rerank: false,
    });
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 't1' });
    expect(arg.create.source).toMatchObject({ startUrl: 'https://x.com', rerank: false });
  });

  it('setMeta 寫入 meta 欄位而不覆蓋 source', async () => {
    const { knowledgeStore } = loadStoreInDbMode();
    knowledgeStore.setMeta('t2', { status: 'ready', chunkCount: 7 });
    await Promise.resolve();
    const arg = upsert.mock.calls[0][0];
    expect(arg.update.meta).toMatchObject({ status: 'ready', chunkCount: 7 });
    expect(arg.update.source).toBeUndefined();
  });

  it('initKnowledgeStore 從資料庫還原 source 與 meta', async () => {
    findMany.mockResolvedValueOnce([
      {
        tenantId: 't3',
        source: { startUrl: 'https://restored.com', maxPages: 10, chunkChars: 800,
                  embeddingModel: 'text-embedding-3-large', rerank: true },
        meta: { status: 'ready', chunkCount: 42 },
      },
    ]);
    const { knowledgeStore, initKnowledgeStore } = loadStoreInDbMode();
    await initKnowledgeStore();
    expect(knowledgeStore.getSource('t3').startUrl).toBe('https://restored.com');
    expect(knowledgeStore.getMeta('t3').chunkCount).toBe(42);
  });

  it('空的 source/meta（jsonb 預設 {}）不會污染預設值', async () => {
    findMany.mockResolvedValueOnce([{ tenantId: 't4', source: {}, meta: {} }]);
    const { knowledgeStore, initKnowledgeStore } = loadStoreInDbMode();
    await initKnowledgeStore();
    expect(knowledgeStore.getSource('t4').maxPages).toBeGreaterThan(0);
    expect(knowledgeStore.getMeta('t4').status).toBe('none');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-store-db`
Expected: FAIL — `initKnowledgeStore is not a function`

- [ ] **Step 3: 改寫 knowledge.store.ts**

`server/src/modules/knowledge/knowledge.store.ts:95-130` 整段（`const FILE` 到 `restore()` IIFE 結束）替換為：

```typescript
/** 持久化 JSON 路徑：存在 KNOWLEDGE_INDEX_DIR 下（file 後端） */
const FILE = resolve(process.cwd(), env.KNOWLEDGE_INDEX_DIR, 'knowledge-config.json');

/** 以租戶 ID 為 key 的來源設定 Map */
const sources = new Map<string, KnowledgeSource>();
/** 以租戶 ID 為 key 的索引 meta Map */
const metas = new Map<string, KnowledgeIndexMeta>();

const writeQueue = new DbWriteQueue('knowledge-sources');

/** 將目前 Map 狀態寫入磁碟 JSON（file 後端） */
function persist(): void {
  try {
    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(
      FILE,
      JSON.stringify({ sources: [...sources], metas: [...metas] }),
      'utf8',
    );
  } catch (err) {
    logger.warn({ err }, 'knowledge config persist failed');
  }
}

/**
 * db 後端：定向 upsert 單一租戶。
 * source 與 meta 兩個欄位分開寫——setMeta 不該覆蓋 saveSource 的內容，反之亦然。
 */
function upsertToDb(tenantId: string, patch: { source?: KnowledgeSource; meta?: KnowledgeIndexMeta }): void {
  // undefined 欄位序列化剔除（與 file 後端同語意）
  const json = <T,>(v: T): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  const create = {
    tenantId,
    source: patch.source ? json(patch.source) : {},
    meta: patch.meta ? json(patch.meta) : {},
  };
  const update = {
    ...(patch.source ? { source: json(patch.source) } : {}),
    ...(patch.meta ? { meta: json(patch.meta) } : {}),
  };
  writeQueue.enqueue(async (db) => {
    await db.knowledgeSourceRow.upsert({ where: { tenantId }, create, update });
  });
}

/** 依後端寫回（db 走佇列、file 寫檔） */
function save(tenantId: string, patch: { source?: KnowledgeSource; meta?: KnowledgeIndexMeta }): void {
  if (env.DATA_BACKEND === 'db') upsertToDb(tenantId, patch);
  else persist();
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as {
        sources: [string, KnowledgeSource][];
        metas: [string, KnowledgeIndexMeta][];
      };
      raw.sources?.forEach(([k, v]) => sources.set(k, v));
      raw.metas?.forEach(([k, v]) => metas.set(k, v));
    }
  } catch (err) {
    logger.warn({ err }, 'knowledge config restore failed');
  }
}

/**
 * db 後端的開機載入。必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 * jsonb 欄位預設 '{}'，空物件視同未設定，交由 getSource/getMeta 的預設值處理。
 */
export async function initKnowledgeStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.knowledgeSourceRow.findMany();
  for (const r of rows) {
    const src = r.source as unknown as KnowledgeSource;
    const meta = r.meta as unknown as KnowledgeIndexMeta;
    if (src && Object.keys(src).length) sources.set(r.tenantId, src);
    if (meta && Object.keys(meta).length) metas.set(r.tenantId, meta);
  }
  logger.info({ count: rows.length }, 'knowledge config restored from db');
}
```

import 區塊（`knowledge.store.ts:5-9`）加入：

```typescript
import type { Prisma } from '@prisma/client';
import { connectDb, DbWriteQueue } from '@/lib/db';
```

`saveSource` 與 `setMeta` 的 `persist()` 呼叫改為：

```typescript
  saveSource(tenantId: string, src: Omit<KnowledgeSource, 'updatedAt'>): KnowledgeSource {
    const saved: KnowledgeSource = { ...src, updatedAt: new Date().toISOString() };
    sources.set(tenantId, saved);
    save(tenantId, { source: saved });
    return saved;
  },
```

```typescript
  setMeta(tenantId: string, meta: KnowledgeIndexMeta): void {
    metas.set(tenantId, meta);
    save(tenantId, { meta });
  },
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- knowledge-store-db knowledge-store`
Expected: 兩支都 PASS（db 新測試 4 個案例、既有 file 測試 3 個案例不受影響）

- [ ] **Step 5: 接上開機流程**

`server/src/index.ts` 的 import 區加入：

```typescript
import { initKnowledgeStore } from '@/modules/knowledge/knowledge.store';
```

並在 `main()` 的 `Promise.all([...])` 陣列中，`initWebhookStore(),` 之後加入：

```typescript
    initKnowledgeStore(),
```

- [ ] **Step 6: 型別檢查與全測試**

Run: `npm run typecheck -w server && npm test -w server`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/knowledge.store.ts server/src/index.ts \
        server/tests/knowledge-store-db.test.ts
git commit -m "feat(knowledge): 來源設定與索引 meta 落地 Postgres"
```

---

### Task 4: 索引存取收斂到 repository（file 實作）

目前索引的讀寫散在三處：`knowledge-file.service.ts` 的 `loadIndexFile`/`saveIndexFile`、`ingest.service.ts` 的 `loadExistingIndex` 與 `runIngest` 內嵌寫檔、`retriever.staticIndex.ts` 的 `loadIndex`。先收斂成單一介面（**只做 file 實作，行為不變**），Task 5 才加 db 實作。

此任務會把讀寫改為 async，波及三個呼叫點——都已在 async 情境中，不會外溢到同步 API。

**Files:**
- Create: `server/src/modules/knowledge/knowledge.index.repo.ts`
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts:76-88,109,147,175-178`
- Modify: `server/src/modules/knowledge/ingest.service.ts:103-106,373,381-383`
- Modify: `server/src/modules/knowledge/knowledge.admin.controller.ts:109,166`
- Test: `server/tests/knowledge-index-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `retriever.scoring`（未直接用，但同模組群）
- Produces:
  - `loadIndex(tenantId: string): Promise<KnowledgeIndexFile | null>`
  - `saveIndex(tenantId: string, idx: KnowledgeIndexFile): Promise<void>`
  - `loadIndexFile` / `removeFile` 改為回 `Promise`（呼叫端需 `await`）

- [ ] **Step 1: 先寫失敗的測試**

建立 `server/tests/knowledge-index-repo.test.ts`：

```typescript
/**
 * 索引 repository（file 後端）：寫入後可讀回、無索引回 null、覆寫為整份取代。
 * KNOWLEDGE_INDEX_DIR 已由 tests/setup-env.ts 指向暫存目錄。
 */
import { loadIndex, saveIndex } from '@/modules/knowledge/knowledge.index.repo';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function makeIndex(chunkIds: string[]): KnowledgeIndexFile {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    model: 'text-embedding-3-large',
    source: 'https://example.com',
    chunks: chunkIds.map((id) => ({
      id, url: 'https://example.com/a', title: `標題 ${id}`, text: `內容 ${id}`, vector: [1, 0, 0],
    })),
  };
}

describe('knowledge index repo（file 後端）', () => {
  it('無索引時回 null', async () => {
    expect(await loadIndex(uid('repo-empty'))).toBeNull();
  });

  it('saveIndex 後 loadIndex 讀回同樣內容', async () => {
    const t = uid('repo-roundtrip');
    await saveIndex(t, makeIndex(['a', 'b']));
    const got = await loadIndex(t);
    expect(got?.model).toBe('text-embedding-3-large');
    expect(got?.chunks.map((c) => c.id)).toEqual(['a', 'b']);
    expect(got?.chunks[0].vector).toEqual([1, 0, 0]);
  });

  it('再次 saveIndex 為整份取代而非附加', async () => {
    const t = uid('repo-replace');
    await saveIndex(t, makeIndex(['a', 'b']));
    await saveIndex(t, makeIndex(['c']));
    expect((await loadIndex(t))?.chunks.map((c) => c.id)).toEqual(['c']);
  });

  it('保留 fileId 欄位（刪檔／重爬據此篩選）', async () => {
    const t = uid('repo-fileid');
    const idx = makeIndex(['a']);
    idx.chunks[0].fileId = 'F1';
    await saveIndex(t, idx);
    expect((await loadIndex(t))?.chunks[0].fileId).toBe('F1');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-index-repo`
Expected: FAIL — `Cannot find module '@/modules/knowledge/knowledge.index.repo'`

- [ ] **Step 3: 建立 repository（file 實作）**

建立 `server/src/modules/knowledge/knowledge.index.repo.ts`：

```typescript
/**
 * 向量索引的持久化層：收斂原本散在 ingest.service / knowledge-file.service /
 * retriever.staticIndex 的三處讀寫。
 *
 * file 後端＝單一 JSON 檔（原行為）；db 後端於 Task 5 加入。
 * 語意固定為「整份載入 / 整份取代」——與原本的檔案覆寫一致，呼叫端邏輯不必改寫。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { indexPathFor } from './index-path';
import type { KnowledgeIndexFile } from './knowledge-index.types';
import { invalidateIndexCache } from './retriever.staticIndex';

/** 讀取整份索引；不存在回 null */
export async function loadIndex(tenantId: string): Promise<KnowledgeIndexFile | null> {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
}

/** 整份取代該租戶的索引 */
export async function saveIndex(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx), 'utf8');
  invalidateIndexCache(tenantId);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- knowledge-index-repo`
Expected: PASS（4 個案例）

- [ ] **Step 5: 改寫 knowledge-file.service.ts 使用 repository**

`knowledge-file.service.ts:76-88` 的 `loadIndexFile` 與 `saveIndexFile` 兩個函式定義整段刪除，改為：

```typescript
/** 直讀索引（不經 retriever 的記憶體快取）；無索引回 null */
export const loadIndexFile = loadIndex;
```

import 區塊加入 `import { loadIndex, saveIndex } from './knowledge.index.repo';`，並移除已不再使用的 `existsSync`／`readFileSync`／`writeFileSync`／`mkdirSync`／`dirname`／`indexPathFor`／`invalidateIndexCache` import（`ingestFile` 內其餘邏輯不動）。

接著三處呼叫改為 await：

- `:109` `const existing = loadIndexFile(tenantId);` → `const existing = await loadIndex(tenantId);`
- `:147` `saveIndexFile(tenantId, idx);` → `await saveIndex(tenantId, idx);`
- `removeFile` 改為 async：

```typescript
/** 刪除檔案：索引剔除該 fileId 的 chunks + meta 移除；查無回 false。 */
export async function removeFile(tenantId: string, fileId: string): Promise<boolean> {
  const meta = knowledgeStore.getMeta(tenantId);
  if (!meta.files?.some((f) => f.fileId === fileId)) return false;
  const existing = await loadIndex(tenantId);
  if (existing) {
    const chunks = existing.chunks.filter((c) => c.fileId !== fileId);
    await saveIndex(tenantId, { ...existing, generatedAt: new Date().toISOString(), chunks });
    knowledgeStore.setMeta(tenantId, {
      ...meta,
      chunkCount: chunks.length,
      files: meta.files.filter((f) => f.fileId !== fileId),
      chunkCountBySource: countBySource(chunks),
    });
    void refreshSuggestedPrompts(tenantId, { ...existing, chunks }).catch(() => {});
  } else {
    knowledgeStore.setMeta(tenantId, { ...meta, files: meta.files.filter((f) => f.fileId !== fileId) });
  }
  return true;
}
```

- [ ] **Step 6: 改寫 ingest.service.ts 使用 repository**

`ingest.service.ts:103-106` 的 `loadExistingIndex` 函式定義刪除，import 區塊加入 `import { loadIndex, saveIndex } from './knowledge.index.repo';`。

`:373` 改為 `const existing = await loadIndex(params.tenantId);`

`:381-383` 三行（`const path = indexPathFor(...)` 到 `writeFileSync(...)`）替換為：

```typescript
  await saveIndex(params.tenantId, index);
```

移除隨之未使用的 `existsSync`／`mkdirSync`／`writeFileSync`／`dirname`／`indexPathFor` import。

- [ ] **Step 7: 改寫 admin controller 的兩個呼叫點**

- `knowledge.admin.controller.ts:109` → `const idx = await loadIndexFile(tenantId);`
- `:166` → `const removed = await removeFile(tenantId, fileId);`

（兩個 handler 皆已是 `async`，不需改簽章。）

- [ ] **Step 8: 補上測試中 removeFile 的 await**

`removeFile` 改為回 `Promise<boolean>` 後，既有測試有 5 處同步呼叫必須補 `await`，
否則 `expect(...).toBe(true)` 會拿到 Promise 而失敗、未 await 的呼叫則造成競態。
逐處修正（各處所在的 `it` 皆已是 async，不需改簽章）：

| 檔案 | 行 | 改為 |
|---|---|---|
| `server/tests/knowledge-file.test.ts` | 101 | `expect(await removeFile(t.id, meta.fileId)).toBe(true);` |
| `server/tests/knowledge-file.test.ts` | 125 | `await removeFile(t.id, meta.fileId);` |
| `server/tests/knowledge-suggest-trigger.test.ts` | 105 | `expect(await removeFile(tenantId, fileA.fileId)).toBe(true);` |
| `server/tests/knowledge-suggest-trigger.test.ts` | 122 | `expect(await removeFile(tenantId, onlyFile.fileId)).toBe(true);` |
| `server/tests/knowledge-chunk-count-by-source.test.ts` | 77 | `await removeFile(tenantIdTwoFiles, metaA.fileId);` |

- [ ] **Step 9: 型別檢查與全測試**

Run: `npm run typecheck -w server && npm test -w server`
Expected: 全部 PASS。`knowledge-file.test.ts`、`knowledge-suggest-trigger.test.ts`、
`knowledge-chunk-count-by-source.test.ts`、`knowledge-manual-survives-reingest.test.ts`
是這次 async 化的回歸網，一個案例都不能掛。

- [ ] **Step 10: Commit**

```bash
git add server/src/modules/knowledge/ server/tests/knowledge-index-repo.test.ts
git commit -m "refactor(knowledge): 索引讀寫收斂至 repository"
```

---

### Task 5: repository 的 db 實作

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.index.repo.ts`
- Test: `server/tests/knowledge-index-repo-db.test.ts`

**Interfaces:**
- Consumes: Task 2 的三張表、Task 4 的 `loadIndex`/`saveIndex` 簽章
- Produces:
  - `toVectorLiteral(vec: number[]): string` — 匯出供 Task 6 與遷移腳本共用
  - `CHUNK_INSERT_BATCH = 200`

- [ ] **Step 1: 先寫失敗的測試**

建立 `server/tests/knowledge-index-repo-db.test.ts`：

```typescript
/**
 * 索引 repository 的 db 後端：向量字面值格式、整份取代語意、分批寫入。
 * 以假 Prisma client 攔截 $executeRaw / $queryRaw，不打真資料庫。
 */
const executeRaw = jest.fn().mockResolvedValue(0);
const queryRaw = jest.fn().mockResolvedValue([]);
const transaction = jest.fn(async (ops: unknown[]) => ops);

jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: transaction,
  }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

function loadRepoInDbMode(): typeof import('@/modules/knowledge/knowledge.index.repo') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/knowledge/knowledge.index.repo');
  jest.isolateModules(() => {
    mod = require('@/modules/knowledge/knowledge.index.repo');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  executeRaw.mockClear();
  queryRaw.mockClear();
});

const idx: KnowledgeIndexFile = {
  generatedAt: '2026-08-04T00:00:00.000Z',
  model: 'text-embedding-3-large',
  source: 'https://example.com',
  chunks: [
    { id: 'a', url: 'https://example.com/a', title: 'A', text: '內容 A', vector: [1, 0, 0] },
    { id: 'b', url: 'https://example.com/b', title: 'B', text: '內容 B', vector: [0, 1, 0], fileId: 'F1' },
  ],
};

describe('toVectorLiteral', () => {
  it('輸出 pgvector 接受的方括號字面值', () => {
    const { toVectorLiteral } = loadRepoInDbMode();
    expect(toVectorLiteral([1, -0.5, 0])).toBe('[1,-0.5,0]');
  });
  it('空向量輸出 []', () => {
    const { toVectorLiteral } = loadRepoInDbMode();
    expect(toVectorLiteral([])).toBe('[]');
  });
});

describe('saveIndex（db 後端）', () => {
  it('先刪該租戶既有 chunks 再寫入（整份取代）', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    // 第一個 statement 必須是 delete，否則會與舊 chunks 混在一起
    const first = String(executeRaw.mock.calls[0]?.[0] ?? '');
    expect(first.toLowerCase()).toContain('delete');
    expect(executeRaw.mock.calls.length).toBeGreaterThanOrEqual(3); // delete + chunks + indexes upsert
  });

  it('索引層級 metadata 一併寫入 knowledge_indexes', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    const stmts = executeRaw.mock.calls.map((c) => String(c[0] ?? '').toLowerCase());
    expect(stmts.some((s) => s.includes('knowledge_indexes'))).toBe(true);
  });
});

describe('loadIndex（db 後端）', () => {
  it('查無 metadata 列時回 null（未建索引）', async () => {
    queryRaw.mockResolvedValueOnce([]);
    const { loadIndex } = loadRepoInDbMode();
    expect(await loadIndex('nobody')).toBeNull();
  });

  it('組回 KnowledgeIndexFile，向量字串還原為數字陣列', async () => {
    queryRaw
      .mockResolvedValueOnce([
        { generated_at: new Date('2026-08-04T00:00:00.000Z'), model: 'text-embedding-3-large', source: 'https://example.com' },
      ])
      .mockResolvedValueOnce([
        { id: 'a', url: 'https://example.com/a', title: 'A', text: '內容 A', file_id: null, embedding: '[1,0,0]' },
      ]);
    const { loadIndex } = loadRepoInDbMode();
    const got = await loadIndex('t1');
    expect(got?.model).toBe('text-embedding-3-large');
    expect(got?.chunks[0].vector).toEqual([1, 0, 0]);
    expect(got?.chunks[0].fileId).toBeUndefined();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-index-repo-db`
Expected: FAIL — `toVectorLiteral is not a function`

- [ ] **Step 3: 加入 db 實作**

`knowledge.index.repo.ts` 全檔改寫為：

```typescript
/**
 * 向量索引的持久化層：收斂原本散在 ingest.service / knowledge-file.service /
 * retriever.staticIndex 的三處讀寫。
 *
 * file 後端＝單一 JSON 檔（原行為）；db 後端＝knowledge_chunks + knowledge_indexes。
 * 語意固定為「整份載入 / 整份取代」，與原本的檔案覆寫一致，呼叫端邏輯不必改寫。
 *
 * 註：整份載入在 db 後端會把該租戶所有向量撈回（1.5k chunks 約 9MB）。
 * 這只發生在上傳檔／重爬／推薦詞生成等低頻路徑；查詢熱路徑走 retriever.pgvector 的
 * SQL top-k，永遠不會全量載入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { indexPathFor } from './index-path';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';
import { invalidateIndexCache } from './retriever.staticIndex';

/** 單次 INSERT 的最大列數：3072 維 × 200 列約 2.4MB statement，遠低於 Postgres 限制 */
export const CHUNK_INSERT_BATCH = 200;

/** number[] → pgvector 字面值（'[1,-0.5,0]'）。查詢與寫入共用，格式不可分歧 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** pgvector 回傳的字面值 → number[] */
function parseVectorLiteral(lit: string): number[] {
  const inner = lit.slice(1, -1);
  return inner ? inner.split(',').map(Number) : [];
}

// ---- file 後端 ----

function loadIndexFromFile(tenantId: string): KnowledgeIndexFile | null {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
}

function saveIndexToFile(tenantId: string, idx: KnowledgeIndexFile): void {
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx), 'utf8');
}

// ---- db 後端 ----

interface IndexMetaRow {
  generated_at: Date;
  model: string;
  source: string;
}

interface ChunkRow {
  id: string;
  url: string;
  title: string;
  text: string;
  file_id: string | null;
  embedding: string;
}

async function loadIndexFromDb(tenantId: string): Promise<KnowledgeIndexFile | null> {
  const db = await connectDb();
  const metaRows = await db.$queryRaw<IndexMetaRow[]>`
    select generated_at, model, source from knowledge_indexes where tenant_id = ${tenantId}
  `;
  const meta = metaRows[0];
  if (!meta) return null;
  const rows = await db.$queryRaw<ChunkRow[]>`
    select id, url, title, text, file_id, embedding::text as embedding
    from knowledge_chunks where tenant_id = ${tenantId}
  `;
  const chunks: IndexedChunk[] = rows.map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    text: r.text,
    vector: parseVectorLiteral(r.embedding),
    // file_id 為 null 代表網站來源；不設此欄以維持與 file 後端相同的物件形狀
    ...(r.file_id ? { fileId: r.file_id } : {}),
  }));
  return {
    generatedAt: meta.generated_at.toISOString(),
    model: meta.model,
    source: meta.source,
    chunks,
  };
}

/**
 * 整份取代：刪光該租戶 chunks 再分批寫入，最後 upsert 索引層級 metadata。
 * 不包 transaction——1470 列的交易會長時間持鎖，且失敗時的語意與 file 後端
 * （寫檔失敗即保留舊檔）本就不同；重跑 ingest 即可修復。
 */
async function saveIndexToDb(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  const db = await connectDb();
  await db.$executeRaw`delete from knowledge_chunks where tenant_id = ${tenantId}`;

  for (let i = 0; i < idx.chunks.length; i += CHUNK_INSERT_BATCH) {
    const batch = idx.chunks.slice(i, i + CHUNK_INSERT_BATCH);
    const values = batch.map(
      (c) => Prisma.sql`(${tenantId}, ${c.id}, ${c.url}, ${c.title}, ${c.text}, ${c.fileId ?? null},
                        ${toVectorLiteral(c.vector)}::halfvec(3072))`,
    );
    await db.$executeRaw`
      insert into knowledge_chunks (tenant_id, id, url, title, text, file_id, embedding)
      values ${Prisma.join(values)}
      on conflict (tenant_id, id) do update set
        url = excluded.url, title = excluded.title, text = excluded.text,
        file_id = excluded.file_id, embedding = excluded.embedding
    `;
  }

  await db.$executeRaw`
    insert into knowledge_indexes (tenant_id, generated_at, model, source, updated_at)
    values (${tenantId}, ${new Date(idx.generatedAt)}, ${idx.model}, ${idx.source}, now())
    on conflict (tenant_id) do update set
      generated_at = excluded.generated_at, model = excluded.model,
      source = excluded.source, updated_at = now()
  `;
}

// ---- 對外介面 ----

/** 讀取整份索引；不存在回 null */
export async function loadIndex(tenantId: string): Promise<KnowledgeIndexFile | null> {
  return env.DATA_BACKEND === 'db' ? loadIndexFromDb(tenantId) : loadIndexFromFile(tenantId);
}

/** 整份取代該租戶的索引 */
export async function saveIndex(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  if (env.DATA_BACKEND === 'db') await saveIndexToDb(tenantId, idx);
  else saveIndexToFile(tenantId, idx);
  invalidateIndexCache(tenantId);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- knowledge-index-repo-db knowledge-index-repo`
Expected: 兩支皆 PASS（db 6 個案例、file 4 個案例）

- [ ] **Step 5: 型別檢查與全測試**

Run: `npm run typecheck -w server && npm test -w server`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/knowledge.index.repo.ts \
        server/tests/knowledge-index-repo-db.test.ts
git commit -m "feat(knowledge): 索引 repository 支援 Postgres 後端"
```

---

### Task 6: pgvector 檢索器與後端切換

查詢熱路徑改由資料庫做 top-k。dense 與 lexical 兩路以一次 `union` 查詢取回（各自都算出 cosine），再於 JS 用 Task 1 的共用公式融合——保住現行「語意遠但專有名詞命中」也會被召回的行為。

**Files:**
- Create: `server/src/modules/knowledge/retriever.pgvector.ts`
- Modify: `server/src/modules/knowledge/knowledge.agent-service.ts:21,（檢索器選擇處）`
- Test: `server/tests/knowledge-retriever-pgvector.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `asciiTerms`/`lexicalHits`/`keepChunk`/`scoreOf`/`POOL_SIZE`、Task 5 的 `toVectorLiteral`
- Produces:
  - `pgvectorRetriever: KnowledgeRetriever`
  - `hasPgvectorIndex(tenantId: string): Promise<boolean>`
  - `pickRetriever(tenantId: string): Promise<KnowledgeRetriever>`（由 agent-service 使用）

- [ ] **Step 1: 先寫失敗的測試**

建立 `server/tests/knowledge-retriever-pgvector.test.ts`：

```typescript
/**
 * pgvector 檢索器：SQL 只負責取候選（dense top-k + lexical 命中），
 * 融合評分與保留條件在 JS，與 file 靜態索引共用 retriever.scoring —— 行為必須等價。
 */
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: 10 }),
  }),
}));

const queryRaw = jest.fn();
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $queryRaw: queryRaw }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

import { pgvectorRetriever } from '@/modules/knowledge/retriever.pgvector';

/** 第一次 $queryRaw 回索引 metadata（model），第二次回候選列 */
function mockQueries(candidates: Record<string, unknown>[]): void {
  queryRaw.mockReset();
  queryRaw
    .mockResolvedValueOnce([{ model: 'test' }])
    .mockResolvedValueOnce(candidates);
}

describe('pgvectorRetriever', () => {
  it('未建索引時回空陣列', async () => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce([]);
    expect(await pgvectorRetriever.search('t1', '任何問題')).toEqual([]);
  });

  it('空查詢不打資料庫', async () => {
    queryRaw.mockReset();
    expect(await pgvectorRetriever.search('t1', '   ')).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('依融合分數排序並淘汰低分無命中者', async () => {
    mockQueries([
      { id: 'A', url: 'u/a', title: 'HyCMS 網站管理平台', text: 'HyCMS 內容管理', cosine: 0.9 },
      { id: 'B', url: 'u/b', title: '無關頁', text: '無關內容', cosine: 0.1 },
      { id: 'C', url: 'u/c', title: 'HyLib 圖書自動化', text: '圖書系統', cosine: 0.5 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'HyCMS 是什麼');
    // B：cosine 0.1 < MIN_SCORE 且無命中 → 淘汰
    expect(out.map((c) => c.id)).toEqual(['A', 'C']);
    // A 命中 hycms 一次：0.9 + 0.15
    expect(out[0].score).toBeCloseTo(1.05);
  });

  it('語意遠但專有名詞命中仍保留（不可被 ANN 截掉的行為）', async () => {
    mockQueries([
      { id: 'D', url: 'u/d', title: 'SpaceMe 空間管理', text: '與問題語意不近', cosine: 0.05 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'SpaceMe 怎麼收費');
    expect(out.map((c) => c.id)).toEqual(['D']);
    expect(out[0].score).toBeCloseTo(0.2); // 0.05 + 0.15
  });

  it('候選重複時只留一筆（dense 與 lexical 兩路可能撈到同一列）', async () => {
    mockQueries([
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'HyCMS');
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-retriever-pgvector`
Expected: FAIL — `Cannot find module '@/modules/knowledge/retriever.pgvector'`

- [ ] **Step 3: 建立 retriever.pgvector.ts**

```typescript
/**
 * pgvector 檢索器：以 HNSW 索引在資料庫端取 top-k，只把候選帶回 Node。
 *
 * 與 retriever.staticIndex 的差別只在「候選從哪來」——評分、加權、保留條件
 * 全部共用 retriever.scoring，確保換後端不改變召回與排序。
 *
 * 兩路候選以一次 union 查詢取得：
 *   dense   —— order by embedding <=> $vec limit POOL_SIZE（走 HNSW 索引）
 *   lexical —— 專有名詞字面命中（走 tenant_id 索引後掃該租戶列）
 * 缺了 lexical 這路，「語意遠但精確命中產品代碼」的片段會被 ANN 直接截掉，
 * 那是靜默的檢索退化——此行為有專門的回歸測試看守。
 */
import { Prisma } from '@prisma/client';
import { getEmbeddingProvider } from '@/lib/embedding';
import { connectDb } from '@/lib/db';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { toVectorLiteral } from './knowledge.index.repo';
import { asciiTerms, keepChunk, lexicalHits, POOL_SIZE, scoreOf } from './retriever.scoring';
import type { KnowledgeChunk, KnowledgeRetriever } from './retriever.types';

/** lexical 那一路的取回上限：只為補 ANN 漏掉的精確命中，不必無限制 */
const LEXICAL_LIMIT = 50;

interface CandidateRow {
  id: string;
  url: string;
  title: string;
  text: string;
  cosine: number;
}

/** 該租戶索引所用的 embedding 模型；未建索引回 null */
async function indexModelOf(tenantId: string): Promise<string | null> {
  const db = await connectDb();
  const rows = await db.$queryRaw<{ model: string }[]>`
    select model from knowledge_indexes where tenant_id = ${tenantId}
  `;
  return rows[0]?.model ?? null;
}

/** 是否已建立可用的 pgvector 索引（供服務決定是否退回 stub） */
export async function hasPgvectorIndex(tenantId: string): Promise<boolean> {
  return (await indexModelOf(tenantId)) !== null;
}

export const pgvectorRetriever: KnowledgeRetriever = {
  name: 'pgvector',
  async search(tenantId: string, query: string): Promise<KnowledgeChunk[]> {
    const q = query.trim();
    if (!q) return [];

    // 查詢向量必須用「索引建立時的模型」，避免維度/語意不一致
    const model = await indexModelOf(tenantId);
    if (!model) return [];

    const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
    const { vectors: [queryVec], tokens } = await embedder.embed([q], model);
    usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
    if (!queryVec) return [];

    const terms = asciiTerms(q);
    const vec = toVectorLiteral(queryVec);
    const db = await connectDb();

    // lexical 沒有詞可比對時只跑 dense 那一路，省一次全租戶掃描
    const lexicalBranch = terms.length
      ? Prisma.sql`
          union
          (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
           from knowledge_chunks
           where tenant_id = ${tenantId}
             and (lower(title) like any(${terms.map((t) => `%${t}%`)}::text[])
               or lower(text)  like any(${terms.map((t) => `%${t}%`)}::text[]))
           limit ${LEXICAL_LIMIT})`
      : Prisma.empty;

    const rows = await db.$queryRaw<CandidateRow[]>`
      (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
       from knowledge_chunks
       where tenant_id = ${tenantId}
       order by embedding <=> ${vec}::halfvec(3072)
       limit ${POOL_SIZE})
      ${lexicalBranch}
    `;

    const seen = new Set<string>();
    return rows
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .map((r) => {
        const cosine = Number(r.cosine);
        const hits = terms.length ? lexicalHits(terms, `${r.title}\n${r.text}`) : 0;
        return { id: r.id, title: r.title, content: r.text, url: r.url, cosine, hits, score: scoreOf(cosine, hits) };
      })
      .filter((c) => keepChunk(c.cosine, c.hits))
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL_SIZE)
      .map(({ id, title, content, url, score }) => ({ id, title, content, url, score }));
  },
};
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- knowledge-retriever-pgvector`
Expected: PASS（5 個案例）

- [ ] **Step 5: 接上檢索器選擇**

`pickRetriever` 已存在於 `knowledge.agent-service.ts:115-117`，此步驟是改寫它，不是新增。
注意它目前在 `:155`（取候選）與 `:204`（log）**被呼叫兩次**——改 async 後必須改為呼叫一次後重用，
否則每回合會多打一次資料庫查 `knowledge_indexes`。

import（`:21-22`）改為：

```typescript
import { hasPgvectorIndex, pgvectorRetriever } from './retriever.pgvector';
import { hasStaticIndex, staticIndexRetriever } from './retriever.staticIndex';
import { stubRetriever } from './retriever.stub';
```

`:115-117` 的 `pickRetriever` 整段替換為：

```typescript
/**
 * 依持久化後端挑檢索器：db 走 pgvector、file 走靜態索引檔；
 * 兩者都沒有索引時退回 stub FAQ（dev/測試）。
 */
async function pickRetriever(tenantId: string): Promise<KnowledgeRetriever> {
  if (env.DATA_BACKEND === 'db') {
    return (await hasPgvectorIndex(tenantId)) ? pgvectorRetriever : stubRetriever;
  }
  return hasStaticIndex(tenantId) ? staticIndexRetriever : stubRetriever;
}
```

`:155` 那一行改為先取得 retriever 再檢索：

```typescript
    const retriever = await pickRetriever(session.tenantId);
    const pool = await retriever.search(session.tenantId, query);
```

`:204` 的 log 改為重用同一個實例（不要再呼叫一次 `pickRetriever`）：

```typescript
      { sessionId: session.id, hits: chunks.length, retriever: retriever.name },
```

- [ ] **Step 6: 全測試與型別檢查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: 全部 PASS。`knowledge-rag.test.ts` 在 `DATA_BACKEND=file` 下仍走 `staticIndexRetriever`，行為不變。

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/retriever.pgvector.ts \
        server/src/modules/knowledge/knowledge.agent-service.ts \
        server/tests/knowledge-retriever-pgvector.test.ts
git commit -m "feat(knowledge): 新增 pgvector 檢索器並依後端切換"
```

---

### Task 7: 既有索引一次性遷移腳本

四個租戶、1833 個 chunks 的向量都還在 `server/data/*.json`。直接搬進資料庫，免得重爬並重複支出 embedding 費用。

**Files:**
- Create: `server/scripts/knowledge-migrate-to-db.ts`
- Modify: `server/package.json`（scripts 追加一行）

**Interfaces:**
- Consumes: Task 5 的 `saveIndex`、Task 3 的 `knowledgeStore`
- Produces: `npm run migrate:knowledge -w server`（`--dry-run` 只列出不寫入）

- [ ] **Step 1: 撰寫腳本**

建立 `server/scripts/knowledge-migrate-to-db.ts`：

```typescript
/**
 * 一次性遷移：把 server/data 的知識庫 JSON 灌進 Postgres。
 *
 * 用法（需 DATA_BACKEND=db 與 DATABASE_URL）：
 *   npm run migrate:knowledge -w server -- --dry-run   # 只列出將遷移的內容
 *   npm run migrate:knowledge -w server                # 實際寫入
 *
 * 可重複執行：saveIndex 為整份取代，重跑同一份檔案結果相同。
 * 遷移的是既有向量，不會重新呼叫 embedding API（不產生費用）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '@/config/env';
import { closeDb } from '@/lib/db';
import { saveIndex } from '@/modules/knowledge/knowledge.index.repo';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import type { KnowledgeIndexMeta, KnowledgeSource } from '@/modules/knowledge/knowledge.store';

const INDEX_RE = /^knowledge-index\.(.+)\.json$/;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (env.DATA_BACKEND !== 'db') {
    console.error('需要 DATA_BACKEND=db 才能遷移；目前為', env.DATA_BACKEND);
    process.exit(1);
  }

  const dir = resolve(process.cwd(), env.KNOWLEDGE_INDEX_DIR);
  if (!existsSync(dir)) {
    console.error('找不到索引目錄：', dir);
    process.exit(1);
  }

  // 先搬設定檔（來源設定 + meta），再搬各租戶索引
  const configPath = resolve(dir, 'knowledge-config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      sources: [string, KnowledgeSource][];
      metas: [string, KnowledgeIndexMeta][];
    };
    for (const [tenantId, src] of raw.sources ?? []) {
      console.log(`[設定] ${tenantId} startUrl=${src.startUrl || '(無)'}`);
      // updatedAt 由 saveSource 重新標記；來源內容照搬
      if (!dryRun) knowledgeStore.saveSource(tenantId, src);
    }
    for (const [tenantId, meta] of raw.metas ?? []) {
      console.log(`[meta] ${tenantId} status=${meta.status} chunkCount=${meta.chunkCount}`);
      if (!dryRun) knowledgeStore.setMeta(tenantId, meta);
    }
  } else {
    console.log('（無 knowledge-config.json，略過設定遷移）');
  }

  for (const name of readdirSync(dir)) {
    const m = INDEX_RE.exec(name);
    if (!m) continue;
    const tenantId = m[1];
    const idx = JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as KnowledgeIndexFile;
    const dims = idx.chunks[0]?.vector.length ?? 0;
    console.log(`[索引] ${tenantId}: ${idx.chunks.length} chunks, ${dims} 維, model=${idx.model}`);
    if (dims && dims !== 3072) {
      console.error(`  ✗ 維度 ${dims} 與 knowledge_chunks 的 halfvec(3072) 不符，跳過`);
      continue;
    }
    if (!dryRun) {
      await saveIndex(tenantId, idx);
      console.log('  ✓ 已寫入');
    }
  }

  if (dryRun) console.log('\n--dry-run：未寫入任何資料');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
```

- [ ] **Step 2: 註冊 npm script**

`server/package.json` 的 `scripts` 追加（放在 `eval:knowledge` 之後）：

```json
    "migrate:knowledge": "tsx scripts/knowledge-migrate-to-db.ts",
```

- [ ] **Step 3: 以 dry-run 驗證讀取正確**

Run: `DATA_BACKEND=db npm run migrate:knowledge -w server -- --dry-run`
Expected: 列出 4 個租戶索引與各自 chunk 數（`8298b6cff6834b93` 應為 1470、`default` 285、另兩個各 39），全部顯示 `3072 維`，且不寫入任何資料。

- [ ] **Step 4: 實際遷移並驗證**

Run: `DATA_BACKEND=db npm run migrate:knowledge -w server`
Expected: 每個租戶印出 `✓ 已寫入`

在 Supabase 執行驗證查詢：

```sql
select tenant_id, count(*) from knowledge_chunks group by tenant_id order by 2 desc;
select tenant_id, model, generated_at from knowledge_indexes;
```

Expected: chunk 數與 dry-run 所列一致，`knowledge_indexes` 有 4 列且 `model` 皆為 `text-embedding-3-large`。

- [ ] **Step 5: 端到端抽驗檢索**

Run: `DATA_BACKEND=db npm run dev -w server`,另開終端對知識庫端點送一個已知答得出來的問題（例如針對 `8298b6cff6834b93` 租戶內容的提問）。
Expected: 回答附上來源，且 server log 顯示 retriever 為 `pgvector`。若回答變成 stub FAQ，代表 `hasPgvectorIndex` 判定失敗，需檢查 `knowledge_indexes` 是否有該租戶列。

- [ ] **Step 6: Commit**

```bash
git add server/scripts/knowledge-migrate-to-db.ts server/package.json
git commit -m "feat(knowledge): 新增既有索引遷移至 Postgres 的腳本"
```

---

### Task 8: 文件與部署說明

**Files:**
- Modify: `DEPLOY.zeabur.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: 前七個任務的成果
- Produces: 無程式介面

- [ ] **Step 1: 更新部署文件**

`DEPLOY.zeabur.md` 中提到 `DATA_BACKEND=db`「涵蓋全部 8 個 runtime store」的那一行（約 `:11`），改為涵蓋 9 個並補上知識庫說明：

```markdown
> server 支援 `DATA_BACKEND=db`（Postgres write-through，涵蓋全部 9 個 runtime store，
> 含知識庫索引——向量存於 pgvector 的 `knowledge_chunks`）。
>
> 知識庫的向量與來源設定在 `DATA_BACKEND=file` 時寫在 `server/data/*.json`。
> 容器檔案系統為 ephemeral 且該目錄不在映像檔內，**正式環境必須用 `db`**，
> 否則每次重新部署都要重爬並重新支出 embedding 費用。
> 首次切換時以 `npm run migrate:knowledge -w server` 把既有索引搬進資料庫。
```

- [ ] **Step 2: 更新架構文件**

在 `docs/ARCHITECTURE.md` 的知識庫/RAG 段落補上檢索路徑說明（若無該段落則附加於文末）：

```markdown
### 知識庫檢索後端

索引持久化由 `knowledge.index.repo.ts` 收斂，依 `env.DATA_BACKEND` 分流：

| 後端 | 索引儲存 | 檢索器 | 取候選方式 |
|---|---|---|---|
| `file` | `server/data/knowledge-index.{tenantId}.json` | `retriever.staticIndex` | 全量載入記憶體，JS 算餘弦 |
| `db` | `knowledge_chunks`（`halfvec(3072)` + HNSW） | `retriever.pgvector` | SQL `order by embedding <=> $vec limit 20` |

兩個檢索器共用 `retriever.scoring.ts` 的評分公式與保留條件，換後端不改變召回與排序。
pgvector 那路額外跑一支 lexical 分支再與 dense 候選聯集——ANN 只看語意距離，
會漏掉「語意遠但精確命中產品代碼」的片段。

`halfvec` 而非 `vector`：`text-embedding-3-large` 為 3072 維，超過 `vector` 型別
HNSW 索引的 2000 維上限，只有 `halfvec`（上限 4000 維）建得了索引。
```

- [ ] **Step 3: Commit**

```bash
git add DEPLOY.zeabur.md docs/ARCHITECTURE.md
git commit -m "docs(knowledge): 補充 pgvector 後端與遷移說明"
```

---

## 完成後的驗收

- [ ] `npm run typecheck -w server && npm test -w server` 全綠
- [ ] `DATA_BACKEND=db` 啟動 → 重啟容器 → 知識庫問答仍答得出來、admin 仍看得到來源設定與檔案清單
- [ ] `DATA_BACKEND=file` 啟動 → 既有行為完全不變（本機開發不需連 Supabase）
- [ ] Supabase `knowledge_chunks` 列數與遷移前的 JSON chunk 數一致
