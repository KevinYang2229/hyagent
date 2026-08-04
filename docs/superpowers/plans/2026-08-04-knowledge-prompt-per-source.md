# 推薦問句依來源分兩格（網站／檔案）＋ 手動覆寫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** widget 開場推薦 chip 從「整份索引一句」改為「網站來源一句 ＋ 檔案來源一句」，並讓管理者可手動覆寫任一格。

**Architecture:** 以 `IndexedChunk.fileId` 把索引切成 website / file 兩組，各自抽樣生成一句，存進 `KnowledgeIndexMeta.suggestedPrompts` 的兩個格位；每格有 `generated`（自動）與 `manual`（手動，存在即鎖定），有效句為 `manual ?? generated`。切分、正規化、輸出挑選抽成純函式檔 `prompt-slots.ts`，與 LLM／IO 分離。widget config 改回傳陣列。

**Tech Stack:** TypeScript、Express、Zod、Jest（server）、Vitest（client）、React（client / admin）

**Spec:** `docs/superpowers/specs/2026-08-04-knowledge-prompt-per-source-design.md`

## Global Constraints

- 有效句一律為 `manual ?? generated`，逐格判斷；`manual` 有值即為鎖定，不另存旗標
- 某來源的 chunks 為 0 時該格不輸出到 widget，即使有 `manual`
- chip 順序固定：網站在前、檔案在後
- zh-Hant 上限 20 個字元；en 上限 12 個英文單字（`MAX_ZH_CHARS` / `MAX_EN_WORDS`，不放寬）
- LLM 模型固定 `env.LLM_ROUTER_MODEL`（預設 `claude-haiku-4-5-20251001`），`maxTokens: 200`
- 生成為非阻塞：任何失敗都不得影響索引本身的 `status`；索引異動端維持 `void refreshSuggestedPrompts(...).catch(() => {})`
- 世代防護維持 per-tenant：`await` 之後若世代已被超越，整批放棄寫入
- 註解一律繁體中文，與既有檔案風格一致
- server 測試：於 `server/` 跑 `npx jest <path>`；client 測試：於 `client/` 跑 `npx vitest run <path>`
- eslint 允許 `_` 前綴的未使用變數（`eslint.config.js:32`）
- 每個 task 結束前跑 `npm run typecheck`（monorepo 根目錄）

## File Structure

| 檔案 | 責任 |
| --- | --- |
| `server/src/modules/knowledge/prompt-slots.ts`（新增） | 純函式與型別：來源切分、舊資料正規化、有效句挑選。不 import store，避免循環 |
| `server/src/modules/knowledge/knowledge.store.ts`（修改） | 型別改由 prompt-slots 匯入並 re-export；meta 新增 `chunkCountBySource`；`getMeta` 讀取時正規化 |
| `server/src/modules/knowledge/knowledge.suggest.ts`（修改） | 兩格生成協調、單格重生、失敗重試 |
| `server/src/modules/knowledge/knowledge.job.ts`（修改） | 爬取完成時寫入 `chunkCountBySource` |
| `server/src/modules/knowledge/knowledge-file.service.ts`（修改） | 上傳／刪檔時寫入 `chunkCountBySource` |
| `server/src/modules/knowledge/knowledge.admin.controller.ts`（修改） | 單格重生（POST）、設定／清除手動值（PUT） |
| `server/src/modules/knowledge/knowledge.admin.schema.ts`（修改） | 兩支端點的 body schema |
| `server/src/modules/admin/admin.routes.ts`（修改） | 掛 PUT 路由、POST 加 body 驗證 |
| `server/src/modules/widget/widget.controller.ts`（修改） | `suggestedPrompts` 改輸出陣列 |
| `client/src/knowledgePrompt.ts`（修改） | 收陣列、逐筆取語系、濾空 |
| `client/src/embedConfig.ts`（修改） | `WidgetConfig` 型別改陣列 + 解析防禦 |
| `client/src/App.tsx`（修改） | 移除 `slice(0, 1)` |
| `admin/src/api.ts`（修改） | `KnowledgeMeta` 鏡像型別 + 兩支端點 client |
| `admin/src/pages/tabs/KnowledgeTab.tsx`（修改） | 索引狀態卡改兩列，含重新生成／編輯／恢復自動 |

---

### Task 1: prompt-slots 純函式

**Files:**
- Create: `server/src/modules/knowledge/prompt-slots.ts`
- Test: `server/tests/prompt-slots.test.ts`

**Interfaces:**
- Consumes: `IndexedChunk`（`./knowledge-index.types`，已存在，含選填 `fileId`）
- Produces:
  - `interface SuggestedPrompts { 'zh-Hant': string; en: string }`
  - `interface PromptSlot { generated?: SuggestedPrompts; manual?: SuggestedPrompts }`
  - `type SourceKey = 'website' | 'file'`
  - `type SuggestedPromptSlots = Partial<Record<SourceKey, PromptSlot>>`
  - `const SOURCE_KEYS: readonly SourceKey[]`
  - `splitChunksBySource<T extends { fileId?: string }>(chunks: T[]): Record<SourceKey, T[]>`
  - `normalizeSuggestedPrompts(value: unknown, opts: { hasStartUrl: boolean }): SuggestedPromptSlots | undefined`
  - `effectivePrompts(slots: SuggestedPromptSlots | undefined, counts: Record<SourceKey, number>): SuggestedPrompts[]`

- [ ] **Step 1: Write the failing test**

建立 `server/tests/prompt-slots.test.ts`：

```ts
/**
 * 推薦問句格位的純函式：來源切分、舊資料正規化、有效句挑選。
 * 不碰 store／LLM，故不需要 mock。
 */
import {
  splitChunksBySource,
  normalizeSuggestedPrompts,
  effectivePrompts,
} from '@/modules/knowledge/prompt-slots';

const web = { id: 'w1', url: 'https://x.com/a', title: 'A', text: 'a', vector: [1] };
const file = { ...web, id: 'f1', url: 'file://a.pdf', fileId: 'file-1' };

describe('splitChunksBySource', () => {
  it('有 fileId 分到 file、無 fileId 分到 website', () => {
    const out = splitChunksBySource([web, file]);
    expect(out.website.map((c) => c.id)).toEqual(['w1']);
    expect(out.file.map((c) => c.id)).toEqual(['f1']);
  });

  it('單一來源時另一組為空陣列（不是 undefined）', () => {
    expect(splitChunksBySource([web]).file).toEqual([]);
    expect(splitChunksBySource([]).website).toEqual([]);
  });
});

describe('normalizeSuggestedPrompts', () => {
  const legacy = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

  it('舊格式 + 有 startUrl → 進 website.generated', () => {
    expect(normalizeSuggestedPrompts(legacy, { hasStartUrl: true })).toEqual({
      website: { generated: legacy },
    });
  });

  it('舊格式 + 無 startUrl → 進 file.generated', () => {
    expect(normalizeSuggestedPrompts(legacy, { hasStartUrl: false })).toEqual({
      file: { generated: legacy },
    });
  });

  it('新格式原樣通過', () => {
    const slots = { website: { generated: legacy }, file: { manual: legacy } };
    expect(normalizeSuggestedPrompts(slots, { hasStartUrl: true })).toEqual(slots);
  });

  it('undefined 與空物件回 undefined', () => {
    expect(normalizeSuggestedPrompts(undefined, { hasStartUrl: true })).toBeUndefined();
    expect(normalizeSuggestedPrompts({}, { hasStartUrl: true })).toBeUndefined();
  });
});

describe('effectivePrompts', () => {
  const a = { 'zh-Hant': '網站句？', en: 'Website?' };
  const b = { 'zh-Hant': '檔案句？', en: 'File?' };
  const both = { website: 3, file: 2 };

  it('網站在前、檔案在後', () => {
    expect(effectivePrompts({ website: { generated: a }, file: { generated: b } }, both)).toEqual([a, b]);
  });

  it('manual 蓋過 generated', () => {
    expect(effectivePrompts({ website: { generated: a, manual: b } }, both)).toEqual([b]);
  });

  it('該來源 chunks 為 0 時不輸出，即使有 manual', () => {
    expect(effectivePrompts({ file: { manual: b } }, { website: 3, file: 0 })).toEqual([]);
  });

  it('沒有格位時回空陣列', () => {
    expect(effectivePrompts(undefined, both)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/prompt-slots.test.ts`
