# 知識庫檢索彙整成報告（Report Skill）— Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者在對話中說「幫我整理一份 ○○ 的報告」，系統以 LLM 拆大綱、逐節打知識庫檢索、彙整成一份可下載的 Markdown / HTML 報告。

**Architecture:** 新模組 `server/src/modules/report/`，與 `knowledge` 平行，單向依賴 knowledge 的檢索出口（`pickRetriever` / `rerankChunks`）。報告以非同步 job 執行、前端輪詢；產出物經 renderer 登錄表渲染成多種格式，存入 `report.store`（記憶體 + db write-through），由 `/api/reports` 下載。

**Tech Stack:** TypeScript / Express / Prisma（新表 `report_docs`）/ Jest / 既有 LLM 抽象層 `@/lib/llm/types`。

## Global Constraints

- 註解與 commit message 一律繁體中文，沿用 repo 現行風格。
- 報告內容**只能來自 RAG 檢索結果**，不得引入知識庫以外的任何來源。
- 所有「要拿知識庫檢索結果」的呼叫一律走 `pickRetriever(tenantId)`，不得直接 import 任何具體 retriever（見 `retriever.pick.ts` 檔頭：繞過它在 db 模式下不噴錯，只會靜默回 0 命中）。
- 整份索引永不進 LLM；每節只把 top-k 片段交給 LLM。
- 每一次 LLM 呼叫都必須 `usageStore.recordLLMUsage(tenantId, result)`，否則成本不會進既有用量統計。
- 測試一律不打真資料庫、不打真 LLM、不打真 OpenAI embedding。`tests/setup-env.ts` 固定 `DATA_BACKEND=file`；db 路徑以假 Prisma client 驗證。
- DDL 以 `server/db/migrations/` 的 SQL 檔管理並經 Supabase 套用，`server/prisma/schema.prisma` 僅作型別來源，兩邊必須同步。新表一律 `enable row level security`（沿用 `0004_attachments.sql` 慣例）。
- 語系一律經 `normalizeLocale(locale)`（`@/lib/locale`），只有 `'en'` 與 `'zh-TW'` 兩種；中英文各一套 prompt 與固定語句。
- 前端不得寫死格式清單 `['md','html']`，一律用後端回傳的 `formats`。
- 測試檔放 `server/tests/report-*.test.ts`，執行 `npm test -w server -- <pattern>`。

---

### Task 1: 型別、Markdown renderer 與格式登錄表

建立報告的資料模型與第一個 renderer。此任務不碰檢索、不碰 LLM——純資料轉字串，可完全獨立測試。

**Files:**
- Create: `server/src/modules/report/report.types.ts`
- Create: `server/src/modules/report/report.strings.ts`
- Create: `server/src/modules/report/renderers/markdown.ts`
- Create: `server/src/modules/report/report.render.ts`
- Test: `server/tests/report-render.test.ts`

**Interfaces:**
- Consumes: 無（第一個任務）
- Produces:
  - `OutlineSection { heading: string; query: string }`
  - `Outline { title: string; sections: OutlineSection[] }`
  - `SectionSource { title: string; url?: string }`
  - `ReportSection { heading: string; query: string; body: string; sources: SectionSource[]; hits: number; degraded?: boolean }`
  - `ReportDoc { title: string; topic: string; locale: string; generatedAt: string; sections: ReportSection[] }`
  - `ReportJob`（狀態機型別，Task 6 使用）
  - `ReportRenderer { format: string; contentType: string; render(doc: ReportDoc): Buffer | Promise<Buffer> }`
  - `renderers: Record<string, ReportRenderer>`、`REPORT_FORMATS: string[]`、`isReportFormat(f: string): boolean`
  - `markdownRenderer: ReportRenderer`
  - `report.strings.ts`：`emptySectionText(locale)`、`degradedNoticeText(locale)`、`sourcesHeading(locale)`、`dedupeSources(sections)`（各格式共用，不歸屬任何單一 renderer）

- [ ] **Step 1: 寫失敗的測試**

建立 `server/tests/report-render.test.ts`：

```ts
/**
 * 報告渲染：Markdown 產出的節結構、來源清單去重、degraded 標註、查無資料節保留標題。
 */
import type { ReportDoc } from '@/modules/report/report.types';
import { renderers } from '@/modules/report/report.render';

function makeDoc(partial: Partial<ReportDoc> = {}): ReportDoc {
  return {
    title: '馬太鞍溪災害補助報告',
    topic: '馬太鞍溪災害補助',
    locale: 'zh-TW',
    generatedAt: '2026-08-11T00:00:00.000Z',
    sections: [
      {
        heading: '申請資格',
        query: '誰可以申請馬太鞍溪災害補助？',
        body: '設籍於受災區域之住戶。（來源：補助申請須知）',
        sources: [{ title: '補助申請須知', url: 'https://example.gov.tw/a' }],
        hits: 3,
      },
    ],
    ...partial,
  };
}

async function renderMd(doc: ReportDoc): Promise<string> {
  return (await renderers.md.render(doc)).toString('utf8');
}

describe('markdown renderer', () => {
  it('輸出標題、主題與各節標題內文', async () => {
    const out = await renderMd(makeDoc());
    expect(out).toContain('# 馬太鞍溪災害補助報告');
    expect(out).toContain('## 申請資格');
    expect(out).toContain('設籍於受災區域之住戶。');
  });

  it('查無資料的節保留標題，內文為固定語句', async () => {
    const doc = makeDoc({
      sections: [
        { heading: '補助金額', query: '補助金額多少？', body: '', sources: [], hits: 0 },
      ],
    });
    const out = await renderMd(doc);
    expect(out).toContain('## 補助金額');
    expect(out).toContain('知識庫查無相關資料。');
  });

  it('降級的節加註說明，讓讀者知道該節品質不同', async () => {
    const doc = makeDoc({
      sections: [
        {
          heading: '申請期限',
          query: '申請期限到什麼時候？',
          body: '・須知：即日起至 12/31',
          sources: [{ title: '須知' }],
          hits: 2,
          degraded: true,
        },
      ],
    });
    const out = await renderMd(doc);
    expect(out).toContain('本節彙整未完成，以下為檢索到的原始片段');
  });

  it('報告尾端彙整來源清單並去重，有 url 者輸出連結', async () => {
    const doc = makeDoc({
      sections: [
        {
          heading: 'A',
          query: 'a?',
          body: 'a',
          sources: [
            { title: '須知', url: 'https://example.gov.tw/a' },
            { title: '須知', url: 'https://example.gov.tw/a' },
          ],
          hits: 1,
        },
        {
          heading: 'B',
          query: 'b?',
          body: 'b',
          sources: [{ title: '公告' }],
          hits: 1,
        },
      ],
    });
    const out = await renderMd(doc);
    expect(out).toContain('## 來源');
    expect(out.match(/example\.gov\.tw\/a/g)).toHaveLength(1);
    expect(out).toContain('- [須知](https://example.gov.tw/a)');
    expect(out).toContain('- 公告');
  });

  it('英文報告用英文固定語句', async () => {
    const doc = makeDoc({
      locale: 'en',
      sections: [{ heading: 'Amount', query: 'How much?', body: '', sources: [], hits: 0 }],
    });
    const out = await renderMd(doc);
    expect(out).toContain('No relevant information found in the knowledge base.');
    expect(out).toContain('## Sources');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-render`
Expected: FAIL，找不到模組 `@/modules/report/report.types`。

- [ ] **Step 3: 建立型別**

`server/src/modules/report/report.types.ts`：

```ts
/**
 * 報告模組的資料模型。
 *
 * ReportDoc 刻意與輸出格式無關：renderer 只做「結構化資料 → bytes」，
 * 新增格式不必回頭改彙整流程。
 */

/** 大綱中的一節：標題 + 用來檢索該節材料的查詢句 */
export interface OutlineSection {
  heading: string;
  /** 必須是可獨立檢索的完整問句，不是標題的複製 */
  query: string;
}

export interface Outline {
  title: string;
  sections: OutlineSection[];
}

/** 一節的來源引用 */
export interface SectionSource {
  title: string;
  url?: string;
}

/** 彙整完成的一節 */
export interface ReportSection {
  heading: string;
  query: string;
  /** 彙整後內文；hits=0 時為空字串，固定語句由 renderer 補（各格式語系一致） */
  body: string;
  sources: SectionSource[];
  /** 檢索命中數，0 代表該節查無資料 */
  hits: number;
  /** 該節彙整 LLM 失敗、已降級為片段列表；renderer 必須標註出來 */
  degraded?: boolean;
}

export interface ReportDoc {
  title: string;
  /** 使用者原始主題，保留於報告表頭供讀者對照 */
  topic: string;
  locale: string;
  generatedAt: string;
  sections: ReportSection[];
}

/**
 * job 狀態。empty 獨立於 done 與 failed：流程全跑完、沒出錯，但所有節都零命中。
 * 併進 done 會給一個空報告的下載連結，併進 failed 則謊稱系統故障——
 * 兩者都讓使用者分不清「知識庫沒資料」還是「系統壞了」。
 */
export type ReportStatus =
  | 'queued'
  | 'outlining'
  | 'composing'
  | 'done'
  | 'empty'
  | 'failed';

export interface ReportJob {
  id: string;
  tenantId: string;
  userId: string;
  topic: string;
  status: ReportStatus;
  /** 大綱節數；outlining 完成後才有值 */
  totalSections?: number;
  doneSections: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
```

- [ ] **Step 4: 實作 Markdown renderer**

先建共用字串模組 `server/src/modules/report/report.strings.ts`——這些語句與來源去重規則是「報告」的性質，不是 Markdown 的性質，各格式都要用同一份，放在任一 renderer 裡會讓其他 renderer 反向依賴它：

```ts
/**
 * 報告的共用文案與來源整併規則，各輸出格式共用。
 *
 * 不放在任何一個 renderer 裡：這些是報告本身的性質（查無資料怎麼說、來源怎麼去重），
 * 不是某種格式的性質。放進 markdown.ts 會讓 html.ts 反向依賴 markdown.ts。
 */
import { normalizeLocale } from '@/lib/locale';
import type { ReportSection, SectionSource } from './report.types';

/** 查無資料節的固定語句（中英各一） */
export function emptySectionText(locale: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'No relevant information found in the knowledge base.'
    : '知識庫查無相關資料。';
}

/** 降級節的標註（該節 LLM 彙整失敗，內容為原始片段） */
export function degradedNoticeText(locale: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'This section could not be synthesized; the retrieved excerpts are listed below.'
    : '本節彙整未完成，以下為檢索到的原始片段。';
}

/** 來源清單標題 */
export function sourcesHeading(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Sources' : '來源';
}

/**
 * 全報告的來源去重：同 title + 同 url 視為同一筆。
 * 以 Map 保序，讓輸出穩定可快照測試。
 */
export function dedupeSources(sections: ReportSection[]): SectionSource[] {
  const seen = new Map<string, SectionSource>();
  for (const section of sections) {
    for (const source of section.sources) {
      const key = `${source.title} ${source.url ?? ''}`;
      if (!seen.has(key)) seen.set(key, source);
    }
  }
  return [...seen.values()];
}
```

接著建 `server/src/modules/report/renderers/markdown.ts`：

