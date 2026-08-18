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
import { listTableCatalog, loadTable, type TableCatalogEntry } from '@/modules/knowledge/knowledge.tables.repo';
import type { OutlineSection, ReportSection, SectionChart, SectionSource } from './report.types';

function sectionSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You write ONE section of a knowledge-base report. Respond entirely in English.',
      'Rules:',
      '- Use ONLY the reference material below; for anything not covered, say "Not mentioned in the materials." Never fabricate.',
      '- Write the body of this section only. Do NOT repeat the section heading.',
      '- Do NOT write conclusions, summaries, or transitions to other sections.',
      '- Output Markdown. Sub-headings, if any, MUST start at level 3 (###) — the section heading is already level 2.',
      '- Cite sources inline as (Source: title) where helpful.',
      'Chart from structured tables (PREFERRED when a table fits):',
      '- The tables listed under "Available tables" hold the original spreadsheet rows.',
      '- If one answers this section, append a block naming the table and the two columns:',
      '  ```chart-ref',
      '  {"table":"<id>","label":"<column>","value":"<column>","title":"...","unit":"..."}',
      '  ```',
      '- Column names MUST match the listed 欄位 exactly. Never put numbers in this block —',
      '  the values are read from the table itself.',
      'Chart from excerpts (fallback, strict):',
      `- ONLY if the reference material itself is a comparable series — at least ${MIN_CHART_POINTS} items of the SAME kind, each with a number — append one fenced block after the body:`,
      '  ```chart',
      '  {"title":"...","unit":"...","points":[{"label":"...","value":123}]}',
      '  ```',
      '- Every value MUST appear verbatim in the material. Never estimate, interpolate, or total.',
      '- Mixed units, single values, or narrative material: omit the block entirely.',
    ].join('\n');
  }
  return [
    '你負責撰寫知識庫報告的「其中一節」，全程使用繁體中文。',
    '規則：',
    '- 只根據下方「參考資料」撰寫；資料未提到的部分明說「資料中未提及」，切勿杜撰。',
    '- 只寫這一節的內文，不要重複章節標題。',
    '- 不要寫結論、總結或銜接其他章節的過渡句（章節銜接由排版負責）。',
    '- 以 Markdown 輸出。若要分小節，標題一律從第三級（###）起跳——章節標題本身已經是第二級。',
    '- 必要時於句末以（來源：標題）標註引用。',
    '圖表——優先使用結構化表：',
    '- 「可用資料表」列出的是試算表的原始資料列。',
    '- 若其中一張能回答本節，附上一個區塊，指名該表與要用的兩個欄位：',
    '  ```chart-ref',
    '  {"table":"<id>","label":"<欄位名>","value":"<欄位名>","title":"標題","unit":"人數"}',
    '  ```',
    '- 欄位名必須與清單中的「欄位」完全一致。**這個區塊裡不要放任何數字**——',
    '  數值由系統直接從該表讀出，你只負責挑表與挑欄位。',
    '圖表——沒有合適的表時（選用，條件嚴格）：',
    `- 唯有參考資料本身就是一組可比較的數列——至少 ${MIN_CHART_POINTS} 個同類項目、各自帶一個數值——才在內文之後附上一個區塊：`,
    '  ```chart',
    '  {"title":"標題","unit":"人數","points":[{"label":"項目","value":123}]}',
    '  ```',
    '- 每個數值都必須在參考資料中原樣出現，嚴禁估算、內插或自行加總。',
    '- 單位不一致、只有單一數值、或材料是敘述性文字時，一律不要附這個區塊。',
  ].join('\n');
}

/**
 * 圖表的下限與上限。
 *
 * 下限 3：兩個點畫成長條圖沒有比一句話多說什麼，只是把版面撐大。
 * 上限 12：每節只餵 top-k 個片段（預設 5），若模型吐出幾十個點，那些數字多半不是從材料
 * 讀來的而是編的——與其畫出一張看似完整的圖，不如整個丟掉。
 */
const MIN_CHART_POINTS = 3;
const MAX_CHART_POINTS = 12;

