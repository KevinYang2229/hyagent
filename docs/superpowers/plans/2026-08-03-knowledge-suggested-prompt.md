# 依知識庫內容生成 widget 推薦用詞 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** widget 對話開始前的知識庫推薦 chip，改由該租戶索引內容生成，取代寫死的「公司有哪些產品或服務？」。

**Architecture:** 索引異動（爬取完成／上傳檔案／刪除檔案）時抽樣索引內容、呼叫 Haiku 生成一句 zh-Hant 與一句 en 問句，快取進 `KnowledgeIndexMeta.suggestedPrompts`。widget 載入時由 `GET /api/widget/config` 一併回傳、零延遲。生成失敗或驗證未過即不寫入，前端回落現有 i18n 寫死句。抽樣與驗證為純函式、與 IO 分離。

**Tech Stack:** TypeScript、Express、Jest（server）、Vitest（client）、React（client / admin）

**Spec:** `docs/superpowers/specs/2026-08-03-knowledge-suggested-prompt-design.md`

## Global Constraints

- 生成失敗、無索引、驗證未過、未知語系一律回落 i18n 寫死句，絕不讓半殘內容顯示給訪客
- 生成為非阻塞：任何失敗都不得影響索引本身的 `status`
- 顯示數量維持 1 個，`App.tsx` 的 `slice(0, 1)` 不改
- LLM 模型固定用 `env.LLM_ROUTER_MODEL`（預設 `claude-haiku-4-5-20251001`），與 intent-router 一致
- zh-Hant 上限 20 個字元；en 上限 12 個英文單字
- server 測試跑 `npm test`（jest）於 `server/`；client 測試跑 `npm test`（vitest）於 `client/`
- eslint 允許 `_` 前綴的未使用變數（`eslint.config.js:32`）
- 註解一律繁體中文，與既有檔案風格一致

## File Structure

| 檔案 | 責任 |
| --- | --- |
| `server/src/modules/knowledge/knowledge.store.ts`（修改） | `SuggestedPrompts` 型別 + `KnowledgeIndexMeta.suggestedPrompts` 欄位。型別放這裡而非 suggest，是為了讓依賴單向（suggest → store） |
| `server/src/modules/knowledge/knowledge.suggest.ts`（新增） | 抽樣、prompt、輸出驗證、生成協調。純函式與 IO 在同檔但分離匯出 |
| `server/src/modules/knowledge/knowledge.job.ts`（修改） | 爬取完成後觸發生成 |
| `server/src/modules/knowledge/knowledge-file.service.ts`（修改） | 上傳／刪除後觸發生成 |
| `server/src/modules/widget/widget.controller.ts`（修改） | config 回應帶出 `suggestedPrompts` |
| `client/src/knowledgePrompt.ts`（新增） | 純函式：依語系與可用性挑出要顯示的 chip 文字 |
| `client/src/embedConfig.ts`（修改） | `WidgetConfig` 型別 + 解析新欄位 |
| `client/src/App.tsx`（修改） | 狀態接線，改用純函式 |
| `client/src/i18n.ts`（修改） | 註解說明這些句子現為 fallback |
| `admin/src/api.ts`（修改） | `KnowledgeMeta` 鏡像型別加欄位 |
| `admin/src/pages/tabs/KnowledgeTab.tsx`（修改） | 索引狀態卡顯示目前推薦詞 |

---

### Task 1: meta 欄位與抽樣、驗證純函式

抽樣策略與輸出驗證都是純函式，先獨立完成並測過，後續協調邏輯才有可靠地基。

**Files:**

- Create: `server/src/modules/knowledge/knowledge.suggest.ts`
- Modify: `server/src/modules/knowledge/knowledge.store.ts`（`SuggestedPrompts` 型別 + meta 欄位）
- Test: `server/tests/knowledge-suggest.test.ts`

**Interfaces:**

- Consumes: `KnowledgeIndexFile`（`server/src/modules/knowledge/knowledge-index.types.ts`，欄位 `chunks: { id, url, title, text, vector, fileId? }[]`）
- Produces:
  - 型別 `SuggestedPrompts`，由 `knowledge.store.ts` 匯出（型別屬於 meta 的形狀，放 store；Task 2 的 `knowledge.suggest.ts` 需 import `knowledgeStore` 這個值，型別若反向定義在 suggest 會形成循環依賴）
  - `KnowledgeIndexMeta.suggestedPrompts?: SuggestedPrompts`
  - `stripCommonPrefix(titles: string[]): string[]`
  - `sampleIndexForSuggestion(idx: KnowledgeIndexFile): string`
  - `parseSuggestion(text: string): SuggestedPrompts | undefined`
  - `SUGGESTION_SYSTEM_PROMPT: string`

- [ ] **Step 1: 寫失敗測試**

建立 `server/tests/knowledge-suggest.test.ts`：