```ts
/**
 * Markdown renderer：ReportDoc → .md bytes。純函式，不觸碰 IO。
 */
import {
  degradedNoticeText,
  dedupeSources,
  emptySectionText,
  sourcesHeading,
} from '../report.strings';
import type { ReportDoc, ReportSection } from '../report.types';

function sectionBody(section: ReportSection, locale: string): string {
  if (section.hits === 0) return emptySectionText(locale);
  if (section.degraded) return `> ${degradedNoticeText(locale)}\n\n${section.body}`;
  return section.body;
}

export function renderMarkdown(doc: ReportDoc): string {
  const lines: string[] = [`# ${doc.title}`, '', `> ${doc.topic}　${doc.generatedAt}`, ''];

  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, '', sectionBody(section, doc.locale), '');
  }

  const sources = dedupeSources(doc.sections);
  if (sources.length > 0) {
    lines.push(`## ${sourcesHeading(doc.locale)}`, '');
    for (const source of sources) {
      lines.push(source.url ? `- [${source.title}](${source.url})` : `- ${source.title}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export const markdownRenderer = {
  format: 'md',
  contentType: 'text/markdown; charset=utf-8',
  render: (doc: ReportDoc): Buffer => Buffer.from(renderMarkdown(doc), 'utf8'),
};
```

- [ ] **Step 5: 實作格式登錄表**

`server/src/modules/report/report.render.ts`：

```ts
/**
 * 報告輸出格式登錄表。
 *
 * 新增一種格式 = 新增一個 renderer 檔 + 這裡加一行。路由的 format 白名單、
 * 副檔名、Content-Type、前端下載連結全部由此推導，不得在別處另寫一份格式清單——
 * 多一份就多一個會漏改的地方。
 */
import type { ReportDoc } from './report.types';
import { markdownRenderer } from './renderers/markdown';

export interface ReportRenderer {
  /** URL 與儲存用的 key，同時是副檔名 */
  format: string;
  contentType: string;
  /** 回傳型別留 Promise，讓將來需要非同步的格式（如 headless 排版）不必改介面 */
  render(doc: ReportDoc): Buffer | Promise<Buffer>;
}

export const renderers: Record<string, ReportRenderer> = {
  [markdownRenderer.format]: markdownRenderer,
};

export const REPORT_FORMATS: string[] = Object.keys(renderers);

/** 預設格式：對話與下載路由未指定 format 時使用 */
export const DEFAULT_REPORT_FORMAT = 'md';

export function isReportFormat(format: string): boolean {
  return format in renderers;
}
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npm test -w server -- report-render`
Expected: PASS（5 個測試）。

- [ ] **Step 7: 型別檢查**

Run: `npm run typecheck -w server`
Expected: 無錯誤。

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/report server/tests/report-render.test.ts
git commit -m "feat(report): 新增報告資料模型與 Markdown renderer 登錄表"
```

---

### Task 2: HTML renderer 與登錄表契約測試

加入第二種格式，並補一條「對登錄表中每一個 renderer 都成立」的契約測試——之後新增的格式會自動被涵蓋。

**Files:**
- Create: `server/src/modules/report/renderers/html.ts`
- Modify: `server/src/modules/report/report.render.ts`（登錄表加一行）
- Test: `server/tests/report-render.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `ReportDoc`、`ReportRenderer`、`renderers`，以及 `report.strings.ts` 的 `emptySectionText` / `degradedNoticeText` / `sourcesHeading` / `dedupeSources`
- Produces: `htmlRenderer: ReportRenderer`（`format: 'html'`）、`escapeHtml(s: string): string`

- [ ] **Step 1: 寫失敗的測試**

在 `server/tests/report-render.test.ts` 末端追加（`makeDoc` 沿用檔案上方既有的定義）：

```ts
describe('html renderer', () => {
  async function renderHtml(doc: ReportDoc): Promise<string> {
    return (await renderers.html.render(doc)).toString('utf8');
  }

  it('輸出完整 HTML 文件且不引用任何外部資源', async () => {
    const out = await renderHtml(makeDoc());
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<style>');
    expect(out).not.toMatch(/https?:\/\/[^"']*\.(css|js)/);
    expect(out).not.toContain('<link');
    expect(out).not.toContain('<script');
  });

  it('escape 標題與內文——內容來自被爬取的外部網站，屬不可信輸入', async () => {
    const doc = makeDoc({
      title: '<script>alert(1)</script>',
      sections: [
        {
          heading: '<img onerror=alert(1)>',
          query: 'q',
          body: 'a & b < c',
          sources: [{ title: '"引號"', url: 'https://example.gov.tw/?a=1&b=2' }],
          hits: 1,
        },
      ],
    });
    const out = await renderHtml(doc);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('<img onerror');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('a &amp; b &lt; c');
    expect(out).toContain('https://example.gov.tw/?a=1&amp;b=2');
  });

  it('查無資料節與降級節的標註與 Markdown 一致', async () => {
    const doc = makeDoc({
      sections: [
        { heading: '金額', query: 'q', body: '', sources: [], hits: 0 },
        { heading: '期限', query: 'q', body: '片段', sources: [], hits: 1, degraded: true },
      ],
    });
    const out = await renderHtml(doc);
    expect(out).toContain('知識庫查無相關資料。');
    expect(out).toContain('本節彙整未完成，以下為檢索到的原始片段');
  });
});

describe('renderer 登錄表契約', () => {
  // 對每一個登錄的 renderer 跑同一份 doc：之後新增格式會自動被這條涵蓋
  it.each(Object.keys(renderers))('%s renderer 產出非空內容且有 contentType', async (format) => {
    const renderer = renderers[format];
    expect(renderer.format).toBe(format);
    expect(renderer.contentType).toMatch(/charset=utf-8/);
    const out = await renderer.render(makeDoc());
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-render`
Expected: FAIL，`renderers.html` 為 undefined。

- [ ] **Step 3: 實作 HTML renderer**

`server/src/modules/report/renderers/html.ts`：

```ts
/**
 * HTML renderer：ReportDoc → 單檔 HTML bytes。
 *
 * 零外部資源（無 CDN、無字型連結），確保離線與內網可開、可直接列印成 PDF。
 * 所有動態字串一律 escape：報告內容來自被爬取的外部網站與 LLM 輸出，屬不可信輸入。
 */
import {
  degradedNoticeText,
  dedupeSources,
  emptySectionText,
  sourcesHeading,
} from '../report.strings';
import type { ReportDoc, ReportSection } from '../report.types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  'body{max-width:46rem;margin:2rem auto;padding:0 1rem;',
  'font-family:system-ui,"Noto Sans TC",sans-serif;line-height:1.7;color:#1a1a1a}',
  'h1{font-size:1.6rem;margin-bottom:.25rem}',
  'h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #e5e5e5;padding-bottom:.25rem}',
  '.meta{color:#666;font-size:.85rem;margin-bottom:2rem}',
  '.notice{background:#fff8e1;border-left:3px solid #f0b429;padding:.5rem .75rem;margin:.5rem 0}',
  '.empty{color:#666}',
  'p{white-space:pre-wrap}',
  'a{color:#0b6bcb}',
].join('');

function sectionHtml(section: ReportSection, locale: string): string {
  const heading = `<h2>${escapeHtml(section.heading)}</h2>`;
  if (section.hits === 0) {
    return `${heading}\n<p class="empty">${escapeHtml(emptySectionText(locale))}</p>`;
  }
  const notice = section.degraded
    ? `<p class="notice">${escapeHtml(degradedNoticeText(locale))}</p>\n`
    : '';
  return `${heading}\n${notice}<p>${escapeHtml(section.body)}</p>`;
}

export function renderHtml(doc: ReportDoc): string {
  const sources = dedupeSources(doc.sections);
  const sourcesBlock =
    sources.length === 0
      ? ''
      : [
          `<h2>${escapeHtml(sourcesHeading(doc.locale))}</h2>`,
          '<ul>',
          ...sources.map((s) =>
            s.url
              ? `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a></li>`
              : `<li>${escapeHtml(s.title)}</li>`,
          ),
          '</ul>',
        ].join('\n');

  return [
    '<!doctype html>',
    `<html lang="${doc.locale === 'en' ? 'en' : 'zh-Hant'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `<p class="meta">${escapeHtml(doc.topic)}　${escapeHtml(doc.generatedAt)}</p>`,
    ...doc.sections.map((s) => sectionHtml(s, doc.locale)),
    sourcesBlock,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export const htmlRenderer = {
  format: 'html',
  contentType: 'text/html; charset=utf-8',
  render: (doc: ReportDoc): Buffer => Buffer.from(renderHtml(doc), 'utf8'),
};
```

- [ ] **Step 4: 登錄表加入 html**

修改 `server/src/modules/report/report.render.ts`：

```ts
import { htmlRenderer } from './renderers/html';
import { markdownRenderer } from './renderers/markdown';

export const renderers: Record<string, ReportRenderer> = {
  [markdownRenderer.format]: markdownRenderer,
  [htmlRenderer.format]: htmlRenderer,
};
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npm test -w server -- report-render`
Expected: PASS（含 `renderer 登錄表契約` 對 md / html 各跑一次）。

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/report server/tests/report-render.test.ts
git commit -m "feat(report): 新增 HTML renderer 與登錄表契約測試"
```

---

### Task 3: 大綱生成

主題 → LLM → `{title, sections[{heading, query}]}`。此任務不碰檢索。

**Files:**
- Create: `server/src/modules/report/report.outline.ts`
- Modify: `server/src/config/env.ts`（新增 `REPORT_MAX_SECTIONS`）
- Test: `server/tests/report-outline.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Outline` / `OutlineSection`
- Produces: `buildOutline(tenantId: string, topic: string, locale: string | undefined, llm: LLMProvider): Promise<Outline>`（失敗時 throw）

- [ ] **Step 1: 寫失敗的測試**

`server/tests/report-outline.test.ts`：

```ts
/**
 * 報告大綱生成：JSON 解析容錯、節數上限、失敗 fail-fast。
 */
import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { buildOutline } from '@/modules/report/report.outline';

/** 補齊 LLMResult 必填欄位（stopReason / model / keySource）的輔助函式 */
function llmResult(text: string): LLMResult {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 10 },
    model: 'test-model',
    keySource: 'platform',
  };
}

/** 依序回傳預設文字的假 LLM；記錄每次呼叫參數供斷言 */
function fakeLLM(texts: string[]): LLMProvider & { calls: LLMCreateParams[] } {
  const calls: LLMCreateParams[] = [];
  let i = 0;
  return {
    name: 'fake',
    calls,
    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      calls.push(params);
      const text = texts[Math.min(i, texts.length - 1)];
      i += 1;
      return llmResult(text);
    },
  };
}

const OK = JSON.stringify({
  title: '馬太鞍溪災害補助報告',
  sections: [
    { heading: '申請資格', query: '誰可以申請馬太鞍溪災害補助？' },
    { heading: '補助金額', query: '馬太鞍溪災害補助的金額是多少？' },
  ],
});

describe('buildOutline', () => {
  it('解析正常 JSON', async () => {
    const outline = await buildOutline('t1', '馬太鞍溪災害補助', 'zh-Hant', fakeLLM([OK]));
    expect(outline.title).toBe('馬太鞍溪災害補助報告');
    expect(outline.sections).toHaveLength(2);
    expect(outline.sections[0].query).toContain('誰可以申請');
  });

  it('容忍 JSON 前後綴（模型常加說明文字）', async () => {
    const llm = fakeLLM([`好的，以下是大綱：\n\`\`\`json\n${OK}\n\`\`\`\n希望有幫助`]);
    const outline = await buildOutline('t1', '主題', undefined, llm);
    expect(outline.sections).toHaveLength(2);
  });

  it('節數超過上限時截斷', async () => {
    const many = JSON.stringify({
      title: 'T',
      sections: Array.from({ length: 12 }, (_, i) => ({
        heading: `H${i}`,
        query: `Q${i}？`,
      })),
    });
    const outline = await buildOutline('t1', '主題', undefined, fakeLLM([many]));
    expect(outline.sections).toHaveLength(6);
  });

  it('剔除缺 heading 或 query 的節', async () => {
    const dirty = JSON.stringify({
      title: 'T',
      sections: [{ heading: 'A', query: 'a?' }, { heading: 'B' }, { query: 'c?' }],
    });
    const outline = await buildOutline('t1', '主題', undefined, fakeLLM([dirty]));
    expect(outline.sections).toEqual([{ heading: 'A', query: 'a?' }]);
  });

  it('非 JSON 回應 → 拋錯（沒有大綱就沒有報告，不得降級）', async () => {
    await expect(buildOutline('t1', '主題', undefined, fakeLLM(['我不知道']))).rejects.toThrow(
      /大綱/,
    );
  });

  it('解析出零節 → 拋錯', async () => {
    const empty = JSON.stringify({ title: 'T', sections: [] });
    await expect(buildOutline('t1', '主題', undefined, fakeLLM([empty]))).rejects.toThrow(/大綱/);
  });

  it('LLM 拋錯時原樣往上拋', async () => {
    const llm: LLMProvider = {
      name: 'failing',
      async createMessage(): Promise<LLMResult> {
        throw new Error('boom');
      },
    };
    await expect(buildOutline('t1', '主題', undefined, llm)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-outline`
Expected: FAIL，找不到 `@/modules/report/report.outline`。

- [ ] **Step 3: 新增 env 設定**

修改 `server/src/config/env.ts`，於 `KNOWLEDGE_RERANK` 附近加入：

```ts
  // 報告：大綱節數上限。每節各一次檢索 + 一次彙整 LLM，節數直接決定一份報告的成本
  REPORT_MAX_SECTIONS: z.coerce.number().int().min(1).max(12).default(6),
```

- [ ] **Step 4: 實作 buildOutline**

`server/src/modules/report/report.outline.ts`：

```ts
/**
 * 報告大綱生成：主題 → 章節清單（每節帶一句可獨立檢索的查詢）。
 *
 * 失敗一律 fail-fast，不像知識庫問答的指代改寫可以退回原句——沒有大綱就沒有報告，
 * 沒有東西可以降級成。
 */
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
import { normalizeLocale } from '@/lib/locale';
import { usageStore } from '@/modules/usage/usage.store';
import type { Outline, OutlineSection } from './report.types';

function outlineSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You plan the outline of a knowledge-base report. Output JSON only.',
      `Shape: {"title": "...", "sections": [{"heading": "...", "query": "..."}]}`,
      `Produce at most ${env.REPORT_MAX_SECTIONS} sections covering distinct aspects of the topic.`,
      '"query" MUST be a complete, self-contained question used to search the knowledge base —',
      'never a copy of the heading. Output nothing but the JSON.',
    ].join('\n');
  }
  return [
    '你是知識庫報告的大綱規劃器，只輸出 JSON。',
    '格式：{"title": "...", "sections": [{"heading": "...", "query": "..."}]}',
    `最多 ${env.REPORT_MAX_SECTIONS} 節，各節涵蓋主題的不同面向，不得重複。`,
    '"query" 必須是一句「可獨立理解、能直接拿去檢索」的完整問句，嚴禁只複製標題——',
    '每節是各自去知識庫檢索的，問句寫得夠具體才撈得到那一節需要的材料。',
    '除 JSON 外不要輸出任何文字。',
  ].join('\n');
}