Expected: FAIL — `Cannot find module '@/modules/knowledge/prompt-slots'`

- [ ] **Step 3: Write minimal implementation**

建立 `server/src/modules/knowledge/prompt-slots.ts`：

```ts
/**
 * 推薦問句格位的型別與純函式。
 *
 * 刻意不 import knowledge.store：store 需要這裡的正規化函式（runtime import），
 * 反向再 import 會形成循環。型別定義因此放這裡，由 store re-export 供既有呼叫端沿用。
 */

/** widget 開場推薦問句；兩語系一組，空字串代表該語系不顯示 */
export interface SuggestedPrompts {
  'zh-Hant': string;
  en: string;
}

/** 單一來源的推薦問句格位；manual 有值即為鎖定，自動生成不覆蓋 */
export interface PromptSlot {
  generated?: SuggestedPrompts;
  manual?: SuggestedPrompts;
}

export type SourceKey = 'website' | 'file';

/** 顯示與處理順序固定：網站在前、檔案在後 */
export const SOURCE_KEYS: readonly SourceKey[] = ['website', 'file'];

export type SuggestedPromptSlots = Partial<Record<SourceKey, PromptSlot>>;

/** 依 chunk 有無 fileId 切分來源（檔案來源的 chunk 帶 fileId，爬網的沒有） */
export function splitChunksBySource<T extends { fileId?: string }>(
  chunks: T[],
): Record<SourceKey, T[]> {
  const out: Record<SourceKey, T[]> = { website: [], file: [] };
  for (const c of chunks) out[c.fileId ? 'file' : 'website'].push(c);
  return out;
}

/** 舊格式（單一 SuggestedPrompts）判定：有 zh-Hant 字串屬性 */
function isLegacy(value: object): value is SuggestedPrompts {
  return typeof (value as Record<string, unknown>)['zh-Hant'] === 'string';
}

/**
 * 讀取時就地正規化舊資料，不需開機遷移。
 * 舊的單句歸給哪一格：租戶有設爬取起點就算網站來源，否則算檔案來源。
 */
export function normalizeSuggestedPrompts(
  value: unknown,
  opts: { hasStartUrl: boolean },
): SuggestedPromptSlots | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (isLegacy(value)) {
    return opts.hasStartUrl ? { website: { generated: value } } : { file: { generated: value } };
  }
  const slots = value as SuggestedPromptSlots;
  return SOURCE_KEYS.some((k) => slots[k]) ? slots : undefined;
}

/**
 * 挑出要給 widget 的句子（有效句 = manual ?? generated）。
 * counts 為各來源的 chunk 數：為 0 的來源一律不輸出，避免手動句指向已刪內容。
 */
export function effectivePrompts(
  slots: SuggestedPromptSlots | undefined,
  counts: Record<SourceKey, number>,
): SuggestedPrompts[] {
  if (!slots) return [];
  const out: SuggestedPrompts[] = [];
  for (const key of SOURCE_KEYS) {
    if (counts[key] <= 0) continue;
    const prompt = slots[key]?.manual ?? slots[key]?.generated;
    if (prompt) out.push(prompt);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest tests/prompt-slots.test.ts`
Expected: PASS（13 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/prompt-slots.ts server/tests/prompt-slots.test.ts
git commit -m "feat(knowledge): 推薦問句格位的切分、正規化、挑選純函式"
```

---

### Task 2: store 型別與讀取正規化

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.store.ts`
- Test: `server/tests/knowledge-store-prompt-slots.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `normalizeSuggestedPrompts`、`SuggestedPromptSlots`
- Produces:
  - `KnowledgeIndexMeta.suggestedPrompts?: SuggestedPromptSlots`
  - `KnowledgeIndexMeta.chunkCountBySource?: Record<SourceKey, number>`
  - store 繼續 re-export `SuggestedPrompts` 型別（既有 `import type { SuggestedPrompts } from './knowledge.store'` 不需改）

- [ ] **Step 1: Write the failing test**

建立 `server/tests/knowledge-store-prompt-slots.test.ts`：

```ts
/**
 * getMeta 讀取時正規化舊格式推薦問句：既有租戶升級後不掉 chip。
 */
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';

const legacy = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

it('舊單句 + 有 startUrl → getMeta 回 website 格', () => {
  const tenantId = 'store-slots-web';
  knowledgeStore.saveSource(tenantId, {
    startUrl: 'https://x.com',
    maxPages: 10,
    chunkChars: 800,
    embeddingModel: 'm',
    rerank: false,
  });
  // 舊格式只會來自既有持久化資料，型別上已不合法，故轉型塞入
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    suggestedPrompts: legacy as never,
  });

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    website: { generated: legacy },
  });
});

it('舊單句 + 無 startUrl → getMeta 回 file 格', () => {
  const tenantId = 'store-slots-file';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    suggestedPrompts: legacy as never,
  });

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    file: { generated: legacy },
  });
});

it('新格式原樣回傳', () => {
  const tenantId = 'store-slots-new';
  const slots = { file: { manual: legacy } };
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 3, suggestedPrompts: slots });

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual(slots);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/knowledge-store-prompt-slots.test.ts`
Expected: FAIL — 第一項收到 `{ 'zh-Hant': …, en: … }` 而非 `{ website: … }`

- [ ] **Step 3: Write minimal implementation**

在 `knowledge.store.ts` 頂部 import 區加入：

```ts
import { normalizeSuggestedPrompts, type SourceKey, type SuggestedPromptSlots } from './prompt-slots';
```

刪除原本在此檔定義的 `SuggestedPrompts` interface（含其註解），改為 re-export：

```ts
export type { SuggestedPrompts, PromptSlot, SourceKey, SuggestedPromptSlots } from './prompt-slots';
```

`KnowledgeIndexMeta` 內把 `suggestedPrompts` 欄位換成：

```ts
  /**
   * 依索引內容生成的開場推薦問句，依來源分兩格（見 prompt-slots.ts）。
   * 有效句 = manual ?? generated；無內容時不存在，widget 即不顯示該顆 chip。
   */
  suggestedPrompts?: SuggestedPromptSlots;
  /**
   * 各來源的 chunk 數。widget config 是免登入端點，不該為了算數量去讀整份索引檔，
   * 故在索引寫入時一併記下。舊 meta 無此欄，讀取端需自備退路。
   */
  chunkCountBySource?: Record<SourceKey, number>;