```ts
/**
 * 推薦問句的抽樣與輸出驗證（純函式）。
 *
 * 抽樣策略經實測修正：原擬依 title 出現次數排序，但檔案來源的 title 是檔名（零訊號）、
 * 網站來源次數幾乎全為 1（排序等同隨機）。改為等距取文字 ＋ 剝除共同前綴後的 title 清單。
 */
import {
  parseSuggestion,
  sampleIndexForSuggestion,
  stripCommonPrefix,
} from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

function makeIndex(chunks: { title: string; text: string }[]): KnowledgeIndexFile {
  return {
    generatedAt: 't',
    model: 'm',
    source: 's',
    chunks: chunks.map((c, i) => ({ id: `c${i}`, url: `u${i}`, vector: [0], ...c })),
  };
}

describe('stripCommonPrefix', () => {
  it('剝除網站來源的站名麵包屑前綴，並丟棄剝完為空者', () => {
    // 真實資料形狀：首頁 title 就是站名本身，剝完為空——應丟棄而非放棄整批剝除
    expect(
      stripCommonPrefix(['凌網資訊 › 智慧閱讀服務', '凌網資訊 › 電子化政府', '凌網資訊']),
    ).toEqual(['智慧閱讀服務', '電子化政府']);
  });

  it('只有一個 title 時原樣返回（否則會被剝光）', () => {
    expect(stripCommonPrefix(['1784768063225.html'])).toEqual(['1784768063225.html']);
  });

  it('無共同前綴時原樣返回', () => {
    expect(stripCommonPrefix(['請假規定', '出差辦法'])).toEqual(['請假規定', '出差辦法']);
  });
});

describe('sampleIndexForSuggestion', () => {
  it('chunk 數少於取樣上限時不重複取用同一 chunk', () => {
    const out = sampleIndexForSuggestion(
      makeIndex([
        { title: 'a', text: '第一段內容' },
        { title: 'b', text: '第二段內容' },
        { title: 'c', text: '第三段內容' },
      ]),
    );
    expect(out).toContain('第一段內容');
    expect(out).toContain('第二段內容');
    expect(out).toContain('第三段內容');
    expect(out.match(/第一段內容/g)).toHaveLength(1);
  });

  it('大量 chunk 時等距取樣，涵蓋頭中尾且不超過 10 筆', () => {
    const chunks = Array.from({ length: 285 }, (_, i) => ({
      title: '1784768063225.html',
      text: `段落${i}`,
    }));
    const out = sampleIndexForSuggestion(makeIndex(chunks));
    expect(out).toContain('段落0');
    expect(out).toContain('段落252');
    expect(out.match(/段落\d+/g)?.length).toBeLessThanOrEqual(10);
  });

  it('單一 title（檔案來源）不輸出主題清單，仍從文字取得素材', () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      title: 'report.pdf',
      text: `內文${i}`,
    }));
    const out = sampleIndexForSuggestion(makeIndex(chunks));
    expect(out).not.toContain('主題清單');
    expect(out).toContain('內容摘錄');
  });

  it('索引為空時回空字串', () => {
    expect(sampleIndexForSuggestion(makeIndex([]))).toBe('');
  });

  it('輸出裁切至 2000 字元上限', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      title: `主題${i}`,
      text: 'x'.repeat(500),
    }));
    expect(sampleIndexForSuggestion(makeIndex(chunks)).length).toBeLessThanOrEqual(2000);
  });
});

describe('parseSuggestion', () => {
  it('接受合法 JSON 並 trim', () => {
    expect(parseSuggestion('{"zh-Hant":" 補助怎麼申請？ ","en":" How to apply? "}')).toEqual({
      'zh-Hant': '補助怎麼申請？',
      en: 'How to apply?',
    });
  });

  it('容忍 JSON 前後的額外文字', () => {
    expect(parseSuggestion('好的：\n{"zh-Hant":"補助怎麼申請？","en":"How to apply?"}\n')).toEqual({
      'zh-Hant': '補助怎麼申請？',
      en: 'How to apply?',
    });
  });

  it('壞 JSON 回 undefined', () => {
    expect(parseSuggestion('not json at all')).toBeUndefined();
    expect(parseSuggestion('{"zh-Hant":')).toBeUndefined();
  });

  it('缺 key 或空字串回 undefined', () => {
    expect(parseSuggestion('{"zh-Hant":"補助怎麼申請？"}')).toBeUndefined();
    expect(parseSuggestion('{"zh-Hant":"","en":"How to apply?"}')).toBeUndefined();
  });

  it('zh 超過 20 字元回 undefined', () => {
    expect(parseSuggestion(`{"zh-Hant":"${'字'.repeat(21)}","en":"ok"}`)).toBeUndefined();
  });

  it('en 超過 12 個單字回 undefined', () => {
    const long = Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ');
    expect(parseSuggestion(`{"zh-Hant":"短句","en":"${long}"}`)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/knowledge-suggest.test.ts`
Expected: FAIL，找不到模組 `@/modules/knowledge/knowledge.suggest`

- [ ] **Step 3: store 加型別與 meta 欄位**

修改 `server/src/modules/knowledge/knowledge.store.ts`，在 `KnowledgeIndexMeta` 介面之前加入型別：