/** 從模型輸出抓出第一個 JSON 物件（容忍前後綴與 code fence），比照 rerank.ts 的做法 */
function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('報告大綱解析失敗：模型未輸出 JSON');
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new Error('報告大綱解析失敗：JSON 格式錯誤');
  }
}

function toSections(raw: unknown): OutlineSection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is { heading: string; query: string } =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { heading?: unknown }).heading === 'string' &&
        typeof (s as { query?: unknown }).query === 'string' &&
        (s as { heading: string }).heading.trim() !== '' &&
        (s as { query: string }).query.trim() !== '',
    )
    .map((s) => ({ heading: s.heading.trim(), query: s.query.trim() }));
}

export async function buildOutline(
  tenantId: string,
  topic: string,
  locale: string | undefined,
  llm: LLMProvider,
): Promise<Outline> {
  const result = await llm.createMessage({
    system: outlineSystem(locale),
    messages: [{ role: 'user', content: [{ type: 'text', text: `報告主題：${topic}` }] }],
    maxTokens: 512,
  });
  usageStore.recordLLMUsage(tenantId, result);

  const parsed = extractJson(result.text ?? '') as { title?: unknown; sections?: unknown };
  const sections = toSections(parsed.sections).slice(0, env.REPORT_MAX_SECTIONS);
  if (sections.length === 0) throw new Error('報告大綱解析失敗：未取得任何章節');

  const title = typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim() : topic;
  return { title, sections };
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npm test -w server -- report-outline`
Expected: PASS（7 個測試）。

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/report/report.outline.ts server/src/config/env.ts server/tests/report-outline.test.ts
git commit -m "feat(report): 新增報告大綱生成與 JSON 解析容錯"
```

---

### Task 4: 逐節檢索與彙整

每節：`pickRetriever().search` → `rerankChunks` → LLM 彙整。零命中不呼叫 LLM，彙整失敗降級為片段列表。

**Files:**
- Create: `server/src/modules/report/report.compose.ts`
- Modify: `server/src/config/env.ts`（新增 `REPORT_SECTION_TOP_K`）
- Test: `server/tests/report-compose.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OutlineSection` / `ReportSection` / `SectionSource`；knowledge 的 `pickRetriever(tenantId)`、`rerankChunks(tenantId, query, chunks, topK)`、`KnowledgeChunk`
- Produces: `composeSection(tenantId: string, section: OutlineSection, locale: string | undefined, llm: LLMProvider): Promise<ReportSection>`

- [ ] **Step 1: 寫失敗的測試**

`server/tests/report-compose.test.ts`：

```ts
/**
 * 逐節彙整：零命中不呼叫 LLM、彙整失敗降級、節之間不共享脈絡、只用 pickRetriever 取檢索器。
 */
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const search = jest.fn<Promise<KnowledgeChunk[]>, [string, string]>();
jest.mock('@/modules/knowledge/retriever.pick', () => ({
  __esModule: true,
  pickRetriever: async () => ({ name: 'fake', search }),
}));

// rerank 在本任務不是被測對象；固定取前 topK，讓斷言聚焦在彙整行為
jest.mock('@/modules/knowledge/rerank', () => ({
  __esModule: true,
  rerankChunks: async (_t: string, _q: string, chunks: KnowledgeChunk[], k: number) =>
    chunks.slice(0, k),
}));

import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { composeSection } from '@/modules/report/report.compose';

function fakeLLM(text: string): LLMProvider & { calls: LLMCreateParams[] } {
  const calls: LLMCreateParams[] = [];
  return {
    name: 'fake',
    calls,
    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      calls.push(params);
      return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 5 },
        model: 'test-model',
        keySource: 'platform',
      };
    },
  };
}

function failingLLM(): LLMProvider {
  return {
    name: 'failing',
    async createMessage(): Promise<LLMResult> {
      throw new Error('llm down');
    },
  };
}

const CHUNKS: KnowledgeChunk[] = [
  { id: 'a', title: '補助須知', content: '設籍者可申請', url: 'https://example.gov.tw/a', score: 0.9 },
  { id: 'b', title: '公告', content: '每戶三萬元', score: 0.8 },
];

beforeEach(() => search.mockReset());

describe('composeSection', () => {
  it('有材料時彙整成內文並帶回來源', async () => {
    search.mockResolvedValue(CHUNKS);
    const llm = fakeLLM('設籍於受災區域者可申請，每戶三萬元。');
    const section = await composeSection(
      't1',
      { heading: '申請資格', query: '誰可以申請？' },
      'zh-Hant',
      llm,
    );
    expect(section.hits).toBe(2);
    expect(section.body).toContain('每戶三萬元');
    expect(section.sources).toEqual([
      { title: '補助須知', url: 'https://example.gov.tw/a' },
      { title: '公告' },
    ]);
    expect(section.degraded).toBeUndefined();
  });

  it('零命中時不呼叫 LLM，hits 為 0、body 留空由 renderer 補固定語句', async () => {
    search.mockResolvedValue([]);
    const llm = fakeLLM('不該被呼叫');
    const section = await composeSection('t1', { heading: '金額', query: 'q？' }, undefined, llm);
    expect(section.hits).toBe(0);
    expect(section.body).toBe('');
    expect(section.sources).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('彙整 LLM 失敗時降級為片段列表並標記 degraded', async () => {
    search.mockResolvedValue(CHUNKS);
    const section = await composeSection(
      't1',
      { heading: '期限', query: 'q？' },
      undefined,
      failingLLM(),
    );
    expect(section.degraded).toBe(true);
    expect(section.hits).toBe(2);
    expect(section.body).toContain('補助須知');
    expect(section.body).toContain('每戶三萬元');
  });

  it('檢索拋錯時該節記為查無資料，不讓一節拖垮整份', async () => {
    search.mockRejectedValue(new Error('pgvector down'));
    const llm = fakeLLM('不該被呼叫');
    const section = await composeSection('t1', { heading: 'A', query: 'q？' }, undefined, llm);
    expect(section.hits).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('送進 LLM 的內容只有本節材料——不得夾帶其他節的脈絡', async () => {
    search.mockResolvedValue(CHUNKS);
    const llm = fakeLLM('內文');
    await composeSection('t1', { heading: '申請資格', query: '誰可以申請？' }, undefined, llm);
    const text = llm.calls[0].messages[0].content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(text).toContain('補助須知');
    expect(text).not.toContain('先前對話');
    expect(text).not.toContain('前一節');
  });

  it('以該節的 query 檢索，而非章節標題', async () => {
    search.mockResolvedValue([]);
    await composeSection(
      't1',
      { heading: '申請資格', query: '誰可以申請馬太鞍溪災害補助？' },
      undefined,
      fakeLLM('x'),
    );
    expect(search).toHaveBeenCalledWith('t1', '誰可以申請馬太鞍溪災害補助？');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-compose`
Expected: FAIL，找不到 `@/modules/report/report.compose`。

- [ ] **Step 3: 新增 env 設定**

修改 `server/src/config/env.ts`，緊接 `REPORT_MAX_SECTIONS` 之後：

```ts
  // 報告：每節交給彙整 LLM 的片段數（與知識庫問答的 FINAL_K 同量級）
  REPORT_SECTION_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
```

- [ ] **Step 4: 實作 composeSection**

`server/src/modules/report/report.compose.ts`：

```ts
/**
 * 單節彙整：檢索 → 重排 → LLM 綜合成該節內文。
 *
 * 節與節之間刻意不共享脈絡：每節只看自己的參考資料。共享脈絡會讓後面的節帶著前面節的
 * 結論走，而那些結論的來源片段已不在視野內——等於讓模型在無法核對的二手資訊上繼續推論。
 */
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { normalizeLocale } from '@/lib/locale';
import { rerankChunks } from '@/modules/knowledge/rerank';
import { pickRetriever } from '@/modules/knowledge/retriever.pick';
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';
import { usageStore } from '@/modules/usage/usage.store';
import type { OutlineSection, ReportSection, SectionSource } from './report.types';

function sectionSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You write ONE section of a knowledge-base report. Respond entirely in English.',
      'Rules:',
      '- Use ONLY the reference material below; for anything not covered, say "Not mentioned in the materials." Never fabricate.',
      '- Write the body of this section only. Do NOT repeat the section heading.',
      '- Do NOT write conclusions, summaries, or transitions to other sections.',
      '- Cite sources inline as (Source: title) where helpful.',
    ].join('\n');
  }
  return [
    '你負責撰寫知識庫報告的「其中一節」，全程使用繁體中文。',
    '規則：',
    '- 只根據下方「參考資料」撰寫；資料未提到的部分明說「資料中未提及」，切勿杜撰。',
    '- 只寫這一節的內文，不要重複章節標題。',
    '- 不要寫結論、總結或銜接其他章節的過渡句（章節銜接由排版負責）。',
    '- 必要時於句末以（來源：標題）標註引用。',
  ].join('\n');
}

/** 彙整失敗時的降級內文：直接列出片段（比照知識庫問答的 fallbackReply） */
function fallbackBody(chunks: KnowledgeChunk[]): string {
  return chunks.map((c) => `・${c.title}：${c.content}`).join('\n');
}

function toSources(chunks: KnowledgeChunk[]): SectionSource[] {
  return chunks.map((c) => (c.url ? { title: c.title, url: c.url } : { title: c.title }));
}

export async function composeSection(
  tenantId: string,
  section: OutlineSection,
  locale: string | undefined,
  llm: LLMProvider,
): Promise<ReportSection> {
  const base = { heading: section.heading, query: section.query };

  // 檢索失敗不得中斷整份報告：該節記為查無資料，其餘節照跑
  let chunks: KnowledgeChunk[] = [];
  try {
    const retriever = await pickRetriever(tenantId);
    const pool = await retriever.search(tenantId, section.query);
    chunks = await rerankChunks(tenantId, section.query, pool, env.REPORT_SECTION_TOP_K);
  } catch (err) {
    logger.warn({ err, tenantId, query: section.query }, 'report section retrieval failed');
    return { ...base, body: '', sources: [], hits: 0 };
  }

  // 沒有材料就沒有東西可彙整——省下這一次 LLM 呼叫
  if (chunks.length === 0) return { ...base, body: '', sources: [], hits: 0 };

  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.title}${c.url ? `（${c.url}）` : ''}\n${c.content}`)
    .join('\n\n');

  try {
    const result = await llm.createMessage({
      system: sectionSystem(locale),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `章節標題：${section.heading}\n\n參考資料：\n${context}\n\n本節要回答：${section.query}`,
            },
          ],
        },
      ],
      cache: true,
      maxTokens: 1200,
    });
    usageStore.recordLLMUsage(tenantId, result);
    const body = (result.text ?? '').trim();
    if (body === '') {
      return { ...base, body: fallbackBody(chunks), sources: toSources(chunks), hits: chunks.length, degraded: true };
    }
    return { ...base, body, sources: toSources(chunks), hits: chunks.length };
  } catch (err) {
    logger.warn({ err, tenantId, heading: section.heading }, 'report section synthesis failed');
    return {
      ...base,
      body: fallbackBody(chunks),
      sources: toSources(chunks),
      hits: chunks.length,
      degraded: true,
    };
  }
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npm test -w server -- report-compose`
Expected: PASS（6 個測試）。

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/report/report.compose.ts server/src/config/env.ts server/tests/report-compose.test.ts
git commit -m "feat(report): 新增逐節檢索彙整，零命中不呼叫 LLM 且彙整失敗降級"
```