```

`getMeta` 改為：

```ts
  /** 取得租戶的索引 meta；未建立時回預設 none 狀態。舊格式的推薦問句於此就地正規化 */
  getMeta(tenantId: string): KnowledgeIndexMeta {
    const meta = metas.get(tenantId) ?? { status: 'none', chunkCount: 0 };
    const slots = normalizeSuggestedPrompts(meta.suggestedPrompts, {
      hasStartUrl: !!sources.get(tenantId)?.startUrl,
    });
    return slots ? { ...meta, suggestedPrompts: slots } : meta;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest tests/knowledge-store-prompt-slots.test.ts tests/knowledge-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/knowledge.store.ts server/tests/knowledge-store-prompt-slots.test.ts
git commit -m "feat(knowledge): meta 推薦問句改兩格並於讀取時正規化舊資料"
```

---

### Task 3: 索引寫入點維護 chunkCountBySource

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.job.ts:92-100`
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts:155-164`（`ingestFile` 的 setMeta）
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts:174-181`（`removeFile` 的 setMeta）
- Test: `server/tests/knowledge-chunk-count-by-source.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `splitChunksBySource`
- Produces: 三個寫入點後 `meta.chunkCountBySource` 皆為 `{ website: number; file: number }`

- [ ] **Step 1: Write the failing test**

建立 `server/tests/knowledge-chunk-count-by-source.test.ts`：

```ts
/**
 * 各來源 chunk 數必須跟著索引寫入點同步更新，否則 widget 判斷 chip 要不要出現會失準。
 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({
      vectors: texts.map(() => [0.1, 0.2, 0.3]),
      tokens: texts.length * 10,
    }),
  }),
}));
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({
    name: 'mock',
    createMessage: async () => ({
      text: '{"zh-Hant":"補助要附什麼？","en":"What documents?"}',
      toolCalls: [],
      stopReason: 'end_turn',
    }),
  }),
}));

import { ingestFile, removeFile } from '@/modules/knowledge/knowledge-file.service';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';

const tenantId = 'chunk-count-tenant';

it('上傳檔案後 file 計數增加、website 為 0', async () => {
  const text = '請假規定：特休依年資計算。'.repeat(80);
  const meta = await ingestFile(tenantId, '規章.txt', Buffer.from(text));

  const counts = knowledgeStore.getMeta(tenantId).chunkCountBySource;
  expect(counts?.file).toBe(meta.chunks);
  expect(counts?.website).toBe(0);
});

it('刪除該檔後 file 計數歸零', async () => {
  const text = '出差規定：需事前簽核。'.repeat(80);
  const meta = await ingestFile(tenantId, '出差.txt', Buffer.from(text));

  removeFile(tenantId, meta.fileId);

  expect(knowledgeStore.getMeta(tenantId).chunkCountBySource?.file).toBe(
    knowledgeStore.getMeta(tenantId).chunkCount,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/knowledge-chunk-count-by-source.test.ts`
Expected: FAIL — `counts` 為 `undefined`

- [ ] **Step 3: Write minimal implementation**

`knowledge-file.service.ts` 的 import 區加入：

```ts
import { splitChunksBySource } from './prompt-slots';
```

`ingestFile` 的 `knowledgeStore.setMeta(tenantId, {...})` 內，於 `files:` 那行之後加入：

```ts
    chunkCountBySource: countBySource(idx.chunks),
```

`removeFile` 的 `knowledgeStore.setMeta(tenantId, {...})` 內，於 `files:` 那行之後加入：

```ts
      chunkCountBySource: countBySource(chunks),
```

並在 `loadIndexFile` 上方新增共用小函式：

```ts
/** 依來源計算 chunk 數，供 meta.chunkCountBySource 使用 */
function countBySource(chunks: IndexedChunk[]): { website: number; file: number } {
  const split = splitChunksBySource(chunks);
  return { website: split.website.length, file: split.file.length };
}
```

`knowledge.job.ts` 的 import 區加入：

```ts
import { splitChunksBySource } from './prompt-slots';
```

在既有的 `const { files } = knowledgeStore.getMeta(params.tenantId);` 之後加一行：

```ts
      const bySource = splitChunksBySource(idx.chunks);
```

並在該 `setMeta` 的 `source: idx.source,` 之後加入欄位：

```ts
        chunkCountBySource: { website: bySource.website.length, file: bySource.file.length },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest tests/knowledge-chunk-count-by-source.test.ts tests/knowledge-file.test.ts tests/knowledge-job.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/knowledge.job.ts server/src/modules/knowledge/knowledge-file.service.ts server/tests/knowledge-chunk-count-by-source.test.ts
git commit -m "feat(knowledge): 索引寫入點記錄各來源 chunk 數"
```

---

### Task 4: 生成改為兩格

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.suggest.ts:132-194`
- Modify: `server/tests/knowledge-suggest-refresh.test.ts`（既有斷言改為格位形狀）
- Test: `server/tests/knowledge-suggest-slots.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `splitChunksBySource`、`SOURCE_KEYS`、`SuggestedPromptSlots`、`SourceKey`
- Produces:
  - `refreshSuggestedPrompts(tenantId: string, idx: KnowledgeIndexFile): Promise<SuggestedPromptSlots | undefined>`
  - `generateOne(tenantId: string, material: string): Promise<SuggestedPrompts | undefined>`（模組內部，Task 5 會加重試）

- [ ] **Step 1: Write the failing test**

建立 `server/tests/knowledge-suggest-slots.test.ts`：

```ts
/**
 * 兩格生成：各來源各一句、manual 格跳過 LLM、來源清空只清該格。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const webChunk = { id: 'w1', url: 'https://x.com/a', title: '方案介紹', text: '智慧閱讀提供三種方案', vector: [1] };
const fileChunk = { id: 'f1', url: 'file://a.pdf', title: 'a.pdf', text: '育兒補助需檢附戶口名簿', vector: [1], fileId: 'file-1' };

const idxOf = (chunks: KnowledgeIndexFile['chunks']): KnowledgeIndexFile => ({
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks,
});

let mockCreate: jest.Mock;

function mockLLM(...texts: string[]) {
  mockCreate = jest.fn();
  for (const text of texts) {
    mockCreate.mockResolvedValueOnce({
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      keySource: 'platform',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  }
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
}

beforeEach(() => jest.clearAllMocks());

it('兩種來源都有時各生成一句，LLM 被呼叫兩次', async () => {
  const tenantId = 'slots-both';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 2 });
  mockLLM(
    '{"zh-Hant":"有哪些方案？","en":"What plans?"}',
    '{"zh-Hant":"補助要附什麼？","en":"What documents?"}',
  );

  await refreshSuggestedPrompts(tenantId, idxOf([webChunk, fileChunk]));

  expect(mockCreate).toHaveBeenCalledTimes(2);
  const slots = knowledgeStore.getMeta(tenantId).suggestedPrompts;
  expect(slots?.website?.generated).toEqual({ 'zh-Hant': '有哪些方案？', en: 'What plans?' });
  expect(slots?.file?.generated).toEqual({ 'zh-Hant': '補助要附什麼？', en: 'What documents?' });
});

it('有 manual 的格跳過 LLM，manual 不被覆蓋', async () => {
  const tenantId = 'slots-manual';
  const manual = { 'zh-Hant': '手動填的句子？', en: 'Manual one?' };
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 2,
    suggestedPrompts: { website: { manual } },
  });
  mockLLM('{"zh-Hant":"補助要附什麼？","en":"What documents?"}');

  await refreshSuggestedPrompts(tenantId, idxOf([webChunk, fileChunk]));

  expect(mockCreate).toHaveBeenCalledTimes(1); // 只有 file 格呼叫
  const slots = knowledgeStore.getMeta(tenantId).suggestedPrompts;
  expect(slots?.website?.manual).toEqual(manual);
  expect(slots?.website?.generated).toBeUndefined();
  expect(slots?.file?.generated).toEqual({ 'zh-Hant': '補助要附什麼？', en: 'What documents?' });
});

it('某來源 chunks 為 0 時清掉該格 generated，另一格不受影響', async () => {
  const tenantId = 'slots-cleared';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 1,
    suggestedPrompts: {
      website: { generated: { 'zh-Hant': '舊網站句？', en: 'Old website?' } },
      file: { generated: { 'zh-Hant': '舊檔案句？', en: 'Old file?' } },
    },
  });
  mockLLM('{"zh-Hant":"補助要附什麼？","en":"What documents?"}');

  await refreshSuggestedPrompts(tenantId, idxOf([fileChunk]));

  const slots = knowledgeStore.getMeta(tenantId).suggestedPrompts;
  expect(slots?.website).toBeUndefined();
  expect(slots?.file?.generated).toEqual({ 'zh-Hant': '補助要附什麼？', en: 'What documents?' });
});

it('索引整份清空時兩格都移除', async () => {
  const tenantId = 'slots-empty';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    suggestedPrompts: { website: { generated: { 'zh-Hant': '舊句？', en: 'Old?' } } },
  });
  mockLLM();

  await refreshSuggestedPrompts(tenantId, idxOf([]));

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  expect(mockCreate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/knowledge-suggest-slots.test.ts`
Expected: FAIL — `slots?.website?.generated` 為 undefined（目前寫入的是單一物件）

- [ ] **Step 3: Write minimal implementation**

`knowledge.suggest.ts` 的 import 區加入：

```ts
import {
  SOURCE_KEYS,
  splitChunksBySource,
  type SourceKey,
  type SuggestedPromptSlots,
} from './prompt-slots';
```

在 `refreshSuggestedPrompts` 之前新增單句生成函式：

```ts
/** 呼叫 LLM 生成一句並驗證；失敗（含驗證未過）回 undefined。不寫 store */
async function generateOne(tenantId: string, material: string): Promise<SuggestedPrompts | undefined> {
  const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
    system: SUGGESTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: material }] }],
    model: env.LLM_ROUTER_MODEL,
    maxTokens: 200,
  });
  usageStore.recordLLMUsage(tenantId, result);

  const prompts = parseSuggestion(result.text);
  if (!prompts) {
    logger.warn({ tenantId, text: result.text.slice(0, 200) }, 'suggested prompt 驗證未過，不寫入');
  }
  return prompts;
}
```

把 `refreshSuggestedPrompts` 整個函式體換成：

```ts
export async function refreshSuggestedPrompts(
  tenantId: string,
  idx: KnowledgeIndexFile,
): Promise<SuggestedPromptSlots | undefined> {
  const gen = beginGeneration(tenantId);

  try {
    const bySource = splitChunksBySource(idx.chunks);
    const current = knowledgeStore.getMeta(tenantId).suggestedPrompts ?? {};

    // 逐格決定該格的新內容；兩格併發，彼此不影響
    const entries = await Promise.all(
      SOURCE_KEYS.map(async (key: SourceKey) => {
        const slot = current[key] ?? {};
        // 手動鎖定：整格跳過，不呼叫 LLM（生成了也用不到）
        if (slot.manual) return [key, slot] as const;
        // 該來源已無內容：清掉 generated，不留指向已刪內容的句子
        const chunks = bySource[key];
        if (chunks.length === 0) return [key, {}] as const;
        const material = sampleIndexForSuggestion({ ...idx, chunks });
        // 抽樣素材為空（chunks 皆空白）：不視為錯誤，維持原樣
        if (!material) return [key, slot] as const;
        const generated = await generateOne(tenantId, material);
        return [key, generated ? { ...slot, generated } : slot] as const;
      }),
    );

    // 世代防護：await 期間若有更晚發動的呼叫（含清空）已完成，這批結果已過期
    if (!isLatestGeneration(tenantId, gen)) {
      logger.warn({ tenantId }, 'suggested prompt 生成期間已有更新的呼叫，放棄過期寫入');
      return undefined;
    }

    const next: SuggestedPromptSlots = {};
    for (const [key, slot] of entries) {
      if (slot.generated || slot.manual) next[key] = slot;
    }
    const hasAny = SOURCE_KEYS.some((k) => next[k]);
    // setMeta 是整包覆蓋：await 期間 meta 可能已被其他寫入更新（如使用者刪檔），必須重讀
    knowledgeStore.setMeta(tenantId, {
      ...knowledgeStore.getMeta(tenantId),
      suggestedPrompts: hasAny ? next : undefined,
    });
    return hasAny ? next : undefined;
  } catch (err) {
    logger.warn({ err, tenantId }, 'suggested prompt 生成失敗，不寫入');
    return undefined;
  }
}
```

同時更新檔頭註解第 4-5 行，說明生成已依來源分兩格。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest tests/knowledge-suggest-slots.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 修既有測試**

`server/tests/knowledge-suggest-refresh.test.ts` 內所有對 `meta.suggestedPrompts` 的斷言改為格位形狀。索引 `idx` 的 chunk 無 `fileId`，故一律落在 website 格：

```ts
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    website: {
      generated: { 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' },
    },
  });