```ts
/** widget 開場推薦問句；兩語系一組，缺一不可 */
export interface SuggestedPrompts {
  'zh-Hant': string;
  en: string;
}
```

並在 `KnowledgeIndexMeta` 介面的 `error` 欄位之後加入：

```ts
  /**
   * 依索引內容生成的開場推薦問句（widget 開場 chip 用）。
   * 無索引、生成失敗或驗證未過時不存在——前端據此回落 i18n 預設句。
   */
  suggestedPrompts?: SuggestedPrompts;
```

- [ ] **Step 4: 寫純函式實作**

建立 `server/src/modules/knowledge/knowledge.suggest.ts`：

```ts
/**
 * 依索引內容生成 widget 開場推薦問句。
 *
 * 生成時機為索引異動（爬取完成／上傳／刪檔），結果快取進 KnowledgeIndexMeta，
 * widget 載入時直接讀快取、零延遲。生成失敗一律不寫入，前端回落 i18n 預設句。
 *
 * 抽樣不做任何排名，只保證覆蓋度：索引來源有兩種形狀，檔案來源的 title 是檔名（零訊號）、
 * 網站來源的 title 資訊豐富但出現次數幾乎全為 1（依次數排序等同隨機），故次數不可用。
 */
import type { KnowledgeIndexFile } from './knowledge-index.types';
import type { SuggestedPrompts } from './knowledge.store';

const MAX_TEXT_SAMPLES = 10;
const TEXT_CHARS = 150;
const MAX_TITLES = 20;
const MAX_TOTAL_CHARS = 2000;
const MAX_ZH_CHARS = 20;
const MAX_EN_WORDS = 12;

/** 剝除 title 的共同前綴（網站來源的站名麵包屑）；剝完為空者丟棄 */
export function stripCommonPrefix(titles: string[]): string[] {
  // 單一 title 的共同前綴即其自身，剝除會全空；直接原樣返回
  if (titles.length < 2) return titles;

  let prefixLen = 0;
  const first = titles[0];
  outer: for (; prefixLen < first.length; prefixLen++) {
    const ch = first[prefixLen];
    for (const t of titles) {
      if (t[prefixLen] !== ch) break outer;
    }
  }
  if (prefixLen === 0) return titles;

  return titles
    // 共同前綴可能落在分隔符之前（如剝到「凌網資訊」而留下「 › 智慧閱讀」），一併清掉開頭分隔符
    .map((t) => t.slice(prefixLen).replace(/^[\s›>|/\\\-–—:：]+/, '').trim())
    .filter(Boolean);
}

/** 從索引抽出餵給 LLM 的素材：等距文字摘錄 ＋（多 title 時）主題清單 */
export function sampleIndexForSuggestion(idx: KnowledgeIndexFile): string {
  const chunks = idx.chunks;
  if (chunks.length === 0) return '';

  // 等距而非取前 N 筆：前 N 筆在長文件上只會看到封面與目錄
  const stride = Math.max(1, Math.floor(chunks.length / MAX_TEXT_SAMPLES));
  const samples: string[] = [];
  for (let i = 0; i < chunks.length && samples.length < MAX_TEXT_SAMPLES; i += stride) {
    const text = chunks[i].text.trim().slice(0, TEXT_CHARS);
    if (text) samples.push(text);
  }

  const distinct = [...new Set(chunks.map((c) => c.title).filter(Boolean))];
  const topics = distinct.length > 1 ? stripCommonPrefix(distinct).slice(0, MAX_TITLES) : [];

  const parts: string[] = [];
  if (topics.length > 0) parts.push(`主題清單：\n${topics.map((t) => `- ${t}`).join('\n')}`);
  if (samples.length > 0) parts.push(`內容摘錄：\n${samples.map((s) => `- ${s}`).join('\n')}`);
  return parts.join('\n\n').slice(0, MAX_TOTAL_CHARS);
}

export const SUGGESTION_SYSTEM_PROMPT = `你要為一個網站客服機器人產生「開場推薦問句」。
使用者訊息是該網站知識庫的主題清單與內容摘錄。請產生一句訪客最可能想問、且這份知識庫確實答得出來的問句。

規則：
- 必須是訪客會實際輸入的口語問句，不是標題或條列的改寫
- 必須具體指向這份知識庫的內容。禁止「有哪些產品或服務」「相關規定為何」這類換成任何組織都成立的泛問
- 繁體中文版 ${MAX_ZH_CHARS} 個字元以內；英文版 ${MAX_EN_WORDS} 個單字以內，兩者語意一致
- 只輸出 JSON，不要有其他文字：
{"zh-Hant":"...","en":"..."}`;

/** 驗證 LLM 輸出；任一項不合即整筆丟棄（回 undefined），呼叫端維持 fallback */
export function parseSuggestion(text: string): SuggestedPrompts | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  const zh = typeof obj['zh-Hant'] === 'string' ? obj['zh-Hant'].trim() : '';
  const en = typeof obj.en === 'string' ? obj.en.trim() : '';
  if (!zh || !en) return undefined;
  if (zh.length > MAX_ZH_CHARS) return undefined;
  if (en.split(/\s+/).length > MAX_EN_WORDS) return undefined;

  return { 'zh-Hant': zh, en };
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd server && npx jest tests/knowledge-suggest.test.ts`
Expected: PASS（全部 15 個案例）