---

### Task 5: 產出物儲存與 DDL

以 (reportId, format) 為 key 存放產出物；記憶體 + db write-through；TTL 回收；`get` 為 async。

**Files:**
- Create: `server/src/modules/report/report.store.ts`
- Create: `server/db/migrations/0007_report_docs.sql`
- Modify: `server/prisma/schema.prisma`（新增 `ReportDocRow`）
- Modify: `server/src/config/env.ts`（新增 `REPORT_TTL_HOURS`）
- Test: `server/tests/report-store.test.ts`

**Interfaces:**
- Consumes: `DbWriteQueue`（`@/lib/db`）、Task 1 的型別
- Produces:
  - `StoredReport { reportId: string; tenantId: string; userId: string; format: string; filename: string; content: Buffer; expiresAt: string }`
  - `reportStore.save(input: { reportId; tenantId; userId; format; filename; content: Buffer }): void`
  - `reportStore.get(reportId: string, format: string): Promise<StoredReport | undefined>`
  - `reportStore.formatsOf(reportId: string): Promise<string[]>`（async 且 db-aware：重啟後記憶體為空時仍要能從 db 取得格式清單，否則狀態端點會 404 但下載打得到）
  - `reportStore.purgeExpired(now?: Date): number`
  - `reportStore._resetForTest(): void`

- [ ] **Step 1: 寫失敗的測試**

`server/tests/report-store.test.ts`：

```ts
/**
 * 報告產出物儲存：多格式並存、TTL 回收、get 為 async（db 模式下需能從資料庫讀回）。
 */
import { reportStore } from '@/modules/report/report.store';

function save(reportId: string, format: string, body: string): void {
  reportStore.save({
    reportId,
    tenantId: 't1',
    userId: 'u1',
    format,
    filename: `report.${format}`,
    content: Buffer.from(body, 'utf8'),
  });
}

beforeEach(() => reportStore._resetForTest());

describe('reportStore', () => {
  it('同一 reportId 的不同格式互不覆蓋', async () => {
    save('r1', 'md', '# md');
    save('r1', 'html', '<h1>html</h1>');
    expect((await reportStore.get('r1', 'md'))?.content.toString()).toBe('# md');
    expect((await reportStore.get('r1', 'html'))?.content.toString()).toBe('<h1>html</h1>');
    expect(reportStore.formatsOf('r1').sort()).toEqual(['html', 'md']);
  });

  it('未存過的報告或格式回 undefined', async () => {
    save('r1', 'md', '# md');
    expect(await reportStore.get('r1', 'pdf')).toBeUndefined();
    expect(await reportStore.get('nope', 'md')).toBeUndefined();
    expect(reportStore.formatsOf('nope')).toEqual([]);
  });

  it('帶回租戶與建立者，供下載時授權比對（job 記憶體狀態可能已因重啟消失）', async () => {
    save('r1', 'md', '# md');
    const stored = await reportStore.get('r1', 'md');
    expect(stored?.tenantId).toBe('t1');
    expect(stored?.userId).toBe('u1');
  });

  it('TTL 過期後被回收', async () => {
    save('r1', 'md', '# md');
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const purged = reportStore.purgeExpired(later);
    expect(purged).toBe(1);
    expect(await reportStore.get('r1', 'md')).toBeUndefined();
  });

  it('未過期者不被回收', async () => {
    save('r1', 'md', '# md');
    expect(reportStore.purgeExpired(new Date())).toBe(0);
    expect(await reportStore.get('r1', 'md')).toBeDefined();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-store`
Expected: FAIL，找不到 `@/modules/report/report.store`。

- [ ] **Step 3: 新增 env 設定**

修改 `server/src/config/env.ts`，緊接 `REPORT_SECTION_TOP_K` 之後：

```ts
  // 報告：產出物保存時數。附件靠對話結束清理，報告沒有對應的生命週期終點，只能靠 TTL
  REPORT_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
```

- [ ] **Step 4: 新增 DDL 與 Prisma model**

`server/db/migrations/0007_report_docs.sql`：

```sql
-- 0007: 報告產出物落地（DATA_BACKEND=db；純記憶體會讓重佈後的下載連結全失效）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
-- 主鍵為 (report_id, format)：一份報告每種格式一列，新增格式不必改 schema。

create table if not exists report_docs (
  report_id  text not null,
  format     text not null,
  tenant_id  text not null,
  user_id    text not null,
  filename   text not null,
  content    bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (report_id, format)
);

create index if not exists report_docs_expires_idx on report_docs (expires_at);

alter table report_docs enable row level security;
```

`server/prisma/schema.prisma` 追加：

```prisma
model ReportDocRow {
  reportId  String   @map("report_id")
  format    String
  tenantId  String   @map("tenant_id")
  userId    String   @map("user_id")
  filename  String
  /// 報告產出物內容（Markdown / HTML bytes）
  content   Bytes
  createdAt DateTime @default(now()) @map("created_at")
  expiresAt DateTime @map("expires_at")

  @@id([reportId, format])
  @@index([expiresAt])
  @@map("report_docs")
}
```

- [ ] **Step 5: 實作 reportStore**

`server/src/modules/report/report.store.ts`：

```ts
/**
 * 報告產出物儲存：記憶體 Map + DATA_BACKEND=db 時 write-through。
 *
 * 與 attachment.store 的兩點差異：
 * - get 一開始就是 async。附件的檔頭明載「目前無任何呼叫端讀 bytes」，所以它只讀記憶體；
 *   報告的下載就是讀取路徑，db 模式下必須能從 Postgres 讀回，否則重啟後連結全失效。
 * - 有 TTL。附件靠對話結束清理，報告沒有對應的生命週期終點。
 *
 * 儲存單位是 (reportId, format)，不是「md 欄位 + html 欄位」——以 format 為 key，
 * 新增一種格式只是多存一列，不必改 schema 與讀寫程式。
 */
import { env } from '@/config/env';
import { DbWriteQueue, getDb } from '@/lib/db';

export interface StoredReport {
  reportId: string;
  tenantId: string;
  userId: string;
  format: string;
  filename: string;
  content: Buffer;
  expiresAt: string;
}

const docs = new Map<string, StoredReport>();
const writeQueue = new DbWriteQueue('report-docs');

const keyOf = (reportId: string, format: string): string => `${reportId}:${format}`;

export const reportStore = {
  save(input: {
    reportId: string;
    tenantId: string;
    userId: string;
    format: string;
    filename: string;
    content: Buffer;
  }): void {
    const expiresAt = new Date(Date.now() + env.REPORT_TTL_HOURS * 3600_000).toISOString();
    const stored: StoredReport = { ...input, expiresAt };
    docs.set(keyOf(input.reportId, input.format), stored);

    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.reportDocRow.upsert({
          where: { reportId_format: { reportId: input.reportId, format: input.format } },
          create: {
            reportId: input.reportId,
            format: input.format,
            tenantId: input.tenantId,
            userId: input.userId,
            filename: input.filename,
            content: input.content,
            expiresAt: new Date(expiresAt),
          },
          update: { content: input.content, expiresAt: new Date(expiresAt) },
        });
      });
    }
  },

  /** 先讀記憶體，未命中且為 db 模式時回資料庫撈（重啟後的下載走這條） */
  async get(reportId: string, format: string): Promise<StoredReport | undefined> {
    const hit = docs.get(keyOf(reportId, format));
    if (hit) return hit;
    if (env.DATA_BACKEND !== 'db') return undefined;

    const db = getDb();
    if (!db) return undefined;
    const row = await db.reportDocRow.findUnique({
      where: { reportId_format: { reportId, format } },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;

    const stored: StoredReport = {
      reportId: row.reportId,
      tenantId: row.tenantId,
      userId: row.userId,
      format: row.format,
      filename: row.filename,
      content: Buffer.from(row.content),
      expiresAt: row.expiresAt.toISOString(),
    };
    docs.set(keyOf(reportId, format), stored);
    return stored;
  },

  /** 該報告目前有哪些格式可下載（狀態端點回給前端，前端據此渲染連結） */
  formatsOf(reportId: string): string[] {
    return [...docs.values()].filter((d) => d.reportId === reportId).map((d) => d.format);
  },

  /** 清除過期產出物，回傳清除筆數 */
  purgeExpired(now: Date = new Date()): number {
    let purged = 0;
    for (const [key, doc] of docs) {
      if (new Date(doc.expiresAt).getTime() <= now.getTime()) {
        docs.delete(key);
        purged += 1;
      }
    }
    if (purged > 0 && env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.reportDocRow.deleteMany({ where: { expiresAt: { lte: now } } });
      });
    }
    return purged;
  },

  _resetForTest(): void {
    docs.clear();
  },
};
```