```

清空索引的案例改為斷言 `toBeUndefined()`（行為不變）。

Run: `cd server && npx jest tests/knowledge-suggest-refresh.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/knowledge.suggest.ts server/tests/knowledge-suggest-slots.test.ts server/tests/knowledge-suggest-refresh.test.ts
git commit -m "feat(knowledge): 推薦問句依來源分兩格生成，手動格跳過 LLM"
```

---

### Task 5: 驗證未過時重試一次

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.suggest.ts`（`generateOne`、`parseSuggestion`）
- Test: `server/tests/knowledge-suggest-retry.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `generateOne`
- Produces: `parseSuggestion` 改回傳 `{ ok: true; prompts } | { ok: false; reason: string }`；`generateOne` 內部重試一次

- [ ] **Step 1: Write the failing test**

建立 `server/tests/knowledge-suggest-retry.test.ts`：

```ts
/**
 * 驗證未過時重試一次：改為兩格後，單次失敗的曝險加倍，值得用一次 Haiku 換。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'w1', url: 'https://x.com/a', title: '方案', text: '智慧閱讀提供三種方案', vector: [1] }],
};

let mockCreate: jest.Mock;

function mockLLM(...texts: string[]) {
  mockCreate = jest.fn();
  for (const text of texts) {
    mockCreate.mockResolvedValueOnce({
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      keySource: 'platform',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  }
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
}

beforeEach(() => jest.clearAllMocks());

it('第一次超過字數上限、第二次合格時寫入第二次的結果', async () => {
  const tenantId = 'retry-ok';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM(
    '{"zh-Hant":"請問貴公司的智慧閱讀方案總共有哪幾種可以選擇呢？","en":"What plans?"}',
    '{"zh-Hant":"有哪些方案？","en":"What plans?"}',
  );

  await refreshSuggestedPrompts(tenantId, idx);

  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.generated).toEqual({
    'zh-Hant': '有哪些方案？',
    en: 'What plans?',
  });
});

it('重試時把失敗原因帶進 user message', async () => {
  const tenantId = 'retry-reason';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM('不是 JSON', '{"zh-Hant":"有哪些方案？","en":"What plans?"}');

  await refreshSuggestedPrompts(tenantId, idx);

  const secondCall = mockCreate.mock.calls[1][0];
  const text = secondCall.messages[0].content[0].text as string;
  expect(text).toContain('不是合法 JSON');
});

it('兩次都不合格時該格不寫入', async () => {
  const tenantId = 'retry-fail';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM('不是 JSON', '還是不是 JSON');

  await refreshSuggestedPrompts(tenantId, idx);

  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/knowledge-suggest-retry.test.ts`
Expected: FAIL — `mockCreate` 只被呼叫一次

- [ ] **Step 3: Write minimal implementation**

`parseSuggestion` 改為帶原因的結果型別（既有匯出名稱保留，呼叫端同步調整）：

```ts
/** 驗證結果：不合格時帶原因，供重試時回饋給模型 */
export type ParseResult =
  | { ok: true; prompts: SuggestedPrompts }
  | { ok: false; reason: string };