- [ ] **Step 6: 型別與 lint**

Run: `cd server && npm run typecheck && npm run lint`
Expected: 皆無錯誤

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/knowledge.suggest.ts \
        server/src/modules/knowledge/knowledge.store.ts \
        server/tests/knowledge-suggest.test.ts
git commit -m "feat(knowledge): 推薦問句的抽樣與輸出驗證純函式"
```

---

### Task 2: 生成協調

把純函式接上 LLM 與 store。此任務結束後生成能力已完整，只是還沒有人呼叫。

**Files:**

- Modify: `server/src/modules/knowledge/knowledge.suggest.ts`（加 `refreshSuggestedPrompts`）
- Test: `server/tests/knowledge-suggest-refresh.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `sampleIndexForSuggestion`、`parseSuggestion`、`SUGGESTION_SYSTEM_PROMPT`，以及 `knowledge.store.ts` 的 `knowledgeStore`、`KnowledgeIndexMeta.suggestedPrompts`
- Produces: `refreshSuggestedPrompts(tenantId: string, idx: KnowledgeIndexFile): Promise<void>` —— 永不 reject，失敗只留 log

- [ ] **Step 1: 寫失敗測試**

建立 `server/tests/knowledge-suggest-refresh.test.ts`：

```ts
/**
 * 推薦問句生成協調：寫入 meta、失敗回落、索引清空時清除、計費歸戶。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import { usageStore } from '@/modules/usage/usage.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'a', url: 'u', title: '補助辦法', text: '申請補助需檢附身分證明', vector: [1] }],
};

const emptyIdx: KnowledgeIndexFile = { ...idx, chunks: [] };

let mockCreate: jest.Mock;

function mockLLM(text: string) {
  mockCreate = jest.fn().mockResolvedValue({
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    model: 'claude-haiku-4-5-20251001',
    keySource: 'platform',
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('生成成功時寫入 meta.suggestedPrompts', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  const tenantId = 'sug-ok';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  await refreshSuggestedPrompts(tenantId, idx);

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    'zh-Hant': '補助要附什麼文件？',
    en: 'What documents are needed?',
  });
});

it('使用 Haiku 模型（LLM_ROUTER_MODEL），不動用主模型', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  await refreshSuggestedPrompts('sug-model', idx);

  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
  );
});

it('token 計入該租戶用量', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  const tenantId = 'sug-usage';
  const before = usageStore.get(tenantId).llmTokens;

  await refreshSuggestedPrompts(tenantId, idx);

  expect(usageStore.get(tenantId).llmTokens).toBe(before + 120);
});

it('驗證未過時不寫入，維持 fallback', async () => {
  mockLLM('這不是 JSON');
  const tenantId = 'sug-badoutput';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  await refreshSuggestedPrompts(tenantId, idx);

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});

it('LLM 拋錯時不 reject、不寫入', async () => {
  mockCreate = jest.fn().mockRejectedValue(new Error('429 rate limited'));
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
  const tenantId = 'sug-throw';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  await expect(refreshSuggestedPrompts(tenantId, idx)).resolves.toBeUndefined();
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});

it('索引清空時清除舊句，且不呼叫 LLM', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  const tenantId = 'sug-empty';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    suggestedPrompts: { 'zh-Hant': '舊句', en: 'old' },
  });

  await refreshSuggestedPrompts(tenantId, emptyIdx);

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  expect(mockCreate).not.toHaveBeenCalled();
});

it('索引清空時不誤刪 meta 其他欄位', async () => {
  mockLLM('{"zh-Hant":"x","en":"y"}');
  const tenantId = 'sug-empty-keep';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    model: 'text-embedding-3-small',
    files: [{ fileId: 'F1', name: 'a.txt', chunks: 0, ingestedAt: 't' }],
    suggestedPrompts: { 'zh-Hant': '舊句', en: 'old' },
  });

  await refreshSuggestedPrompts(tenantId, emptyIdx);

  const meta = knowledgeStore.getMeta(tenantId);
  expect(meta.model).toBe('text-embedding-3-small');
  expect(meta.files).toHaveLength(1);
});

it('生成期間 meta 被其他寫入更新時不覆蓋（呼叫後重讀 meta）', async () => {
  const tenantId = 'sug-race';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockCreate = jest.fn().mockImplementation(async () => {
    // 模擬 LLM 呼叫期間有另一個寫入（如使用者刪檔）更新了 meta
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1, model: '後來寫入的' });
    return {
      text: '{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}',
      toolCalls: [],
      stopReason: 'end_turn',
      model: 'm',
      keySource: 'platform',
    };
  });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });

  await refreshSuggestedPrompts(tenantId, idx);

  const meta = knowledgeStore.getMeta(tenantId);
  expect(meta.model).toBe('後來寫入的');
  expect(meta.suggestedPrompts).toBeDefined();
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/knowledge-suggest-refresh.test.ts`
Expected: FAIL，`refreshSuggestedPrompts` 不存在