若 `@/lib/db` 尚未 export `getDb()`，於該檔加入（`client` 為模組內既有變數）：

```ts
/** 取得已連線的 Prisma client；未連線（file 模式）回 undefined */
export function getDb(): PrismaClient | undefined {
  return client ?? undefined;
}
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npm test -w server -- report-store`
Expected: PASS（5 個測試）。

- [ ] **Step 7: 產生 Prisma client 並型別檢查**

Run: `npm run db:generate -w server && npm run typecheck -w server`
Expected: 無錯誤。

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/report/report.store.ts server/db/migrations/0007_report_docs.sql \
  server/prisma/schema.prisma server/src/config/env.ts server/src/lib/db.ts server/tests/report-store.test.ts
git commit -m "feat(report): 新增報告產出物儲存與 report_docs 資料表"
```

---

### Task 6: 非同步 job

串起 outline → compose → render → store，管理狀態流轉與同租戶單一任務。

**Files:**
- Create: `server/src/modules/report/report.job.ts`
- Test: `server/tests/report-job.test.ts`

**Interfaces:**
- Consumes: Task 1 型別、Task 3 `buildOutline`、Task 4 `composeSection`、Task 5 `reportStore`、Task 1-2 `renderers`
- Produces:
  - `startReportJob(params: { tenantId; userId; topic; locale?: string; llm: LLMProvider }, deps?: ReportJobDeps): ReportJob`
  - `getReportJob(id: string): ReportJob | undefined`
  - `getRunningReportJobForTenant(tenantId: string): ReportJob | undefined`
  - `waitForJobForTest(id: string): Promise<ReportJob>`
  - `ReportJobDeps { outline?: typeof buildOutline; compose?: typeof composeSection }`

- [ ] **Step 1: 寫失敗的測試**

`server/tests/report-job.test.ts`：

```ts
/**
 * 報告 job：狀態流轉、全零命中 → empty 且不產檔、大綱失敗 → failed、同租戶併發 409。
 */
import type { LLMProvider } from '@/lib/llm/types';
import type { Outline, ReportSection } from '@/modules/report/report.types';
import { reportStore } from '@/modules/report/report.store';
import {
  getReportJob,
  startReportJob,
  waitForJobForTest,
} from '@/modules/report/report.job';

const llm = {} as LLMProvider;

const outline: Outline = {
  title: '報告',
  sections: [
    { heading: 'A', query: 'a？' },
    { heading: 'B', query: 'b？' },
  ],
};

function sectionWith(hits: number): (t: string, s: { heading: string; query: string }) => Promise<ReportSection> {
  return async (_t, s) => ({
    heading: s.heading,
    query: s.query,
    body: hits > 0 ? '內文' : '',
    sources: hits > 0 ? [{ title: '來源' }] : [],
    hits,
  });
}

beforeEach(() => reportStore._resetForTest());

describe('startReportJob', () => {
  it('完成後狀態為 done，並存下所有登錄格式', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(2) },
    );
    expect(job.status).toBe('queued');

    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('done');
    expect(done.totalSections).toBe(2);
    expect(done.doneSections).toBe(2);
    expect(done.finishedAt).toBeDefined();
    expect(reportStore.formatsOf(job.id).sort()).toEqual(['html', 'md']);
    expect((await reportStore.get(job.id, 'md'))?.content.toString()).toContain('## A');
  });

  it('全部節零命中 → empty，且不產檔', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(0) },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('empty');
    expect(reportStore.formatsOf(job.id)).toEqual([]);
  });

  it('只要有一節命中就照常產檔（缺口以查無資料呈現）', async () => {
    let call = 0;
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => outline,
        compose: async (_t, s) => {
          call += 1;
          return {
            heading: s.heading,
            query: s.query,
            body: call === 1 ? '內文' : '',
            sources: [],
            hits: call === 1 ? 1 : 0,
          };
        },
      },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('done');
    const md = (await reportStore.get(job.id, 'md'))?.content.toString() ?? '';
    expect(md).toContain('## A');
    expect(md).toContain('知識庫查無相關資料。');
  });

  it('大綱失敗 → failed 並記錄原因', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => {
          throw new Error('報告大綱解析失敗：模型未輸出 JSON');
        },
        compose: sectionWith(2),
      },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('大綱');
    expect(reportStore.formatsOf(job.id)).toEqual([]);
  });

  it('同租戶已有進行中任務 → 409', async () => {
    startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return outline;
        },
        compose: sectionWith(1),
      },
    );
    expect(() =>
      startReportJob(
        { tenantId: 't1', userId: 'u2', topic: '另一個主題', llm },
        { outline: async () => outline, compose: sectionWith(1) },
      ),
    ).toThrow(/進行中/);
  });

  it('不同租戶可同時進行', async () => {
    startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return outline;
        },
        compose: sectionWith(1),
      },
    );
    expect(() =>
      startReportJob(
        { tenantId: 't2', userId: 'u2', topic: '主題', llm },
        { outline: async () => outline, compose: sectionWith(1) },
      ),
    ).not.toThrow();
  });

  it('getReportJob 取得目前狀態快照', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(1) },
    );
    expect(getReportJob(job.id)?.topic).toBe('主題');
    await waitForJobForTest(job.id);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-job`
Expected: FAIL，找不到 `@/modules/report/report.job`。

- [ ] **Step 3: 實作 report.job.ts**

`server/src/modules/report/report.job.ts`：

```ts
/**
 * 報告非同步 job：啟動、追蹤進度、同租戶單一任務限制（比照 knowledge.job）。
 *
 * 對話輪次不能等一份報告跑完（1 次大綱 + N 次檢索 + N 次彙整），因此 handleTurn 只負責
 * 啟動並立刻回覆，實際工作在程序內非同步進行、由前端輪詢。
 */
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { normalizeLocale } from '@/lib/locale';
import { buildOutline } from './report.outline';
import { composeSection } from './report.compose';
import { renderers } from './report.render';
import { reportStore } from './report.store';
import type { ReportDoc, ReportJob, ReportSection } from './report.types';

const jobs = new Map<string, ReportJob>();
/** 供測試等待背景工作結束；正式流程一律走輪詢 */
const running = new Map<string, Promise<void>>();

export interface ReportJobDeps {
  outline?: typeof buildOutline;
  compose?: typeof composeSection;
}

export interface StartReportParams {
  tenantId: string;
  userId: string;
  topic: string;
  locale?: string;
  llm: LLMProvider;
}

export function getReportJob(id: string): ReportJob | undefined {
  return jobs.get(id);
}

export function getRunningReportJobForTenant(tenantId: string): ReportJob | undefined {
  return [...jobs.values()].find(
    (j) =>
      j.tenantId === tenantId &&
      (j.status === 'queued' || j.status === 'outlining' || j.status === 'composing'),
  );
}

/** 檔名用的安全片段：只留中英數字，其餘轉底線，避免 Content-Disposition 被標題內容破壞 */
function slugify(title: string): string {
  const cleaned = title.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 40) || 'report';
}