/** 驗證 LLM 輸出；任一項不合即整筆丟棄並回報原因 */
export function parseSuggestion(text: string): ParseResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, reason: '不是合法 JSON，輸出必須只有一個 JSON 物件' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, reason: '不是合法 JSON，輸出必須只有一個 JSON 物件' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: '不是合法 JSON 物件' };
  }

  const obj = parsed as Record<string, unknown>;
  const zh = typeof obj['zh-Hant'] === 'string' ? obj['zh-Hant'].trim() : '';
  const en = typeof obj.en === 'string' ? obj.en.trim() : '';
  if (!zh || !en) return { ok: false, reason: 'zh-Hant 與 en 兩個欄位都必須有值' };
  if (zh.length > MAX_ZH_CHARS) {
    return { ok: false, reason: `繁體中文超過 ${MAX_ZH_CHARS} 個字元（實際 ${zh.length} 個），請縮短` };
  }
  if (en.split(/\s+/).length > MAX_EN_WORDS) {
    return { ok: false, reason: `英文超過 ${MAX_EN_WORDS} 個單字，請縮短` };
  }

  return { ok: true, prompts: { 'zh-Hant': zh, en } };
}
```

`generateOne` 改為兩次嘗試：

```ts
/**
 * 呼叫 LLM 生成一句並驗證；驗證未過時把原因回饋給模型再試一次。
 * 兩次都不過回 undefined（該格不寫入）。
 */
async function generateOne(tenantId: string, material: string): Promise<SuggestedPrompts | undefined> {
  let text = material;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
      system: SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 200,
    });
    usageStore.recordLLMUsage(tenantId, result);

    const parsed = parseSuggestion(result.text);
    if (parsed.ok) return parsed.prompts;

    logger.warn(
      { tenantId, attempt, reason: parsed.reason, text: result.text.slice(0, 200) },
      'suggested prompt 驗證未過',
    );
    if (attempt === 2) return undefined;
    text = `${material}\n\n上一次的輸出不合格：${parsed.reason}。請重新輸出。`;
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest tests/knowledge-suggest-retry.test.ts tests/knowledge-suggest.test.ts`
Expected: PASS。`knowledge-suggest.test.ts` 內既有的 `parseSuggestion` 斷言需改為新型別，例如 `expect(parseSuggestion(text)).toEqual({ ok: true, prompts: { … } })`、不合格改 `expect(parseSuggestion(text).ok).toBe(false)`

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/knowledge.suggest.ts server/tests/knowledge-suggest-retry.test.ts server/tests/knowledge-suggest.test.ts
git commit -m "feat(knowledge): 推薦問句驗證未過時帶原因重試一次"
```

---

### Task 6: widget config 輸出陣列

**Files:**
- Modify: `server/src/modules/widget/widget.controller.ts:29-41`
- Modify: `server/tests/widget-config-suggested.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `effectivePrompts`；Task 2 的 `meta.chunkCountBySource`
- Produces: `GET /api/widget/config` 的 `data.suggestedPrompts` 恆為 `SuggestedPrompts[]`（可為空陣列）

- [ ] **Step 1: Write the failing test**

改寫 `server/tests/widget-config-suggested.test.ts` 的斷言。第一項改為：

```ts
  it('兩種來源都有句子時回兩筆，網站在前', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-two');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 5,
      chunkCountBySource: { website: 3, file: 2 },
      suggestedPrompts: {
        website: { generated: { 'zh-Hant': '網站句？', en: 'Website?' } },
        file: { generated: { 'zh-Hant': '檔案句？', en: 'File?' } },
      },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([
      { 'zh-Hant': '網站句？', en: 'Website?' },
      { 'zh-Hant': '檔案句？', en: 'File?' },
    ]);
  });
```

再新增兩項：

```ts
  it('manual 蓋過 generated', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-manual');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: {
        website: {
          generated: { 'zh-Hant': '自動句？', en: 'Auto?' },
          manual: { 'zh-Hant': '手動句？', en: 'Manual?' },
        },
      },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '手動句？', en: 'Manual?' }]);
  });

  it('該來源 chunks 為 0 時不輸出該格，即使有 manual', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-zero-source');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: {
        website: { generated: { 'zh-Hant': '網站句？', en: 'Website?' } },
        file: { manual: { 'zh-Hant': '檔案手動句？', en: 'File manual?' } },
      },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '網站句？', en: 'Website?' }]);
  });
