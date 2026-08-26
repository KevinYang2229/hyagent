/**
 * 報告大綱生成：主題 → 章節清單（每節帶一句可獨立檢索的查詢）。
 *
 * 失敗一律 fail-fast，不像知識庫問答的指代改寫可以退回原句——沒有大綱就沒有報告，
 * 沒有東西可以降級成。
 */
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
import { normalizeLocale } from '@/lib/locale';
import { listTableCatalog } from '@/modules/knowledge/knowledge.tables.repo';
import { logger } from '@/lib/logger';
import { usageStore } from '@/modules/usage/usage.store';
import type { Outline, OutlineSection } from './report.types';

function outlineSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You plan the outline of a knowledge-base report. Output JSON only.',
      `Shape: {"title": "...", "sections": [{"heading": "...", "query": "..."}]}`,
      `Produce at most ${env.REPORT_MAX_SECTIONS} sections covering distinct aspects of the topic.`,
      'The user message lists the data tables the knowledge base ACTUALLY holds. Plan only sections',
      'those tables can answer. Do not invent aspects the data does not cover — a section the data',
      'cannot answer renders as "no relevant data" and is worse than having fewer sections.',
      '"query" MUST be a complete, self-contained question used to search the knowledge base —',
      'never a copy of the heading. Output nothing but the JSON.',
    ].join('\n');
  }
  return [
    '你是知識庫報告的大綱規劃器，只輸出 JSON。',
    '格式：{"title": "...", "sections": [{"heading": "...", "query": "..."}]}',
    `最多 ${env.REPORT_MAX_SECTIONS} 節，各節涵蓋主題的不同面向，不得重複。`,
    '使用者訊息會列出知識庫**實際擁有**的資料表。只規劃這些資料答得出來的章節——',
    '資料裡沒有的面向一律不要立節（例如沒有滿意度相關的表，就不要立「滿意度」一節）。',
    '答不出來的章節在報告裡會印成「知識庫查無相關資料」，那比少幾節更糟。',
    '寧可只產出三節紮實的，也不要湊滿上限。',
    '"query" 必須是一句「可獨立理解、能直接拿去檢索」的完整問句，嚴禁只複製標題——',
    '每節是各自去知識庫檢索的，問句寫得夠具體才撈得到那一節需要的材料。',
    '除 JSON 外不要輸出任何文字。',
  ].join('\n');
}

/**
 * 大綱的 token 預算。
 *
 * 原本固定 512，但 prompt 要求「每節寫出可獨立理解、能直接拿去檢索的完整問句」——
 * 六節中文問句加上 JSON 骨架早就超過，輸出被截斷後 extractJson 抓到半截物件，
 * 每次都以「JSON 格式錯誤」收場。錯誤訊息還會把人引去查模型的格式，
 * 真正的原因是預算與 prompt 的要求互相矛盾。
 *
 * 隨節數縮放而非再寫死一個數字：REPORT_MAX_SECTIONS 可設到 12，
 * 任何固定值都會在某個設定下重演同一個 bug。
 */
export function outlineTokenBudget(sections: number): number {
  return Math.max(512, sections * 220 + 200);
}

/** 從模型輸出抓出第一個 JSON 物件（容忍前後綴與 code fence），比照 rerank.ts 的做法 */
function extractJson(text: string, truncated: boolean): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('報告大綱解析失敗：模型未輸出 JSON');
  try {
    return JSON.parse(match[0]);
  } catch {
    // 截斷與「模型真的輸出了壞 JSON」是兩件事，處置方式也不同（調預算 vs 調 prompt）
    throw new Error(
      truncated
        ? '報告大綱解析失敗：輸出被 token 上限截斷（請調高 REPORT_MAX_SECTIONS 對應的預算或減少節數）'
        : '報告大綱解析失敗：JSON 格式錯誤',
    );
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

/**
 * 大綱可見的資料表上限。
 *
 * 這批資料有 165 張子表，全塞進去既貴又是雜訊；而大綱只需要知道「知識庫涵蓋哪些主題」，
 * 不需要逐張的列數與年度。逐年複本（同名工作表 16 份）同名只留一份即可。
 */
const OUTLINE_CATALOG_LIMIT = 40;

/**
 * 知識庫概覽：給大綱規劃器看的「這裡實際有什麼」。
 *
 * 沒有這一段的話，規劃器只拿到「報告主題」四個字就要生出六節，於是憑常識想出
 * 「商品交易與商機媒合」「參展滿意度」這種資料裡根本不存在的面向——實跑一份七節的報告，
 * 有三節是「知識庫查無相關資料」，四成篇幅是空的。
 *
 * 取不到就回空字串：少了這段只是退回原本的行為，不該讓整份報告產不出來。
 *
 * 目錄本身要依 userId 過濾可見性——這段概覽會整段送進大綱規劃器的 prompt，
 * 未標記或無權限的表若被列進去，檔名／欄位名就外洩進 LLM 輸出（見 listTableCatalog 註解）。
 */
async function knowledgeOverview(tenantId: string, userId: string): Promise<string> {
  let catalog;
  try {
    catalog = await listTableCatalog({ tenantId, userId });
  } catch (err) {
    logger.warn({ err, tenantId }, '大綱取不到資料表目錄，改回只看主題規劃');
    return '';
  }
  const bySheet = new Map<string, string[]>();
  for (const entry of catalog) {
    if (!bySheet.has(entry.sheet)) bySheet.set(entry.sheet, entry.headers);
  }
  if (bySheet.size === 0) return '';
  return [...bySheet.entries()]
    .slice(0, OUTLINE_CATALOG_LIMIT)
    .map(([sheet, headers]) => `- ${sheet}｜欄位：${headers.join('、')}`)
    .join('\n');
}

export async function buildOutline(
  tenantId: string,
  userId: string,
  topic: string,
  locale: string | undefined,
  llm: LLMProvider,
): Promise<Outline> {
  const overview = await knowledgeOverview(tenantId, userId);
  const catalogBlock = overview === '' ? '' : `\n\n知識庫實際擁有的資料表：\n${overview}`;
  const result = await llm.createMessage({
    system: outlineSystem(locale),
    messages: [{ role: 'user', content: [{ type: 'text', text: `報告主題：${topic}${catalogBlock}` }] }],
    maxTokens: outlineTokenBudget(env.REPORT_MAX_SECTIONS),
  });
  usageStore.recordLLMUsage(tenantId, result);

  const parsed = extractJson(result.text ?? '', result.stopReason === 'max_tokens') as {
    title?: unknown;
    sections?: unknown;
  };
  const sections = toSections(parsed.sections).slice(0, env.REPORT_MAX_SECTIONS);
  if (sections.length === 0) throw new Error('報告大綱解析失敗：未取得任何章節');

  const title = typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim() : topic;
  return { title, sections };
}