export function startReportJob(params: StartReportParams, deps: ReportJobDeps = {}): ReportJob {
  if (getRunningReportJobForTenant(params.tenantId)) {
    throw AppError.conflict('該租戶已有報告產生任務進行中');
  }

  const outline = deps.outline ?? buildOutline;
  const compose = deps.compose ?? composeSection;

  const job: ReportJob = {
    id: randomUUID(),
    tenantId: params.tenantId,
    userId: params.userId,
    topic: params.topic,
    status: 'queued',
    doneSections: 0,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  const work = (async () => {
    try {
      job.status = 'outlining';
      const plan = await outline(params.tenantId, params.topic, params.locale, params.llm);
      job.totalSections = plan.sections.length;
      job.status = 'composing';

      // 逐節序列執行：併發會讓同租戶的 embedding / rerank 呼叫尖峰疊在一起，
      // 而報告本來就是非同步任務，沒有必要用尖峰換那幾秒
      const sections: ReportSection[] = [];
      for (const section of plan.sections) {
        sections.push(await compose(params.tenantId, section, params.locale, params.llm));
        job.doneSections += 1;
      }

      // 全部節都零命中：流程成功但沒有內容可交付，不產檔
      if (sections.every((s) => s.hits === 0)) {
        job.status = 'empty';
        job.finishedAt = new Date().toISOString();
        logger.info({ jobId: job.id, tenantId: params.tenantId }, 'report job empty');
        return;
      }

      const doc: ReportDoc = {
        title: plan.title,
        topic: params.topic,
        locale: normalizeLocale(params.locale),
        generatedAt: new Date().toISOString(),
        sections,
      };

      const slug = slugify(plan.title);
      for (const renderer of Object.values(renderers)) {
        reportStore.save({
          reportId: job.id,
          tenantId: params.tenantId,
          userId: params.userId,
          format: renderer.format,
          filename: `${slug}.${renderer.format}`,
          content: await renderer.render(doc),
        });
      }

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      logger.info(
        { jobId: job.id, tenantId: params.tenantId, sections: sections.length },
        'report job done',
      );
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();
      logger.warn({ err, tenantId: params.tenantId }, 'report job failed');
    } finally {
      running.delete(job.id);
    }
  })();

  running.set(job.id, work);
  return job;
}

/** 測試專用：等背景工作結束後回傳最終狀態 */
export async function waitForJobForTest(id: string): Promise<ReportJob> {
  await running.get(id);
  const job = jobs.get(id);
  if (!job) throw new Error(`unknown report job: ${id}`);
  return job;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- report-job`
Expected: PASS（7 個測試）。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/report/report.job.ts server/tests/report-job.test.ts
git commit -m "feat(report): 新增報告非同步 job 與 empty/failed 終態"
```

---

### Task 7: Agent 服務、scope 與意圖區隔

把報告掛進對話：抽主題 → 啟動 job → 立刻回覆。

**Files:**
- Create: `server/src/modules/report/report.agent-service.ts`
- Modify: `server/src/modules/conversation/agent-service.types.ts`（`AgentTurnResult` 加 `report?`）
- Modify: `server/src/modules/conversation/service.registry.ts`（註冊）
- Modify: `server/src/modules/authz/scope-catalog.ts`（新增 `service:report`）
- Modify: `shared/src/index.ts`（新增 `ReportRef`）
- Test: `server/tests/report-agent-service.test.ts`

**Interfaces:**
- Consumes: Task 6 `startReportJob`；`AgentService` / `AgentTurnResult` / `IntentDescriptor`；`priorMessages` / `transcriptOf`
- Produces:
  - `ReportRef { id: string; status: 'queued' }`（`@oa-agent/shared`）
  - `reportAgentService: AgentService`（`id: 'report'`、`serviceScope: 'service:report'`、`sticky: false`）
  - `AgentTurnResult.report?: ReportRef`

- [ ] **Step 1: 寫失敗的測試**

`server/tests/report-agent-service.test.ts`：

```ts
/**
 * 報告 Agent 服務：主題抽取、抽不到主題不建 job、旁路不變式、scope 守門。
 */
import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import type { Session } from '@/modules/conversation/conversation.types';
import { reportAgentService } from '@/modules/report/report.agent-service';
import { getReportJob, waitForJobForTest } from '@/modules/report/report.job';
import { reportStore } from '@/modules/report/report.store';

jest.mock('@/modules/report/report.outline', () => ({
  __esModule: true,
  buildOutline: async () => ({ title: 'T', sections: [{ heading: 'A', query: 'a？' }] }),
}));
jest.mock('@/modules/report/report.compose', () => ({
  __esModule: true,
  composeSection: async (_t: string, s: { heading: string; query: string }) => ({
    heading: s.heading,
    query: s.query,
    body: '內文',
    sources: [],
    hits: 1,
  }),
}));

function fakeLLM(text: string): LLMProvider & { calls: LLMCreateParams[] } {
  const calls: LLMCreateParams[] = [];
  return {
    name: 'fake',
    calls,
    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      calls.push(params);
      return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 5 },
        model: 'test-model',
        keySource: 'platform',
      };
    },
  };
}

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: `rep-${Math.random().toString(36).slice(2)}`,
    userId: 'u1',
    formId: 'leave-request',
    values: { leaveType: 'annual' },
    status: 'collecting',
    activeServiceId: 'form',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我整理一份補助報告' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

beforeEach(() => reportStore._resetForTest());

describe('reportAgentService', () => {
  it('是旁路服務且需 service:report scope', () => {
    expect(reportAgentService.id).toBe('report');
    expect(reportAgentService.sticky).toBe(false);
    expect(reportAgentService.serviceScope).toBe('service:report');
  });

  it('抽到主題後啟動 job，立刻回覆並帶回 reportId', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(
      session,
      '幫我整理一份補助報告',
      fakeLLM('馬太鞍溪災害補助'),
    );
    expect(result.report?.id).toBeDefined();
    expect(result.report?.status).toBe('queued');
    expect(result.reply).toContain('產生');
    expect(getReportJob(result.report!.id)?.topic).toBe('馬太鞍溪災害補助');
    await waitForJobForTest(result.report!.id);
  });

  it('旁路不變式：不觸碰 session.values 與 status', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', fakeLLM('主題'));
    expect(session.values).toEqual({ leaveType: 'annual' });
    expect(session.status).toBe('collecting');
    await waitForJobForTest(result.report!.id);
  });

  it('回覆寫進逐字稿，維持對話一致', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', fakeLLM('主題'));
    const last = session.messages[session.messages.length - 1];
    expect(last.role).toBe('assistant');
    await waitForJobForTest(result.report!.id);
  });

  it('抽不出主題時不建 job，改回問——空泛主題會實際燒掉多次 LLM 呼叫', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', fakeLLM('NONE'));
    expect(result.report).toBeUndefined();
    expect(result.reply).toContain('主題');
  });

  it('主題抽取 LLM 失敗時同樣不建 job（不得 fail-open）', async () => {
    const llm: LLMProvider = {
      name: 'failing',
      async createMessage(): Promise<LLMResult> {
        throw new Error('llm down');
      },
    };
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', llm);
    expect(result.report).toBeUndefined();
    expect(result.reply).toContain('主題');
  });

  it('同租戶已有任務進行中時，回覆說明而非拋錯中斷對話', async () => {
    const tenantId = 'rep-busy';
    const first = await reportAgentService.handleTurn(
      makeSession({ tenantId }),
      '報告',
      fakeLLM('主題一'),
    );
    const second = await reportAgentService.handleTurn(
      makeSession({ tenantId }),
      '報告',
      fakeLLM('主題二'),
    );
    expect(second.report).toBeUndefined();
    expect(second.reply).toContain('進行中');
    await waitForJobForTest(first.report!.id);
  });

  it('intents 描述明確區隔「要文件」與「要答案」', () => {
    const [intent] = reportAgentService.intents(makeSession());
    expect(intent.id).toBe('report.generate');
    expect(intent.description).toContain('文件');
    expect(intent.keywords).toContain('報告');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-agent-service`
Expected: FAIL，找不到 `@/modules/report/report.agent-service`。

- [ ] **Step 3: 新增 shared 型別**

`shared/src/index.ts` 追加：

```ts
/** 對話回合附帶的報告參考；建立當下恆為 queued，後續狀態由前端輪詢 */
export interface ReportRef {
  id: string;
  status: 'queued';
}
```

- [ ] **Step 4: 擴充 AgentTurnResult**

修改 `server/src/modules/conversation/agent-service.types.ts`：

```ts
import type { ReportRef } from '@oa-agent/shared';

export interface AgentTurnResult {
  reply: string;
  /**
   * 本回合啟動的報告；前端據此顯示進度與下載連結。
   * 命名不做泛化的 artifact——目前只有這一種產出物，泛化會憑空多一層而沒有第二個使用者。
   */
  report?: ReportRef;
}
```

- [ ] **Step 5: 新增 scope**

修改 `server/src/modules/authz/scope-catalog.ts`，於 `service:agent` 之後插入：

```ts
  { id: 'service:report', label: '知識庫報告', description: '依知識庫檢索產生可下載的報告', base: false },
```

用獨立 scope 而非併入 `service:knowledge`：報告的成本是單次問答的數倍，租戶必須能只開問答、不開報告。

- [ ] **Step 6: 實作 report.agent-service.ts**

`server/src/modules/report/report.agent-service.ts`：

```ts
/**
 * 報告 Agent 服務。
 *
 * sticky=false：與知識庫問答同為旁路服務——啟動報告後不奪走填表流程，
 * 且不動 session 的 values / status。
 *
 * 本服務只負責「抽主題 → 啟動 job → 立刻回覆」；實際彙整在 report.job 背景進行。
 */
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { normalizeLocale } from '@/lib/locale';
import { priorMessages, transcriptOf } from '@/modules/conversation/history';
import type {
  AgentService,
  AgentTurnResult,
  IntentDescriptor,
} from '@/modules/conversation/agent-service.types';
import type { Session } from '@/modules/conversation/conversation.types';
import { usageStore } from '@/modules/usage/usage.store';
import { getRunningReportJobForTenant, startReportJob } from './report.job';

const HISTORY_MESSAGES = 6;

/** 模型判定對話中沒有可用主題時輸出的哨兵字串 */
const NO_TOPIC = 'NONE';

const REPORT_KEYWORDS = [
  '報告',
  '彙整',
  '整理一份',
  '整理成',
  '總結',
  '摘要文件',
  'report',
  'summary document',
];

function topicSystem(): string {
  return [
    '你負責從對話中抽出「使用者想產生報告的主題」。',
    '只輸出主題本身，一句話、可獨立理解，不要任何前後綴或說明。',
    '依對話脈絡補齊代名詞與省略的對象；嚴禁加入脈絡中沒有的條件或臆測。',
    `對話中若沒有明確可用的主題，只輸出 ${NO_TOPIC}。`,
  ].join('\n');
}

/**
 * 抽出報告主題。與知識庫問答的指代改寫相反，這裡**不得 fail-open**：
 * 拿一句空泛的話去跑一份報告，會實際支出「1 次大綱 + N 次檢索 + N 次彙整」的成本，
 * 換回一份必定無用的產出。抽不到就回問，讓使用者補一句。
 */
async function resolveTopic(
  session: Session,
  userText: string,
  llm: LLMProvider,
): Promise<string | undefined> {
  const history = priorMessages(session, HISTORY_MESSAGES);
  try {
    const result = await llm.createMessage({
      system: topicSystem(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                history.length > 0 ? `對話脈絡：\n${transcriptOf(history)}\n` : '',
                `最新訊息：${userText}`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        },
      ],
      model: env.LLM_ROUTER_MODEL, // 主題抽取屬輔助任務，用便宜模型即可
      maxTokens: 128,
    });
    usageStore.recordLLMUsage(session.tenantId, result);
    const topic = (result.text ?? '').replace(/\s+/g, ' ').trim();
    if (topic === '' || topic.toUpperCase() === NO_TOPIC) return undefined;
    return topic;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'report topic extraction failed');
    return undefined;
  }
}

function askTopicReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'What topic should the report cover? Tell me the subject and I will compile it from the knowledge base.'
    : '你想針對什麼主題產生報告？告訴我主題，我就依知識庫的資料彙整一份給你。';
}

function busyReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'A report is already being generated for your organization. Please try again once it finishes.'
    : '目前已有一份報告正在產生中，請等它完成後再試。';
}

function startedReply(topic: string, locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? `Generating a report on "${topic}" from the knowledge base. I will show the download links here when it is ready.`
    : `正在依知識庫的資料產生「${topic}」的報告，完成後會在這裡提供下載連結。`;
}

export const reportAgentService: AgentService = {
  id: 'report',
  label: '知識庫報告',
  description: '依知識庫檢索結果彙整成一份可下載的報告（Markdown / HTML），附各節來源',
  sticky: false,
  serviceScope: 'service:report',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'report.generate',
        keywords: REPORT_KEYWORDS,
        description:
          '產生一份可下載、可帶走的報告文件：使用者要的是把某個主題的資料彙整成一份多章節的文件，' +
          '而不是一個問題的答案。只想知道某件事怎麼規定、怎麼申請，屬於知識庫問答（kb.query），不是這個',
        examples: ['幫我整理一份請假規定的報告', '把補助辦法彙整成一份文件'],
      },
    ];
  },

  async handleTurn(
    session: Session,
    userText: string,
    llm: LLMProvider,
  ): Promise<AgentTurnResult> {
    const topic = await resolveTopic(session, userText, llm);

    let result: AgentTurnResult;
    if (!topic) {
      result = { reply: askTopicReply(session.locale) };
    } else if (getRunningReportJobForTenant(session.tenantId)) {
      // 併發限制在對話中是「說明」而非錯誤：拋 409 會讓整個回合失敗、逐字稿留下斷點
      result = { reply: busyReply(session.locale) };
    } else {
      const job = startReportJob({
        tenantId: session.tenantId,
        userId: session.userId,
        topic,
        locale: session.locale,
        llm,
      });
      result = {
        reply: startedReply(topic, session.locale),
        report: { id: job.id, status: 'queued' },
      };
    }

    // 旁路回答：只在逐字稿留紀錄，刻意不觸碰 session.values / session.status
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: result.reply }] });
    return result;
  },
};
```

- [ ] **Step 7: 註冊服務**

修改 `server/src/modules/conversation/service.registry.ts`：

```ts
import { reportAgentService } from '@/modules/report/report.agent-service';

register(reportAgentService);
```

- [ ] **Step 8: 執行測試確認通過**

Run: `npm test -w server -- report-agent-service`
Expected: PASS（8 個測試）。

- [ ] **Step 9: 跑全部 server 測試，確認未破壞既有服務註冊與 scope 相關測試**

Run: `npm test -w server`
Expected: PASS。若既有測試斷言「服務數量為 4」或列舉 scope 清單，更新該斷言以含入 report。

- [ ] **Step 10: Commit**

```bash
git add server/src/modules/report/report.agent-service.ts \
  server/src/modules/conversation/agent-service.types.ts \
  server/src/modules/conversation/service.registry.ts \
  server/src/modules/authz/scope-catalog.ts shared/src/index.ts \
  server/tests/report-agent-service.test.ts
git commit -m "feat(report): 對話掛載報告服務並新增 service:report scope"
```

---

### Task 8: REST 路由、下載與回合契約串接

狀態查詢、下載、授權；把 `report` 從 `AgentTurnResult` 一路帶到 HTTP 回應。

**Files:**
- Create: `server/src/modules/report/report.controller.ts`
- Create: `server/src/modules/report/report.routes.ts`
- Create: `server/src/modules/report/report.schema.ts`
- Modify: `server/src/app.ts`（掛載路由）
- Modify: `server/src/modules/conversation/conversation.types.ts`（`TurnResult` 加 `report?`）
- Modify: `server/src/modules/conversation/conversation.service.ts`（把 agent 的 `report` 帶進 `TurnResult`）
- Modify: `server/src/modules/conversation/conversation.controller.ts`（回應帶 `report`）
- Test: `server/tests/report-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 `reportStore`、Task 6 `getReportJob`、Task 1-2 `renderers` / `isReportFormat` / `DEFAULT_REPORT_FORMAT`
- Produces:
  - `GET /api/reports/:id` → `{ data: { id, status, topic, doneSections, totalSections?, formats: string[], error? } }`
  - `GET /api/reports/:id/download?format=<format>` → 檔案
  - `reportRouter`

- [ ] **Step 1: 寫失敗的測試**

`server/tests/report-routes.test.ts`：

```ts
/**
 * 報告 REST：狀態查詢、下載授權、格式白名單由登錄表推導。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { reportStore } from '@/modules/report/report.store';

const app = createApp();

/**
 * 取 token 的做法沿用 e2e-leave-happy-path.test.ts：打真實 login 端點。
 * JWT 的 sub 就是 username，因此登入 'kevin' 後 API 解析出的 userId 即為 'kevin'。
 */
async function loginToken(): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function save(reportId: string, userId: string, format: string, body: string): void {
  reportStore.save({
    reportId,
    tenantId: 'default',
    userId,
    format,
    filename: `report.${format}`,
    content: Buffer.from(body, 'utf8'),
  });
}

beforeEach(() => reportStore._resetForTest());

describe('GET /api/reports/:id/download', () => {
  it('建立者可下載 md，帶正確的 Content-Type 與檔名', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/markdown');
    expect(res.header['content-disposition']).toContain('report.md');
    expect(res.text).toContain('# 報告');
  });

  it('未指定 format 時預設 md', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
  });

  it('非建立者取得 404 而非 403——403 等於承認該報告存在', async () => {
    save('r1', 'someone-else', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });

  it('未登入回 401', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app).get('/api/reports/r1/download?format=md');
    expect(res.status).toBe(401);
  });

  it('登錄表外的格式回 400', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download?format=pdf')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(400);
  });

  it('不存在的報告回 404', async () => {
    const res = await request(app)
      .get('/api/reports/nope/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/reports/:id', () => {
  it('已產檔的報告回 done 與可下載格式清單', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    save('r1', 'kevin', 'html', '<h1>報告</h1>');
    const res = await request(app)
      .get('/api/reports/r1')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('done');
    expect(res.body.data.formats.sort()).toEqual(['html', 'md']);
  });

  it('查無此報告回 404', async () => {
    const res = await request(app)
      .get('/api/reports/nope')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- report-routes`
Expected: FAIL，`/api/reports` 回 404（路由尚未掛載）。

- [ ] **Step 3: 實作 schema**

`server/src/modules/report/report.schema.ts`：

```ts
import { z } from 'zod';
import { REPORT_FORMATS } from './report.render';

export const reportIdParamSchema = z.object({ id: z.string().min(1) });

/**
 * format 白名單直接由 renderer 登錄表推導——不另外手寫一份格式清單，
 * 多一份就多一個新增格式時會漏改的地方。
 */
export const downloadQuerySchema = z.object({
  format: z.enum(REPORT_FORMATS as [string, ...string[]]).optional(),
});
```

- [ ] **Step 4: 實作 controller**

`server/src/modules/report/report.controller.ts`：

```ts
import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { getReportJob } from './report.job';
import { DEFAULT_REPORT_FORMAT, renderers } from './report.render';
import { reportStore } from './report.store';

function resolveUserId(req: Request): string {
  return req.user?.sub ?? req.header('x-user-id') ?? 'demo-user';
}

function resolveTenantId(req: Request): string {
  return req.tenant?.id ?? 'default';
}

export const reportController = {
  /**
   * 狀態查詢。job 只活在記憶體，重啟後會消失；此時若產出物還在，就以產出物為準回報 done——
   * 否則會出現「下載得到、狀態卻查不到」的矛盾。
   */
  async get(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    // formatsOf 是 async 且 db-aware：重啟後 job 已消失、記憶體也空，仍要能從 db 得知有哪些格式，
    // 否則會出現「狀態查詢 404、下載卻打得到」的矛盾
    const formats = await reportStore.formatsOf(id);
    const job = getReportJob(id);

    if (job && (job.tenantId !== tenantId || job.userId !== userId)) {
      throw AppError.notFound('報告不存在');
    }
    if (!job && formats.length === 0) throw AppError.notFound('報告不存在');

    if (!job) {
      res.json({ data: { id, status: 'done', doneSections: 0, formats } });
      return;
    }

    res.json({
      data: {
        id: job.id,
        status: job.status,
        topic: job.topic,
        doneSections: job.doneSections,
        ...(job.totalSections !== undefined ? { totalSections: job.totalSections } : {}),
        formats,
        ...(job.error ? { error: job.error } : {}),
      },
    });
  },

  async download(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const format = (req.query.format as string | undefined) ?? DEFAULT_REPORT_FORMAT;
    const stored = await reportStore.get(id, format);

    // 一律 404：403 等於向非建立者確認「這份報告存在」
    if (!stored) throw AppError.notFound('報告不存在');
    if (stored.tenantId !== resolveTenantId(req) || stored.userId !== resolveUserId(req)) {
      throw AppError.notFound('報告不存在');
    }

    res.setHeader('Content-Type', renderers[format].contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(stored.filename)}"`,
    );
    res.send(stored.content);
  },
};
```

- [ ] **Step 5: 實作路由並掛載**

`server/src/modules/report/report.routes.ts`：

```ts
import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { reportController } from './report.controller';
import { downloadQuerySchema, reportIdParamSchema } from './report.schema';

const router = Router();

router.get(
  '/:id',
  validate({ params: reportIdParamSchema }),
  asyncHandler(reportController.get),
);

router.get(
  '/:id/download',
  validate({ params: reportIdParamSchema, query: downloadQuerySchema }),
  asyncHandler(reportController.download),
);

export const reportRouter = router;
```

修改 `server/src/app.ts`，在 `/api/forms` 那行之後加入：

```ts
import { reportRouter } from '@/modules/report/report.routes';

  // 報告：狀態查詢與下載。不掛 tenantMonthlyQuota——那是對話輪次額度，
  // 報告的成本已由同租戶單一任務與節數上限守住
  app.use('/api/reports', resolveTenant, requireAuth, tenantRateLimit, reportRouter);
```

- [ ] **Step 6: 串接回合契約**

修改 `server/src/modules/conversation/conversation.types.ts`：

```ts
import type { ReportRef } from '@oa-agent/shared';

export interface TurnResult {
  reply: string;
  status: SessionStatus;
  values: FormValues;
  submission?: SubmissionInfo;
  suggestions: string[];
  /** 本回合啟動的報告（僅 report 服務會帶） */
  report?: ReportRef;
}
```

修改 `server/src/modules/conversation/conversation.service.ts`：`runTurn` 取得 `AgentTurnResult` 後，組 `TurnResult` 時把 `report` 帶上：

```ts
      ...(turn.report ? { report: turn.report } : {}),
```

修改 `server/src/modules/conversation/conversation.controller.ts`：`start` 與 `sendMessage` 的 `res.json` 的 `data` 加入：

```ts
        ...(turn?.report ? { report: turn.report } : {}),
```

- [ ] **Step 7: 執行測試確認通過**

Run: `npm test -w server -- report-routes`
Expected: PASS（8 個測試）。

- [ ] **Step 8: 跑全部 server 測試與型別檢查**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS，無型別錯誤。

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/report server/src/app.ts \
  server/src/modules/conversation/conversation.types.ts \
  server/src/modules/conversation/conversation.service.ts \
  server/src/modules/conversation/conversation.controller.ts \
  server/tests/report-routes.test.ts
git commit -m "feat(report): 新增報告狀態與下載 API 並串接對話回合契約"
```

---

### Task 9: 前端狀態區塊與下載連結

對話收到 `report` 後顯示進度，完成後列出下載連結。

**Files:**
- Modify: `client/src/api.ts`（`TurnData.report`、`fetchReport`、`downloadReport`）
- Create: `client/src/ReportStatus.tsx`
- Modify: `client/src/App.tsx`（渲染 `ReportStatus`）
- Modify: `client/src/i18n.ts`（新增字串）
- Test: `client/src/ReportStatus.test.tsx`

**Interfaces:**
- Consumes: Task 8 的 `GET /api/reports/:id`、`GET /api/reports/:id/download?format=`；`ReportRef`（`@oa-agent/shared`）
- Produces:
  - `ReportData { id; status; topic?; doneSections; totalSections?; formats: string[]; error? }`
  - `fetchReport(id: string): Promise<ReportData>`
  - `downloadReport(id: string, format: string): Promise<void>`
  - `<ReportStatus reportId={string} />`

- [ ] **Step 1: 寫失敗的測試**

`client/src/ReportStatus.test.tsx`：

```tsx
/**
 * 報告狀態區塊：輪詢進度、完成後依後端回傳的 formats 渲染下載連結（不得寫死格式）。
 * client 的測試 runner 是 vitest（見 client/vitest.config.ts），非 jest。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReportStatus } from './ReportStatus';
import * as api from './api';

vi.mock('./api', async () => ({
  ...(await vi.importActual<typeof api>('./api')),
  fetchReport: vi.fn(),
}));

const fetchReport = vi.mocked(api.fetchReport);

afterEach(() => vi.clearAllMocks());

describe('ReportStatus', () => {
  it('進行中顯示進度', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'composing',
      doneSections: 2,
      totalSections: 5,
      formats: [],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/2\s*\/\s*5/)).toBeInTheDocument());
  });

  it('完成後依 formats 渲染下載鈕，未回傳的格式不出現', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 3,
      totalSections: 3,
      formats: ['md', 'html'],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /html/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pdf/i })).toBeNull();
  });

  it('後端只回一種格式時就只顯示一個下載鈕', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 1,
      totalSections: 1,
      formats: ['md'],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /html/i })).toBeNull();
  });

  it('empty 顯示查無資料且不給下載鈕', async () => {
    fetchReport.mockResolvedValue({ id: 'r1', status: 'empty', doneSections: 2, formats: [] });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/查無/)).toBeInTheDocument());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed 顯示失敗訊息', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'failed',
      doneSections: 0,
      formats: [],
      error: '報告大綱解析失敗',
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/失敗/)).toBeInTheDocument());
  });

  it('終態後停止輪詢', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 1,
      totalSections: 1,
      formats: ['md'],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
    const callsAfterDone = fetchReport.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchReport.mock.calls.length).toBe(callsAfterDone);
  }, 10_000);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w client -- ReportStatus`
Expected: FAIL，找不到 `./ReportStatus`。

- [ ] **Step 3: 擴充 api.ts**

修改 `client/src/api.ts`：

```ts
import type { ReportRef } from '@oa-agent/shared';

export type { ReportRef };

export interface ReportData {
  id: string;
  status: 'queued' | 'outlining' | 'composing' | 'done' | 'empty' | 'failed';
  topic?: string;
  doneSections: number;
  totalSections?: number;
  /** 後端登錄表決定的可下載格式；前端不得自行寫死清單 */
  formats: string[];
  error?: string;
}

// request<T> 是 api.ts 內既有的私有輔助函式（自動帶 access token、401 時 refresh 重試），
// 已回傳 unwrap 後的 data，因此這裡直接回傳它的結果
export async function fetchReport(id: string): Promise<ReportData> {
  return request<ReportData>(`/api/reports/${id}`);
}

/**
 * 下載報告。
 *
 * 不能用 <a href="/api/reports/..."> 直接連——瀏覽器的一般導覽不會帶 Authorization header，
 * 而該路由掛了 requireAuth，點下去只會拿到 401。因此改為帶 token 取回 blob 後觸發下載。
 */
export async function downloadReport(id: string, format: string): Promise<void> {
  const res = await fetch(
    `/api/reports/${id}/download?format=${encodeURIComponent(format)}`,
    withAuth({}),
  );
  if (!res.ok) throw new Error(`report ${id} 下載失敗`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${id}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
```

> `withAuth` 為 `api.ts` 內既有的私有輔助函式（把 access token 併進 `RequestInit`）。此處刻意不走 `request<T>`——那個函式會把回應當 JSON 解開，報告是檔案內容。

並於 `TurnData` 加入：

```ts
  /** 本回合啟動的報告（僅報告服務會帶） */
  report?: ReportRef;
```

- [ ] **Step 4: 實作 ReportStatus 元件**

`client/src/ReportStatus.tsx`：

```tsx
/**
 * 報告狀態區塊：輪詢後端 job 狀態，完成後列出下載連結。
 *
 * 下載連結一律依後端回傳的 formats 渲染——寫死 ['md','html'] 會讓之後後端新增格式時
 * 前端悄悄漏掉。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadReport, fetchReport, type ReportData } from './api';

const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'empty', 'failed']);

export function ReportStatus({ reportId }: { reportId: string }): JSX.Element {
  const { t } = useTranslation();
  const [data, setData] = useState<ReportData | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchReport(reportId);
        if (cancelled) return;
        setData(next);
        // 終態即停止輪詢，避免對已完成的報告持續打 API
        if (!TERMINAL.has(next.status)) timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reportId]);

  if (!data) return <div className="report-status">{t('report.starting')}</div>;

  if (data.status === 'failed') {
    return <div className="report-status report-status--error">{t('report.failed')}</div>;
  }
  if (data.status === 'empty') {
    return <div className="report-status">{t('report.empty')}</div>;
  }
  if (data.status === 'done') {
    return (
      <div className="report-status">
        <span>{t('report.ready')}</span>
        {data.formats.map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => void downloadReport(data.id, format)}
          >
            {format.toUpperCase()}
          </button>
        ))}
      </div>
    );
  }

  const progress =
    data.totalSections === undefined
      ? t('report.outlining')
      : `${data.doneSections} / ${data.totalSections}`;
  return <div className="report-status">{`${t('report.working')} ${progress}`}</div>;
}
```

- [ ] **Step 5: 新增 i18n 字串**

`client/src/i18n.ts` 用 i18next 的巢狀字典（`const zhHant = { common: {...}, datePicker: {...} }`），
元件以 `t('report.starting')` 取用即對應 `report` 這一層。於 `zhHant` 加入：

```ts
  report: {
    starting: "報告產生中…",
    working: "報告產生中",
    outlining: "規劃大綱中…",
    ready: "報告完成，下載：",
    empty: "知識庫查無相關資料，未產生報告。",
    failed: "報告產生失敗，請稍後再試。",
  },
```

於同檔的英文字典加入：

```ts
  report: {
    starting: "Generating report…",
    working: "Generating report",
    outlining: "Planning outline…",
    ready: "Report ready. Download:",
    empty: "No relevant information in the knowledge base; no report generated.",
    failed: "Report generation failed. Please try again later.",
  },
```

> 引號風格沿用該檔既有的雙引號。

- [ ] **Step 6: 在 App 中渲染**

修改 `client/src/App.tsx`：保存最近一次回合帶回的 `report.id`（例如 `const [reportId, setReportId] = useState<string | null>(null)`，於送出訊息取得 `TurnData` 後 `if (data.report) setReportId(data.report.id)`），並在訊息串下方渲染：

```tsx
{reportId && <ReportStatus reportId={reportId} />}
```

- [ ] **Step 7: 執行測試確認通過**

Run: `npm test -w client -- ReportStatus`
Expected: PASS（6 個測試）。

- [ ] **Step 8: Commit**

```bash
git add client/src/ReportStatus.tsx client/src/ReportStatus.test.tsx client/src/api.ts \
  client/src/App.tsx client/src/i18n.ts
git commit -m "feat(report): 前端顯示報告進度與依後端格式清單的下載連結"
```

---

### Task 10: 文件與全域驗證

補上部署前置與使用說明，並跑一次完整驗證。

**Files:**
- Modify: `README.md`（API 表格、scope 說明、報告章節）
- Modify: `DEPLOY.zeabur.md`（DDL 前置條件加上 `0007_report_docs.sql`）

**Interfaces:**
- Consumes: 前九個任務的全部產出
- Produces: 無程式介面

- [ ] **Step 1: 更新 README**

在 API 表格加入兩列：

```markdown
| GET    | `/api/reports/:id`                        | 查報告產生進度與可下載格式                                  |
| GET    | `/api/reports/:id/download?format=md`     | 下載報告（`format` 由後端登錄表決定，目前為 `md` / `html`） |
```

並新增一節說明：報告由對話觸發（需 `service:report` scope）、LLM 拆大綱後逐節檢索知識庫、非同步產生、產出物保存 `REPORT_TTL_HOURS` 小時；內容全部來自 RAG 檢索結果，查無資料的章節會據實標示。列出三個新環境變數 `REPORT_MAX_SECTIONS` / `REPORT_SECTION_TOP_K` / `REPORT_TTL_HOURS` 與預設值。

- [ ] **Step 2: 更新部署文件**

在 `DEPLOY.zeabur.md` 既有的 DDL 前置條件清單加入 `server/db/migrations/0007_report_docs.sql`，並註明未套用時 `DATA_BACKEND=db` 的報告下載會在重啟後失效。

- [ ] **Step 3: 全域驗證**

Run: `npm run typecheck && npm test && npm run lint`
Expected: 全數通過。

- [ ] **Step 4: Commit**

```bash
git add README.md DEPLOY.zeabur.md
git commit -m "docs(report): 補上報告 API、scope、環境變數與 DDL 前置條件"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章節 | 對應任務 |
|---|---|
| 資料模型（ReportDoc / ReportJob / empty 終態） | Task 1、Task 6 |
| 產生流程（主題抽取 → 大綱 → 逐節 → render → store） | Task 3、4、6、7 |
| 主題抽取不 fail-open | Task 7 Step 1（兩條測試）、Step 6 |
| 大綱（JSON 容錯、節數上限、query 非標題複製） | Task 3 |
| 逐節彙整（零命中不呼叫 LLM、不共享脈絡） | Task 4 |
| 證據紀律（零命中保留標題、來源清單、全零命中 → empty） | Task 1（renderer）、Task 6（empty） |
| 失敗處理表全部五列 | Task 3（大綱 fail-fast）、Task 4（檢索/彙整降級）、Task 6（409）、Task 8（404） |
| 產出物與下載（(reportId, format) key、async get、TTL、DDL、RLS） | Task 5 |
| 路由與中介層（不掛 tenantMonthlyQuota） | Task 8 |
| HTML 渲染（零外部資源、escape） | Task 2 |
| 輸出格式擴充點（登錄表、契約測試、formats 回傳） | Task 1、2、8、9 |
| 對話與前端契約（ReportRef、report 欄位、前端不寫死格式） | Task 7、8、9 |
| 服務註冊與授權（獨立 scope、意圖區隔） | Task 7 |
| 成本（每次呼叫記 usage） | Task 3、4、7 皆含 `recordLLMUsage` |
| 設定（三個 env） | Task 3、4、5 |
| 測試清單 | 各任務 Step 1 |

無未覆蓋項目。

**2. Placeholder scan**

已檢查：無 TBD / TODO / 「類似 Task N」/ 「加上適當的錯誤處理」。每個程式步驟都有完整程式碼。兩處刻意標註「沿用該檔既有寫法」（`withAuth` 私有輔助函式、i18n 字典的引號風格），是對既有程式碼風格的對齊指示，非待填空白。

**4. 對既有介面的查核（撰寫計畫時實際讀過原始碼）**

- `LLMResult` 必填 `stopReason` / `model` / `keySource`、`LLMProvider` 必填 `name` — 測試的假 provider 已補齊，不用 `as unknown as` 硬轉。
- 伺服器測試取 token 一律打 `POST /api/auth/login`（沿用 `e2e-leave-happy-path.test.ts`）；JWT 的 `sub` 就是 username，故登入 `kevin` 後 API 解析出的 userId 為 `'kevin'`。
- client 的測試 runner 是 **vitest** 而非 jest（`client/vitest.config.ts`），故用 `vi.mock` / `vi.mocked`。
- `client/src/i18n.ts` 是 i18next 巢狀字典，元件用 `useTranslation()` 取 `t`，沒有可直接 import 的 `t`。
- `client/src/api.ts` 的帶 token 請求輔助函式是私有的 `request<T>`（已 unwrap JSON），檔案下載不能走它。
- **下載必須帶 JWT**：`/api/reports` 掛了 `requireAuth`，而 `<a href>` 的一般導覽不會帶 Authorization header，直接連只會拿到 401。因此前端改為 fetch 取 blob 後觸發下載（Task 9）。

**3. Type consistency**

- `ReportSection.hits` 於 Task 1 定義，Task 4 產出、Task 6 判斷 `empty`、Task 1/2 renderer 消費——一致。
- `ReportRenderer.format` 同時是儲存 key 與副檔名，Task 5 `save({ format })`、Task 8 `renderers[format].contentType` 一致。
- `reportStore.get` 全程 async，Task 8 controller 以 `await` 呼叫。
- `startReportJob` 的 `deps` 參數型別 `ReportJobDeps` 於 Task 6 定義，Task 6 測試使用，Task 7 正式呼叫時不帶 deps。
- `ReportRef` 於 shared 定義（Task 7），server 的 `AgentTurnResult` / `TurnResult` 與 client 的 `TurnData` 共用同一型別。
- `emptySectionText` / `degradedNoticeText` / `sourcesHeading` / `dedupeSources` 由 Task 1 的 `report.strings.ts` export，markdown.ts 與 html.ts 各自 import——兩個 renderer 之間無依賴。