```

其餘既有案例（status 非 ready、chunkCount 0、服務關閉、未遷移租戶）的斷言由 `toBeUndefined()` 改為 `toEqual([])`。既有那幾筆 `setMeta` 的 `suggestedPrompts` 也要改成格位形狀，例如 `{ website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } }`，並補 `chunkCountBySource`。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/widget-config-suggested.test.ts`
Expected: FAIL — 收到物件或 undefined，而非陣列

- [ ] **Step 3: Write minimal implementation**

`widget.controller.ts` import 區加入：

```ts
import { effectivePrompts } from '@/modules/knowledge/prompt-slots';
```

把 `suggestedPrompts` 的計算換成：

```ts
    // 各來源的 chunk 數：舊 meta 未帶此欄時不做逐格封鎖（全域的 status/chunkCount 守門仍在），
    // 下一次索引異動就會補上正確數字
    const counts = meta?.chunkCountBySource ?? {
      website: meta?.chunkCount ?? 0,
      file: meta?.chunkCount ?? 0,
    };
    const suggestedPrompts =
      knowledgeEnabled && meta?.status === 'ready' && meta.chunkCount > 0
        ? effectivePrompts(meta.suggestedPrompts, counts)
        : [];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest tests/widget-config-suggested.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/widget/widget.controller.ts server/tests/widget-config-suggested.test.ts
git commit -m "feat(widget): config 的推薦問句改回傳陣列，逐來源守門"
```

---

### Task 7: 前端渲染兩顆 chip

**Files:**
- Modify: `client/src/knowledgePrompt.ts`
- Modify: `client/src/knowledgePrompt.test.ts`
- Modify: `client/src/embedConfig.ts:58-87`
- Modify: `client/src/App.tsx`（`pickKnowledgePrompts` 呼叫處與 chip 渲染處）

**Interfaces:**
- Consumes: Task 6 的陣列契約
- Produces: `pickKnowledgePrompts(opts: { knowledgeEnabled: boolean; language: string; suggested?: SuggestedPrompts[] }): string[]`

- [ ] **Step 1: Write the failing test**

改寫 `client/src/knowledgePrompt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pickKnowledgePrompts } from './knowledgePrompt';

const web = { 'zh-Hant': '網站句？', en: 'Website?' };
const file = { 'zh-Hant': '檔案句？', en: 'File?' };

describe('pickKnowledgePrompts', () => {
  it('知識庫停用時回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: false, language: 'zh-Hant', suggested: [web] }),
    ).toEqual([]);
  });

  it('兩筆都有該語系時依序回兩筆', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: [web, file] }),
    ).toEqual(['網站句？', '檔案句？']);
  });

  it('切換語系時跟著換', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'en', suggested: [web, file] }),
    ).toEqual(['Website?', 'File?']);
  });

  it('某筆該語系為空字串時只回另一筆（手動填寫可留空英文）', () => {
    expect(
      pickKnowledgePrompts({
        knowledgeEnabled: true,
        language: 'en',
        suggested: [web, { 'zh-Hant': '檔案句？', en: '' }],
      }),
    ).toEqual(['Website?']);
  });

  it('未知語系回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'ja', suggested: [web, file] }),
    ).toEqual([]);
  });

  it('無生成句（未建索引）時回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: undefined }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/knowledgePrompt.test.ts`
Expected: FAIL — 目前簽章收單一物件，傳陣列會回 `[]` 或型別錯誤

- [ ] **Step 3: Write minimal implementation**

`client/src/knowledgePrompt.ts` 的函式改為：

```ts
export function pickKnowledgePrompts(opts: {
  knowledgeEnabled: boolean;
  language: string;
  /** 後端依各來源索引生成的問句（網站在前、檔案在後），最多兩筆 */
  suggested?: SuggestedPrompts[];
}): string[] {
  if (!opts.knowledgeEnabled || !opts.suggested) return [];
  // 查表 miss（未知語系）與手動留空的語系一併濾掉
  return opts.suggested
    .map((s) => s[opts.language as keyof SuggestedPrompts])
    .filter((text): text is string => !!text);
}
```

`client/src/embedConfig.ts`：`WidgetConfig.suggestedPrompts` 型別改 `SuggestedPrompts[]`，註解改為「依各來源索引生成的推薦問句；未生成時為空陣列」。三處失敗退路 `return { appearance: {}, knowledgeEnabled: true }` 不需改（欄位留 undefined 即可）。解析處加防禦：

```ts
      suggestedPrompts: Array.isArray(json.data?.suggestedPrompts)
        ? json.data.suggestedPrompts
        : undefined,
```

並把 `json.data` 的型別註記從 `suggestedPrompts?: SuggestedPrompts` 改為 `suggestedPrompts?: SuggestedPrompts[]`。

