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
      'Chart (optional, strict):',
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
    '圖表（選用，條件嚴格）：',
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
        title: parsed.title.trim(),
        ...(typeof parsed.unit === 'string' && parsed.unit.trim() !== '' ? { unit: parsed.unit.trim() } : {}),
        points: clean.map((pt) => ({ label: pt.label.trim(), value: pt.value })),
      },
    };
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
    const { body, chart } = extractChart(result.text ?? '');
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