/** 從內文尾端抽出 ```chart 區塊，回傳去掉該區塊的內文與（驗證過的）圖表 */
export function extractChart(raw: string): { body: string; chart?: SectionChart } {
  const match = /```chart\s*\n([\s\S]*?)```/.exec(raw);
  if (!match) return { body: raw.trim() };
  const body = raw.replace(match[0], '').trim();

  // 解析或驗證失敗一律只丟掉圖表、保留散文：圖表是加分項，不值得讓整節降級
  try {
    const parsed = JSON.parse(match[1]) as Partial<SectionChart>;
    const points = Array.isArray(parsed.points) ? parsed.points : [];
    const clean = points.filter(
      (pt): pt is { label: string; value: number } =>
        typeof pt?.label === 'string' && pt.label.trim() !== '' && Number.isFinite(pt?.value),
    );
    if (clean.length < MIN_CHART_POINTS || clean.length > MAX_CHART_POINTS) return { body };
    if (typeof parsed.title !== 'string' || parsed.title.trim() === '') return { body };
    return {
      body,
      chart: {
        complete: false, // LLM 從檢索片段讀出的節錄
        title: parsed.title.trim(),
        ...(typeof parsed.unit === 'string' && parsed.unit.trim() !== '' ? { unit: parsed.unit.trim() } : {}),
        points: clean.map((pt) => ({ label: pt.label.trim(), value: pt.value })),
      },
    };
  } catch {
    return { body };
  }
}

/** 精確圖表最多畫幾條：超過就只取前幾名，說明文字會標出「共 N 列中的前 M 筆」 */
const MAX_EXACT_POINTS = 12;

/** LLM 對結構化表的挑選結果；數字不經它的手 */
interface ChartRef {
  table: string;
  label: string;
  value: string;
  title?: string;
  unit?: string;
}

/**
 * 每節最多列出幾張表。
 *
 * 這批資料有 165 張子表、整份目錄約 10k token，而目錄是**每一節都要送一次**的——
 * 六節就是六萬 token 的純清單，既貴，又讓模型在雜訊裡找針。先用查詢句篩過再送。
 */
const CATALOG_LIMIT = 20;

/**
 * 依查詢句挑出最可能相關的表。以字元 bigram 重疊度計分——中文沒有空白可切詞，
 * 而表名與橫幅（「參觀者預登國家數」「展覽年度:2025」）本來就是短字串，
 * bigram 足以把「問各國人數」對到「預登國家數」而不需要斷詞器或額外的 embedding 呼叫。
 */
export function selectCatalog(
  catalog: TableCatalogEntry[],
  query: string,
  limit = CATALOG_LIMIT,
): TableCatalogEntry[] {
  if (catalog.length <= limit) return catalog;
  const grams = (t: string): Set<string> => {
    const clean = t.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
    return out;
  };
  const q = grams(query);
  return [...catalog]
    .map((t) => {
      const text = grams(`${t.source}${t.sheet}${t.caption ?? ''}${t.headers.join('')}`);
      let hit = 0;
      for (const g of q) if (text.has(g)) hit += 1;
      return { t, hit };
    })
    .sort((a, b) => b.hit - a.hit)
    .slice(0, limit)
    .map((x) => x.t);
}

/** 目錄摘要：只給表的「形狀」，不給資料列——幾千列塞進 prompt 既貴又沒必要 */
function catalogPrompt(catalog: TableCatalogEntry[]): string {
  return catalog
    .map((t) => {
      const cap = t.caption ? `（${t.caption}）` : '';
      return `- id=${t.id} | ${t.source} / ${t.sheet}${cap} | 欄位：${t.headers.join('、')} | ${t.rowCount} 列`;
    })
    .join('\n');
}

/**
 * 合計列的標籤。這類列與它的組成項不是同一個層級——畫在一起等於把總和當成一個「項目」，
 * 既重複計算，那條長條又會把其他項壓成看不出差異的細線。
 *
 * 這是啟發式判斷，只認常見寫法；漏掉的頂多多一條長條，誤判的風險則靠「完全相符」
 * 而非包含比對來壓低（「總數」會排除，「總數統計區」不會）。
 */
const TOTAL_LABELS = new Set([
  '總數', '總計', '合計', '小計', '總和', '全部',
  'total', 'Total', 'TOTAL', 'sum', 'Sum', 'subtotal', 'Subtotal', 'all', 'All',
]);