- [ ] **Step 3: 寫 refreshSuggestedPrompts**

在 `server/src/modules/knowledge/knowledge.suggest.ts` 檔案頂端補 import（`knowledgeStore` 為值匯入，
與 Task 1 已有的 `import type { SuggestedPrompts } from './knowledge.store'` 同向，無循環依賴）：

```ts
import { env } from '@/config/env';
import { getLLMProvider } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { knowledgeStore } from './knowledge.store';
```

於檔案末端加入：

```ts
/**
 * 重新生成某租戶的推薦問句並寫回 meta。
 *
 * 永不 reject：呼叫端一律以 `void refreshSuggestedPrompts(...)` 觸發，
 * 任何失敗都不得影響索引本身的狀態。
 */
export async function refreshSuggestedPrompts(
  tenantId: string,
  idx: KnowledgeIndexFile,
): Promise<void> {
  // 索引已空：清除舊句，不留下指向已刪內容的問句
  if (idx.chunks.length === 0) {
    const meta = knowledgeStore.getMeta(tenantId);
    if (meta.suggestedPrompts) {
      const { suggestedPrompts: _drop, ...rest } = meta;
      knowledgeStore.setMeta(tenantId, rest);
    }
    return;
  }

  const material = sampleIndexForSuggestion(idx);
  if (!material) return;

  try {
    const result = await getLLMProvider(
      tenantStore.getTenant(tenantId)?.llmConfig,
    ).createMessage({
      system: SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: material }] }],
      // 與 intent-router、rerank 同級的輔助任務，用 Haiku 即可；
      // 租戶鎖定自有 provider 時，provider 內的 pickModel 會自動忽略此覆寫
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 200,
    });
    usageStore.recordLLMUsage(tenantId, result);

    const prompts = parseSuggestion(result.text);
    if (!prompts) {
      logger.warn(
        { tenantId, text: result.text.slice(0, 200) },
        'suggested prompt 驗證未過，維持 fallback',
      );
      return;
    }

    // setMeta 是整包覆蓋：await 期間 meta 可能已被其他寫入更新（如使用者刪檔），必須重讀
    knowledgeStore.setMeta(tenantId, {
      ...knowledgeStore.getMeta(tenantId),
      suggestedPrompts: prompts,
    });
  } catch (err) {
    logger.warn({ err, tenantId }, 'suggested prompt 生成失敗，維持 fallback');
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/knowledge-suggest-refresh.test.ts tests/knowledge-suggest.test.ts`
Expected: PASS

- [ ] **Step 5: 型別與 lint**

Run: `cd server && npm run typecheck && npm run lint`
Expected: 皆無錯誤

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/knowledge.suggest.ts \
        server/tests/knowledge-suggest-refresh.test.ts
git commit -m "feat(knowledge): 推薦問句生成協調"
```

---

### Task 3: 三個索引異動點接線

**Files:**

- Modify: `server/src/modules/knowledge/knowledge.job.ts:99`（`setMeta` 之後）
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts:162`（上傳的 `setMeta` 之後）
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts:178`（刪檔的 `setMeta` 之後）
- Test: `server/tests/knowledge-suggest-trigger.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `refreshSuggestedPrompts(tenantId, idx)`
- Produces: 無新匯出

- [ ] **Step 1: 寫失敗測試**

建立 `server/tests/knowledge-suggest-trigger.test.ts`：

```ts
/**
 * 索引異動觸發推薦問句生成，且生成失敗不影響索引狀態。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  ...jest.requireActual('@/modules/knowledge/knowledge.suggest'),
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));

import { getJob, startIngestJob } from '@/modules/knowledge/knowledge.job';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const params = {
  tenantId: 'sug-trigger-1',
  startUrl: 'https://x.com',
  maxPages: 5,
  chunkChars: 800,
  embeddingModel: 'm',
};
const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'a', url: 'u', title: 't', text: 'x', vector: [1] }],
};

beforeEach(() => {
  (refreshSuggestedPrompts as jest.Mock).mockClear();
});

it('爬取完成後觸發生成，並帶入剛建好的索引', async () => {
  startIngestJob(params, (async () => idx) as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(refreshSuggestedPrompts).toHaveBeenCalledWith(params.tenantId, idx);
});

it('生成拋錯時 ingest 仍為 done、meta 仍為 ready', async () => {
  (refreshSuggestedPrompts as jest.Mock).mockRejectedValueOnce(new Error('boom'));
  const tenantId = 'sug-trigger-fail';

  const job = startIngestJob({ ...params, tenantId }, (async () => idx) as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(getJob(job.id)?.status).toBe('done');
  expect(knowledgeStore.getMeta(tenantId).status).toBe('ready');
});

it('爬取失敗時不觸發生成', async () => {
  const failRun = async () => {
    throw new Error('crawl failed');
  };
  startIngestJob({ ...params, tenantId: 'sug-trigger-crawlfail' }, failRun as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(refreshSuggestedPrompts).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/knowledge-suggest-trigger.test.ts`