`client/src/App.tsx`：`useState<SuggestedPrompts | undefined>()` 改為 `useState<SuggestedPrompts[] | undefined>()`；chip 渲染處把 `{knowledgePrompts.slice(0, 1).map((p) => (` 改為 `{knowledgePrompts.map((p) => (`，並把上方註解改為「知識庫推薦用詞：網站來源與檔案來源各一顆」。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run` 然後 `npm run typecheck -w client`（於 repo 根目錄）
Expected: 全數 PASS、typecheck 無錯

- [ ] **Step 5: Commit**

```bash
git add client/src/knowledgePrompt.ts client/src/knowledgePrompt.test.ts client/src/embedConfig.ts client/src/App.tsx
git commit -m "feat(widget): 推薦 chip 支援網站與檔案各一顆"
```

---

### Task 8: admin 端點（單格重生 / 手動值）

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.admin.schema.ts`
- Modify: `server/src/modules/knowledge/knowledge.admin.controller.ts`（`refreshSuggestion` 改寫、新增 `setSuggestionManual`）
- Modify: `server/src/modules/admin/admin.routes.ts`
- Modify: `server/tests/knowledge-suggest-admin.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `splitChunksBySource`、`SourceKey`；Task 4 的 `generateOne` 路徑
- Produces:
  - `knowledge.suggest.ts` 匯出 `regenerateSlot(tenantId: string, source: SourceKey, idx: KnowledgeIndexFile): Promise<SuggestedPrompts | undefined>`
  - `POST /admin/tenants/:id/knowledge/suggestion` body `{ source }` → `{ data: { source, slot } }`
  - `PUT /admin/tenants/:id/knowledge/suggestion` body `{ source, manual }` → `{ data: { source, slot } }`

- [ ] **Step 1: Write the failing test**

改寫 `server/tests/knowledge-suggest-admin.test.ts`：既有四項的 POST 都補上 `.send({ source: 'website' })`，索引以 `writeIndex(tenantId, [chunk])`（chunk 無 `fileId`，屬網站來源）。新增：

```ts
  it('指定 file 來源但索引只有網站 chunks → 422', async () => {
    const tenantId = 'sug-admin-wrong-source';
    writeIndex(tenantId, [chunk]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
    mockLLM('{"zh-Hant":"不該被呼叫","en":"should not be called"}');

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'file' })
      .expect(422);
  });

  it('PUT 設定手動值後 slot.manual 生效', async () => {
    const tenantId = 'sug-admin-manual';
    writeIndex(tenantId, [chunk]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    const res = await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website', manual: { 'zh-Hant': '手動句？', en: '' } })
      .expect(200);

    expect(res.body.data.slot.manual).toEqual({ 'zh-Hant': '手動句？', en: '' });
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.manual).toEqual({
      'zh-Hant': '手動句？',
      en: '',
    });
  });

  it('PUT manual: null 清除手動值，generated 保留', async () => {
    const tenantId = 'sug-admin-manual-clear';
    const generated = { 'zh-Hant': '自動句？', en: 'Auto?' };
    writeIndex(tenantId, [chunk]);
    knowledgeStore.setMeta(tenantId, {
      status: 'ready',
      chunkCount: 1,
      suggestedPrompts: { website: { generated, manual: { 'zh-Hant': '手動句？', en: '' } } },
    });

    const res = await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website', manual: null })
      .expect(200);

    expect(res.body.data.slot.manual).toBeUndefined();
    expect(res.body.data.slot.generated).toEqual(generated);
  });

  it('PUT 的 zh-Hant 為空字串 → 400', async () => {
    const tenantId = 'sug-admin-manual-empty';
    writeIndex(tenantId, [chunk]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website', manual: { 'zh-Hant': '  ', en: '' } })
      .expect(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/knowledge-suggest-admin.test.ts`
Expected: FAIL — PUT 路由不存在（404）

- [ ] **Step 3: Write minimal implementation**

`knowledge.admin.schema.ts` 末尾加入：

```ts
/** 單格推薦問句的來源（POST 重新生成 / PUT 設定手動值共用） */
const promptSourceSchema = z.enum(['website', 'file']);

/** 重新生成單格（POST /knowledge/suggestion 的 body） */
export const suggestionRefreshSchema = z.object({ source: promptSourceSchema });

/** 設定／清除手動值（PUT /knowledge/suggestion 的 body）；manual 為 null 代表恢復自動 */
export const suggestionManualSchema = z.object({
  source: promptSourceSchema,
  manual: z
    .object({
      'zh-Hant': z.string().trim().min(1),
      en: z.string().trim(),
    })
    .nullable(),
});
```

`knowledge.suggest.ts` 新增匯出（放在 `refreshSuggestedPrompts` 之後）：

```ts
/**
 * 只重新生成指定來源那一格（後台按鈕用）。
 *
 * 與 refreshSuggestedPrompts 的差別：不理會 manual 鎖定——按鈕的語意是「重生自動句」，
 * 手動值仍蓋在它上面，直到管理者按恢復自動。該來源無內容時回 undefined 由呼叫端擋。
 */
export async function regenerateSlot(
  tenantId: string,
  source: SourceKey,
  idx: KnowledgeIndexFile,
): Promise<SuggestedPrompts | undefined> {
  const gen = beginGeneration(tenantId);
  try {
    const chunks = splitChunksBySource(idx.chunks)[source];
    if (chunks.length === 0) return undefined;
    const material = sampleIndexForSuggestion({ ...idx, chunks });
    if (!material) return undefined;

    const generated = await generateOne(tenantId, material);
    if (!generated) return undefined;
    if (!isLatestGeneration(tenantId, gen)) {
      logger.warn({ tenantId }, 'suggested prompt 單格重生期間已有更新的呼叫，放棄過期寫入');
      return undefined;
    }

    const meta = knowledgeStore.getMeta(tenantId);
    const slots = { ...(meta.suggestedPrompts ?? {}) };
    slots[source] = { ...(slots[source] ?? {}), generated };
    knowledgeStore.setMeta(tenantId, { ...meta, suggestedPrompts: slots });
    return generated;
  } catch (err) {
    logger.warn({ err, tenantId, source }, 'suggested prompt 單格重生失敗');
    return undefined;
  }
}
```

`knowledge.admin.controller.ts` import 區補上：

```ts
import { splitChunksBySource, type SourceKey } from './prompt-slots';
import { regenerateSlot } from './knowledge.suggest';
```

（移除原本的 `refreshSuggestedPrompts` import。）把既有 `refreshSuggestion` 換成：

```ts
  /**
   * 手動重新生成指定來源的開場推薦詞。
   *
   * 平時由索引異動自動觸發，這是補救入口：索引建立於本功能上線前、或當時生成失敗的租戶。
   * 這裡 await 而非 void 觸發——管理者按了按鈕就要看到結果。
   */
  async refreshSuggestion(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { source } = req.body as { source: SourceKey };
    // 比照上傳／刪檔：爬網進行中不要另外發動生成，兩邊的世代競爭沒有意義
    if (getRunningJobForTenant(tenantId)) {
      throw AppError.conflict('解析任務進行中，請待完成後再重新生成');
    }
    const idx = loadIndexFile(tenantId);
    if (!idx || splitChunksBySource(idx.chunks)[source].length === 0) {
      throw AppError.unprocessable('該來源尚無索引內容');
    }

    const generated = await regenerateSlot(tenantId, source, idx);
    // 失敗時 meta 會留著舊句，不能改讀 meta 充數；一律據實回報讓管理者可以重試
    if (!generated) throw AppError.unprocessable('推薦詞生成失敗，請稍後再試');
    res.json({ data: { source, slot: knowledgeStore.getMeta(tenantId).suggestedPrompts?.[source] } });
  },

  /** 設定或清除某格的手動推薦詞；manual 為 null 代表恢復自動 */
  async setSuggestionManual(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { source, manual } = req.body as {
      source: SourceKey;
      manual: { 'zh-Hant': string; en: string } | null;
    };
    const meta = knowledgeStore.getMeta(tenantId);
    const slots = { ...(meta.suggestedPrompts ?? {}) };
    const slot = { ...(slots[source] ?? {}) };
    if (manual) slot.manual = manual;
    else delete slot.manual;
    // 兩者皆空的格位不留下來，避免 meta 累積空物件
    if (slot.generated || slot.manual) slots[source] = slot;
    else delete slots[source];
    knowledgeStore.setMeta(tenantId, { ...meta, suggestedPrompts: slots });
    res.json({ data: { source, slot: slots[source] } });
  },
```

`admin.routes.ts`：import 區的 schema 清單加入 `suggestionRefreshSchema, suggestionManualSchema`，並把既有 POST 路由改為帶 body 驗證、其後加上 PUT：

```ts
router.post(
  '/tenants/:id/knowledge/suggestion',
  validate({ params: tenantParamSchema, body: suggestionRefreshSchema }),
  asyncHandler(knowledgeAdminController.refreshSuggestion),
);
router.put(
  '/tenants/:id/knowledge/suggestion',
  validate({ params: tenantParamSchema, body: suggestionManualSchema }),
  asyncHandler(knowledgeAdminController.setSuggestionManual),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/knowledge/knowledge.admin.schema.ts server/src/modules/knowledge/knowledge.admin.controller.ts server/src/modules/knowledge/knowledge.suggest.ts server/src/modules/admin/admin.routes.ts server/tests/knowledge-suggest-admin.test.ts
git commit -m "feat(admin): 推薦詞可單格重生與手動覆寫"
```

---

### Task 9: 後台索引狀態卡兩列 UI

**Files:**
- Modify: `admin/src/api.ts`（`KnowledgeMeta` 鏡像型別 + 兩支 client）
- Modify: `admin/src/pages/tabs/KnowledgeTab.tsx`

**Interfaces:**
- Consumes: Task 8 的兩支端點
- Produces: 無下游

- [ ] **Step 1: 更新 admin api client**

`admin/src/api.ts` 的 `KnowledgeMeta` 型別中，`suggestedPrompts` 改為：

```ts
  suggestedPrompts?: Partial<Record<PromptSource, PromptSlotView>>;
  chunkCountBySource?: Record<PromptSource, number>;
```

並在該型別上方新增：

```ts
export type PromptSource = 'website' | 'file';
export interface SuggestedPromptText {
  'zh-Hant': string;
  en: string;
}
export interface PromptSlotView {
  generated?: SuggestedPromptText;
  manual?: SuggestedPromptText;
}
```

把既有的 `refreshKnowledgeSuggestion` 換成：

```ts
  /** 重新生成某來源的開場推薦詞（平時由索引異動自動觸發，這是補救入口） */
  refreshKnowledgeSuggestion: (id: string, source: PromptSource) =>
    req<{ source: PromptSource; slot: PromptSlotView }>(
      'POST',
      `/admin/tenants/${id}/knowledge/suggestion`,
      { source },
    ),
  /** 設定或清除某來源的手動推薦詞；manual 傳 null 代表恢復自動 */
  setKnowledgeSuggestionManual: (id: string, source: PromptSource, manual: SuggestedPromptText | null) =>
    req<{ source: PromptSource; slot: PromptSlotView }>(
      'PUT',
      `/admin/tenants/${id}/knowledge/suggestion`,
      { source, manual },
    ),
```

- [ ] **Step 2: 改索引狀態卡為兩列**

`KnowledgeTab.tsx`：把 Task「開場推薦詞」那一段（單列 + 重新生成按鈕）換成兩列。先在元件狀態區加入：

```ts
  // 手動編輯中的來源與草稿（null = 沒有在編輯）
  const [editingSource, setEditingSource] = useState<PromptSource | null>(null);
  const [manualDraft, setManualDraft] = useState<SuggestedPromptText>({ 'zh-Hant': '', en: '' });
  const [savingManual, setSavingManual] = useState(false);
```

把既有的 `regenerateSuggestion` 改為吃來源，並新增兩個處理函式：

```ts
  const regenerateSuggestion = async (source: PromptSource) => {
    setRegenerating(source);
    try {
      const { slot } = await api.refreshKnowledgeSuggestion(tenantId, source);
      setMeta((m) => (m ? { ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } } : m));
      toast.success("已重新生成開場推薦詞");
    } catch (e) {
      onError(e);
    } finally {
      setRegenerating(null);
    }
  };

  const saveManual = async (source: PromptSource) => {
    setSavingManual(true);
    try {
      const { slot } = await api.setKnowledgeSuggestionManual(tenantId, source, manualDraft);
      setMeta((m) => (m ? { ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } } : m));
      setEditingSource(null);
      toast.success("已儲存手動推薦詞");
    } catch (e) {
      onError(e);
    } finally {
      setSavingManual(false);
    }
  };

  const clearManual = async (source: PromptSource) => {
    try {
      const { slot } = await api.setKnowledgeSuggestionManual(tenantId, source, null);
      setMeta((m) => (m ? { ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } } : m));
      toast.success("已恢復自動生成");
    } catch (e) {
      onError(e);
    }
  };
```

（`regenerating` 的型別由 `boolean` 改為 `PromptSource | null`。）

卡片內容換成：

```tsx
                {/* 開場推薦詞：widget 的推薦 chip 依來源各一顆，未生成就不會有 chip */}
                {(["website", "file"] as const).map((source) => {
                  const slot = meta.suggestedPrompts?.[source];
                  const effective = slot?.manual ?? slot?.generated;
                  const count = meta.chunkCountBySource?.[source] ?? 0;
                  return (
                    <div className="row-sub" key={source}>
                      {source === "website" ? "網站來源" : "檔案來源"}｜
                      {effective
                        ? `${effective["zh-Hant"]}｜${effective.en || "（英文未填）"}`
                        : "尚未生成，widget 不會顯示這顆 chip"}
                      {slot?.manual ? "（手動）" : "（自動）"}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => regenerateSuggestion(source)}
                        disabled={regenerating !== null || count === 0}
                        style={{ marginInlineStart: 8 }}
                      >
                        {regenerating === source ? "生成中…" : "重新生成"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingSource(source);
                          setManualDraft(slot?.manual ?? { "zh-Hant": "", en: "" });
                        }}
                        style={{ marginInlineStart: 4 }}
                      >
                        編輯
                      </button>
                      {slot?.manual && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => clearManual(source)}
                          style={{ marginInlineStart: 4 }}
                        >
                          恢復自動
                        </button>
                      )}
                      {editingSource === source && (
                        <div className="form-grid" style={{ marginBlockStart: 8 }}>
                          <div className="field">
                            <label className="field-label">繁體中文（必填，20 字以內）</label>
                            <input
                              className="input"
                              value={manualDraft["zh-Hant"]}
                              onChange={(e) =>
                                setManualDraft((d) => ({ ...d, "zh-Hant": e.target.value }))
                              }
                            />
                          </div>
                          <div className="field">
                            <label className="field-label">英文（選填，留空則英文介面不顯示）</label>
                            <input
                              className="input"
                              value={manualDraft.en}
                              onChange={(e) => setManualDraft((d) => ({ ...d, en: e.target.value }))}
                            />
                          </div>
                          <div className="field">
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => saveManual(source)}
                              disabled={savingManual || !manualDraft["zh-Hant"].trim()}
                            >
                              儲存
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setEditingSource(null)}
                              style={{ marginInlineStart: 4 }}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
```

- [ ] **Step 3: 驗證**

Run（於 repo 根目錄）：`npm run typecheck -w admin && npx eslint admin/src`
Expected: typecheck 無錯、eslint 除既有 `auth.tsx` 的 `react-refresh` warning 外無新增問題

- [ ] **Step 4: 全域驗證**

Run（於 repo 根目錄）：

```bash
npm run typecheck
cd server && npx jest
cd ../client && npx vitest run
cd ../admin && npx vitest run
```

Expected: 全部通過

- [ ] **Step 5: Commit**

```bash
git add admin/src/api.ts admin/src/pages/tabs/KnowledgeTab.tsx
git commit -m "feat(admin): 索引狀態卡分來源顯示推薦詞並可手動覆寫"
```

---

## 收尾檢查

- [ ] `client/dist` 是 gitignore 的建置產物且已過期，部署前要重跑 `npm run build -w client`，否則 widget 仍是舊 bundle
- [ ] 部署後到後台知識庫分頁，對既有租戶各按一次「重新生成」，補上檔案來源那一格