/** 把 "1,234" "12%" 這類字串轉成數字；轉不出來回 null（該列略過而非當成 0） */
export function parseCellNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '').replace(/%$/, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 依 LLM 的挑選，從結構化表算出圖表。**數值全部由此處讀出，LLM 只負責挑表與欄位。**
 *
 * 這是 B 案的重點：讓模型做它擅長的（理解「這一節在問各國人數」對應到哪張表的哪兩欄），
 * 讓程式做它可靠的（把數字原樣讀出來）。轉述失真與 top-k 不完整兩個問題一起消失。
 */
export async function buildExactChart(
  tenantId: string,
  ref: ChartRef,
): Promise<SectionChart | undefined> {
  const table = await loadTable(tenantId, ref.table);
  if (!table) return undefined;

  const li = table.headers.indexOf(ref.label);
  const vi = table.headers.indexOf(ref.value);
  if (li < 0 || vi < 0 || li === vi) return undefined;

  const points: { label: string; value: number }[] = [];
  for (const row of table.rows) {
    const label = (row[li] ?? '').trim();
    const value = parseCellNumber(row[vi] ?? '');
    // 標籤空白或數值不可解析的列直接略過：那多半是小計列或排版列，
    // 當成 0 畫進去會在圖上憑空生出一條不存在的資料
    if (label === '' || value === null) continue;
    if (TOTAL_LABELS.has(label)) continue; // 合計列不是資料點
    points.push({ label, value });
  }
  if (points.length < MIN_CHART_POINTS) return undefined;

  const totalRows = points.length;
  const top = [...points].sort((a, b) => b.value - a.value).slice(0, MAX_EXACT_POINTS);
  const where = `${table.source} / ${table.sheet}${table.caption ? `（${table.caption}）` : ''}`;
  return {
    complete: true,
    title: ref.title?.trim() || `${table.sheet}`,
    ...(ref.unit?.trim() ? { unit: ref.unit.trim() } : {}),
    points: top,
    sourceLabel: where,
    totalRows,
  };
}

/** 從內文尾端抽出 ```chart-ref 區塊（LLM 挑表），回傳去掉該區塊的內文與挑選結果 */
export function extractChartRef(raw: string): { body: string; ref?: ChartRef } {
  const match = /```chart-ref\s*\n([\s\S]*?)```/.exec(raw);
  if (!match) return { body: raw.trim() };
  const body = raw.replace(match[0], '').trim();
  try {
    const parsed = JSON.parse(match[1]) as Partial<ChartRef>;
    if (typeof parsed.table !== 'string' || typeof parsed.label !== 'string' || typeof parsed.value !== 'string') {
      return { body };
    }
    return { body, ref: parsed as ChartRef };
  } catch {
    return { body };
  }
}

/** 彙整失敗時的降級內文：直接列出片段（比照知識庫問答的 fallbackReply，依語系加前綴） */
function fallbackBody(chunks: KnowledgeChunk[], locale?: string): string {
  const prefix = normalizeLocale(locale) === 'en'
    ? 'Based on available information:'
    : '依現有資料：';
  return `${prefix}\n${chunks.map((c) => `・${c.title}：${c.content}`).join('\n')}`;
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

  // 目錄查詢失敗不得中斷該節：沒有目錄就退回「只用檢索片段」的舊行為
  let catalog: TableCatalogEntry[] = [];
  try {
    catalog = await listTableCatalog(tenantId);
  } catch (err) {
    logger.warn({ err, tenantId }, 'table catalog lookup failed; section falls back to excerpts only');
  }
  const shortlist = selectCatalog(catalog, `${section.heading}${section.query}`);
  const catalogBlock = shortlist.length > 0 ? `\n\n可用資料表：\n${catalogPrompt(shortlist)}` : '';

  try {
    const result = await llm.createMessage({
      system: sectionSystem(locale),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `章節標題：${section.heading}\n\n參考資料：\n${context}${catalogBlock}\n\n本節要回答：${section.query}`,
            },
          ],
        },
      ],
      cache: true,
      maxTokens: 1200,
    });
    usageStore.recordLLMUsage(tenantId, result);

    /*
     * chart-ref 優先於 inline chart：前者的數字由程式從完整資料列讀出，後者是 LLM 的轉述。
     * 兩者都在時取前者——沒有理由拿節錄去蓋掉精確值。
     */
    const refOut = extractChartRef(result.text ?? '');
    let exact: SectionChart | undefined;
    if (refOut.ref) {
      try {
        exact = await buildExactChart(tenantId, refOut.ref);
      } catch (err) {
        logger.warn({ err, tenantId, table: refOut.ref.table }, 'exact chart build failed');
      }
    }
    const { body, chart: inline } = extractChart(refOut.body);
    const chart = exact ?? inline;
    if (body === '') {
      return { ...base, body: fallbackBody(chunks, locale), sources: toSources(chunks), hits: chunks.length, degraded: true };
    }
    return {
      ...base,
      body,
      sources: toSources(chunks),
      hits: chunks.length,
      ...(chart ? { chart } : {}),
    };
  } catch (err) {
    logger.warn({ err, tenantId, heading: section.heading }, 'report section synthesis failed');
    return {
      ...base,
      body: fallbackBody(chunks, locale),
      sources: toSources(chunks),
      hits: chunks.length,
      degraded: true,
    };
  }
}