Expected: FAIL，`refreshSuggestedPrompts` 未被呼叫

- [ ] **Step 3: 接線爬取完成點**

在 `server/src/modules/knowledge/knowledge.job.ts` 的 import 區加入：

```ts
import { refreshSuggestedPrompts } from './knowledge.suggest';
```

在 `knowledgeStore.setMeta(params.tenantId, {...})` 呼叫之後、`job.status = 'done'` 之前插入：

```ts
      // 推薦問句生成：不阻塞、不影響索引狀態。失敗時前端回落 i18n 預設句
      void refreshSuggestedPrompts(params.tenantId, idx).catch(() => {});
```

- [ ] **Step 4: 接線上傳與刪檔點**

在 `server/src/modules/knowledge/knowledge-file.service.ts` 的 import 區加入：

```ts
import { refreshSuggestedPrompts } from './knowledge.suggest';
```

上傳路徑：在 `return fileMeta;` 之前插入：

```ts
  void refreshSuggestedPrompts(tenantId, idx).catch(() => {});
```

刪檔路徑：把 `if (existing) { ... }` 區塊中 `knowledgeStore.setMeta(...)` 之後插入（`chunks` 為過濾後的陣列）：

```ts
    void refreshSuggestedPrompts(tenantId, { ...existing, chunks }).catch(() => {});
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd server && npx jest tests/knowledge-suggest-trigger.test.ts tests/knowledge-job.test.ts tests/knowledge-file.test.ts`
Expected: PASS（含既有的 job 與 file 測試未被破壞）

- [ ] **Step 6: 跑全套 server 測試**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/knowledge.job.ts \
        server/src/modules/knowledge/knowledge-file.service.ts \
        server/tests/knowledge-suggest-trigger.test.ts
git commit -m "feat(knowledge): 索引異動時觸發推薦問句生成"
```

---

### Task 4: widget config API 回傳推薦詞

**Files:**

- Modify: `server/src/modules/widget/widget.controller.ts`
- Test: `server/tests/widget-config-suggested.test.ts`

**Interfaces:**

- Consumes: `knowledgeStore.getMeta(tenantId).suggestedPrompts`
- Produces: `GET /api/widget/config` 回應 `data.suggestedPrompts?: { 'zh-Hant': string; en: string }`

- [ ] **Step 1: 寫失敗測試**

建立 `server/tests/widget-config-suggested.test.ts`：

```ts
/**
 * widget config 帶出推薦問句：有生成則回傳，無則欄位不存在（前端回落 i18n）。
 */
import type { Request, Response } from 'express';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { widgetController } from '@/modules/widget/widget.controller';
import { tenantStore } from '@/modules/tenant/tenant.store';

function callGetConfig(tenantId: string): Record<string, unknown> {
  const tenant = tenantStore.getTenant(tenantId);
  let body: Record<string, unknown> = {};
  const res = {
    status: () => res,
    json: (payload: { data: Record<string, unknown> }) => {
      body = payload.data;
      return res;
    },
  } as unknown as Response;
  void widgetController.getConfig({ tenant } as unknown as Request, res);
  return body;
}

it('meta 有 suggestedPrompts 時一併回傳', async () => {
  const t = tenantStore.createTenant('widget-suggest-on');
  knowledgeStore.setMeta(t.id, {
    status: 'ready',
    chunkCount: 3,
    suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
  });

  expect(callGetConfig(t.id).suggestedPrompts).toEqual({
    'zh-Hant': '補助怎麼申請？',
    en: 'How to apply?',
  });
});

it('meta 無 suggestedPrompts 時欄位為 undefined', async () => {
  const t = tenantStore.createTenant('widget-suggest-off');
  knowledgeStore.setMeta(t.id, { status: 'ready', chunkCount: 3 });

  expect(callGetConfig(t.id).suggestedPrompts).toBeUndefined();
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/widget-config-suggested.test.ts`
Expected: FAIL，`suggestedPrompts` 為 undefined（第一個案例）

- [ ] **Step 3: 改 controller**

`server/src/modules/widget/widget.controller.ts` 加入 import：

```ts
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
```

`getConfig` 內 `knowledgeEnabled` 之後、`res.status(200)` 之前插入：

```ts
    // 依索引內容生成的推薦問句；未生成時為 undefined，前端回落 i18n 預設句。
    // 整組語系一起回傳、不在後端挑：widget 語系可於執行期切換，後端挑定就切不動了
    const suggestedPrompts = req.tenant
      ? knowledgeStore.getMeta(req.tenant.id).suggestedPrompts
      : undefined;
```

並把回應改為：

```ts
    res.status(200).json({ data: { appearance, knowledgeEnabled, suggestedPrompts } });
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/widget-config-suggested.test.ts`
Expected: PASS

- [ ] **Step 5: 型別、lint 與全套測試**

Run: `cd server && npm run typecheck && npm run lint && npm test`
Expected: 皆無錯誤

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/widget/widget.controller.ts server/tests/widget-config-suggested.test.ts
git commit -m "feat(widget): config API 帶出知識庫推薦問句"
```

---

### Task 5: 前端顯示生成句、回落 i18n

**Files:**

- Create: `client/src/knowledgePrompt.ts`
- Create: `client/src/knowledgePrompt.test.ts`
- Modify: `client/src/embedConfig.ts:57-79`（`WidgetConfig` 與 `fetchAppearance`）
- Modify: `client/src/App.tsx:160`、`:198`、`:573`
- Modify: `client/src/i18n.ts:77`、`:269`（註解）

**Interfaces:**

- Consumes: Task 4 的 `GET /api/widget/config` 回應 `data.suggestedPrompts`
- Produces: `pickKnowledgePrompts(opts): string[]`、`SuggestedPrompts` 型別（client 端獨立定義，本專案型別不跨 app 共用，見 `admin/src/api.ts` 亦為鏡像）

- [ ] **Step 1: 寫失敗測試**

建立 `client/src/knowledgePrompt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pickKnowledgePrompts } from './knowledgePrompt';

const fallback = ['公司有哪些產品或服務？', '聯絡電話與地址在哪？', '相關規定與常見問題'];
const suggested = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

describe('pickKnowledgePrompts', () => {
  it('知識庫停用時回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: false, language: 'zh-Hant', suggested, fallback }),
    ).toEqual([]);
  });

  it('有生成句時採用該語系版本', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested, fallback }),
    ).toEqual(['補助怎麼申請？']);
  });

  it('切換語系時跟著換', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'en', suggested, fallback }),
    ).toEqual(['How to apply?']);
  });

  it('無生成句時回落 fallback', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: undefined, fallback }),
    ).toEqual(fallback);
  });

  it('未知語系（查表 miss）回落 fallback', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'ja', suggested, fallback }),
    ).toEqual(fallback);
  });

  it('生成句為空字串時回落 fallback', () => {
    expect(
      pickKnowledgePrompts({
        knowledgeEnabled: true,
        language: 'zh-Hant',
        suggested: { 'zh-Hant': '', en: 'How to apply?' },
        fallback,
      }),
    ).toEqual(fallback);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd client && npx vitest run src/knowledgePrompt.test.ts`
Expected: FAIL，找不到 `./knowledgePrompt`

- [ ] **Step 3: 寫純函式**

建立 `client/src/knowledgePrompt.ts`：

```ts
/**
 * 開場知識庫推薦 chip 的文字來源決策。
 *
 * 抽成純函式而非寫在 App.tsx：這段的分支（停用／有生成句／未知語系／回落）
 * 值得獨立測試，而 App 元件本身太肥、渲染成本高，不適合當測試入口。
 */

/** 後端依索引內容生成的推薦問句（server KnowledgeIndexMeta.suggestedPrompts 的鏡像） */
export interface SuggestedPrompts {
  'zh-Hant': string;
  en: string;
}

export function pickKnowledgePrompts(opts: {
  knowledgeEnabled: boolean;
  language: string;
  suggested?: SuggestedPrompts;
  /** i18n 的寫死句；生成句不可用時的後備 */
  fallback: string[];
}): string[] {
  if (!opts.knowledgeEnabled) return [];
  // 查表 miss（未知語系）與生成失敗走同一條路：回落 fallback
  const generated = opts.suggested?.[opts.language as keyof SuggestedPrompts];
  return generated ? [generated] : opts.fallback;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd client && npx vitest run src/knowledgePrompt.test.ts`
Expected: PASS（6 個案例）

- [ ] **Step 5: 接上 fetchAppearance**

`client/src/embedConfig.ts`：import 區加入

```ts
import type { SuggestedPrompts } from './knowledgePrompt';
```

`WidgetConfig` 介面加入欄位：

```ts
  /** 依索引內容生成的知識庫推薦問句；未生成時 undefined，由前端回落 i18n 預設句 */
  suggestedPrompts?: SuggestedPrompts;
```

`fetchAppearance` 的三個 return 點：兩個失敗分支維持 `{ appearance: {}, knowledgeEnabled: true }`（`suggestedPrompts` 自然為 undefined，即回落）；成功分支的解析與回傳改為：

```ts
    const json = (await res.json()) as {
      data?: {
        appearance?: TenantAppearance;
        knowledgeEnabled?: boolean;
        suggestedPrompts?: SuggestedPrompts;
      };
    };
    return {
      appearance: json.data?.appearance ?? {},
      knowledgeEnabled: json.data?.knowledgeEnabled ?? true,
      suggestedPrompts: json.data?.suggestedPrompts,
    };
```

- [ ] **Step 6: 接上 App.tsx**

import 區加入：

```ts
import { pickKnowledgePrompts, type SuggestedPrompts } from './knowledgePrompt';
```

在 `knowledgeEnabled` 狀態宣告（`:160`）之後加入：

```ts
  const [suggestedPrompts, setSuggestedPrompts] = useState<SuggestedPrompts | undefined>();
```

在 `fetchAppearance().then(...)` 的解構與 `setKnowledgeEnabled(ke)` 處（`:198`）改為：

```ts
    void fetchAppearance().then(({ appearance: a, knowledgeEnabled: ke, suggestedPrompts: sp }) => {
      if (cancelled) return;
      setKnowledgeEnabled(ke);
      setSuggestedPrompts(sp);
```

把 `:572-573` 兩行改為：

```ts
  const kbPromptsRaw = t('app.knowledgePrompts', { returnObjects: true });
  const knowledgePrompts = pickKnowledgePrompts({
    knowledgeEnabled,
    language: i18n.language,
    suggested: suggestedPrompts,
    fallback: Array.isArray(kbPromptsRaw) ? (kbPromptsRaw as string[]) : [],
  });
```

`:870` 的 `slice(0, 1)` 維持不動。`i18n` 已於 `App.tsx:123` 的 `const { t, i18n } = useTranslation();`
解構取出，無需額外改動。

- [ ] **Step 7: 更新 i18n 註解**

`client/src/i18n.ts:77` 的 `knowledgePrompts` 上方加註解：

```ts
    // 知識庫推薦 chip 的「後備」句：正常情況由後端依租戶索引內容生成（widget config 的
    // suggestedPrompts）。僅在未建索引、生成失敗或語系無對應時才會顯示這裡的內容。
    // 注意 App.tsx 只渲染第一句，後兩句目前不會出現。
```

`:269` 的英文版加對應的英文註解：

```ts
    // Fallback prompts for the knowledge chip; normally generated per tenant from the
    // indexed content (see suggestedPrompts in widget config). Only the first is rendered.
```

- [ ] **Step 8: 跑 client 測試、型別與建置**

Run: `cd client && npm test && npx tsc --noEmit && npm run build`
Expected: 皆通過

- [ ] **Step 9: Commit**

```bash
git add client/src/knowledgePrompt.ts client/src/knowledgePrompt.test.ts \
        client/src/embedConfig.ts client/src/App.tsx client/src/i18n.ts
git commit -m "feat(widget): 推薦 chip 改用後端生成句，i18n 降為後備"
```

---

### Task 6: admin 索引狀態卡顯示目前推薦詞

沒有這一步，管理者無從得知訪客看到什麼，生成失效也不會有人發現。

**Files:**

- Modify: `admin/src/api.ts:165-173`（`KnowledgeMeta` 鏡像型別）
- Modify: `admin/src/pages/tabs/KnowledgeTab.tsx:471-489`（card-body）

**Interfaces:**

- Consumes: `GET /api/admin/knowledge` 回應的 `meta.suggestedPrompts`（Task 2 已使該欄位存在於 `knowledgeStore.getMeta`，admin controller 直接回傳整個 meta，無需改後端）
- Produces: 無

- [ ] **Step 1: 型別加欄位**

`admin/src/api.ts` 的 `KnowledgeMeta` 介面，於 `files?` 之後加入：

```ts
  /** 依索引內容生成的 widget 開場推薦問句；未生成時不存在 */
  suggestedPrompts?: { 'zh-Hant': string; en: string };
```

- [ ] **Step 2: 卡片顯示**

`admin/src/pages/tabs/KnowledgeTab.tsx`，在 `meta.status === "ready"` 分支的 `<div className="row-sub">…</div>` 之後，改為以 fragment 包住兩行：

```tsx
            ) : meta.status === "ready" ? (
              <>
                <div className="row-sub">
                  {meta.chunkCount} 片段｜來源 {meta.source ?? "—"}｜
                  {meta.generatedAt ?? ""}
                </div>
                {meta.suggestedPrompts && (
                  <div className="row-sub">
                    開場推薦詞｜{meta.suggestedPrompts["zh-Hant"]}｜
                    {meta.suggestedPrompts.en}
                  </div>
                )}
              </>
            ) : meta.status === "failed" ? (
```

`.row-sub` 已於本次工作前加上 `overflow-wrap: anywhere`（`admin/src/index.css:457`），長句不會撐破卡片。

- [ ] **Step 3: 建置驗證**

Run: `cd admin && npm run build`
Expected: 建置成功

- [ ] **Step 4: Commit**

```bash
git add admin/src/api.ts admin/src/pages/tabs/KnowledgeTab.tsx
git commit -m "feat(admin): 索引狀態卡顯示目前的開場推薦詞"
```

---

## 人工驗收（不在自動測試範圍）

生成句的品質需人眼判斷，無法寫成自動測試。全部任務完成後，以本機既有的兩份真實索引各跑一次，
確認產出的句子像是人會問的話、且確實指向該知識庫內容：

- `server/data/knowledge-index.default.json`（285 chunks，單一檔名 title——驗證等距文字取樣夠不夠力）
- `server/data/knowledge-index.7db2f14abfe2d589.json`（39 chunks，麵包屑 title——驗證前綴剝除有效）

若產出仍是泛問，調整 `SUGGESTION_SYSTEM_PROMPT` 的禁止清單，而非放寬 `parseSuggestion` 的驗證。
