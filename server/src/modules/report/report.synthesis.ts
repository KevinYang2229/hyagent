/**
 * 綜合觀察與建議：整份報告唯一一節有資格下結論的地方。
 *
 * 各節之間刻意不共享脈絡——後面的節帶著前面節的結論走，而那些結論的來源片段已不在
 * 視野內，等於讓模型在無法核對的二手資訊上繼續推論。sectionSystem 也明文禁止各節
 * 寫結論。這兩個決定對「避免幻覺」是對的，代價是整份報告從頭到尾沒有任何一處把
 * 跨檔案的數字讀成一件事。
 *
 * 這一節補上那件事，而且只吃 complete 的圖表資料點：那些數值是程式從原始儲存格讀出來的，
 * 有出處、可回頭核對。餵散文進去等於讓結論長在前面各節的轉述上——某一節寫錯，
 * 總結會把它放大成整份報告的定論。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { normalizeLocale } from '@/lib/locale';
import { usageStore } from '@/modules/usage/usage.store';
import type { ReportSection, SectionChart } from './report.types';

/**
 * 至少要幾張精確圖表才值得寫結論。
 *
 * 一張的話，「綜合」就只是把那一節再講一次——讀者已經看過那張圖與它底下的散文，
 * 再讀一段講同樣數字的文字只會稀釋整份報告的可信度。要有兩組數字才有得比。
 */
const MIN_SYNTHESIS_CHARTS = 2;

/** 這一節的 token 預算：只要一段觀察加幾條建議，不需要長篇 */
const SYNTHESIS_MAX_TOKENS = 800;

function synthesisHeading(locale?: string): string {
  return normalizeLocale(locale) === 'en' ? 'Synthesis and recommendations' : '綜合觀察與建議';
}

function synthesisSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You write the CLOSING section of a knowledge-base report. Respond entirely in English.',
      'The user message lists every chart in the report. Each number was read directly from the',
      'original spreadsheet cells by the system — they are exact, with sources attached.',
      'Rules:',
      '- Use ONLY these numbers. Do not introduce any figure that is not listed.',
      '- Read ACROSS the charts: what do they say together that no single chart says alone?',
      '- A year series may have GAPS (biennial shows). Compare like with like; never assume',
      '  consecutive calendar years.',
      '- Before writing "rose" or "fell", put the two numbers side by side and check the direction.',
      '- Close with 2-4 concrete, actionable recommendations, each tied to a number above.',
      '- If the charts do not support a comparison, say so plainly instead of manufacturing one.',
      '- Output Markdown. Sub-headings, if any, MUST start at level 3 (###).',
      '- Do NOT repeat the section heading, and do NOT re-list the raw numbers as a table.',
    ].join('\n');
  }
  return [
    '你負責撰寫知識庫報告的**最後一節：綜合觀察與建議**，全程使用繁體中文。',
    '使用者訊息列出整份報告的所有圖表。每一個數值都是系統直接從原始試算表儲存格讀出的，',
    '精確、附出處，可以放心引用。',
    '規則：',
    '- **只能使用下方列出的數字**，不得引入任何沒列出的數值。',
    '- 要**橫著讀**：把幾張圖擺在一起看，說出單獨一張圖說不出來的事。',
    '- 年度序列可能不連續（雙年展是 2021、2023、2025）。比較時要比得上同一件事，',
    '  不要假設是連續的自然年。',
    '- 寫「上升」「下滑」之前，先把要比較的那兩個數字並列核對一次。',
    '- 收尾給 2～4 條具體、可執行的建議，每一條都要扣在上面的某個數字上。',
    '- 若這些圖表根本支撐不了比較，就直說，不要硬湊出一個結論。',
    '- 以 Markdown 輸出。若要分小節，標題一律從第三級（###）起跳。',
    '- 不要重複章節標題，也不要把原始數字再列成一張表——讀者上面已經看過了。',
  ].join('\n');
}

/** 一張圖的資料點：分組長條要把各數列都列出來，否則等於只交出第一個數列 */
function chartLine(chart: SectionChart): string {
  const points = chart.points.map((pt) => {
    if (chart.kind === 'grouped' && chart.series?.length && pt.values?.length) {
      const pairs = chart.series.map((s, i) => `${s}:${pt.values?.[i] ?? ''}`).join('/');
      return `${pt.label}=${pairs}`;
    }
    return `${pt.label}=${pt.value}`;
  });
  const unit = chart.unit ? `（單位：${chart.unit}）` : '';
  const where = chart.sourceLabel ? `［出處：${chart.sourceLabel}］` : '';
  return `  - ${chart.title}${unit}${where}\n    ${points.join('、')}`;
}

/**
 * 整份報告可供下結論的數字。
 *
 * 只收 complete 的圖表，而且刻意不含任何一節的散文——這是這一節與其他節最大的差別，
 * 也是它敢下結論的唯一理由。
 */
export function chartFacts(sections: ReportSection[]): string {
  const blocks: string[] = [];
  for (const section of sections) {
    const exact = (section.charts ?? []).filter((c) => c.complete);
    if (exact.length === 0) continue;
    blocks.push([`【${section.heading}】`, ...exact.map(chartLine)].join('\n'));
  }
  return blocks.join('\n');
}

/** 可下結論的精確圖表總數 */
function exactChartCount(sections: ReportSection[]): number {
  return sections.reduce((n, s) => n + (s.charts ?? []).filter((c) => c.complete).length, 0);
}

/**
 * 產生最後一節。條件不足或 LLM 失敗都回 undefined——少一節結論，
 * 前面各節仍然是完整可交付的報告，沒有理由讓整份作廢。
 */
export async function composeSynthesis(
  tenantId: string,
  topic: string,
  sections: ReportSection[],
  locale: string | undefined,
  llm: LLMProvider,
): Promise<ReportSection | undefined> {
  const charts = exactChartCount(sections);
  if (charts < MIN_SYNTHESIS_CHARTS) return undefined;

  const facts = chartFacts(sections);
  try {
    const result = await llm.createMessage({
      system: synthesisSystem(locale),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `報告主題：${topic}\n\n整份報告的圖表數據：\n${facts}` }],
        },
      ],
      cache: true,
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });
    usageStore.recordLLMUsage(tenantId, result);

    const body = (result.text ?? '').trim();
    // 空白內文會渲染成一個只有標題的章節，比沒有這一節更難看
    if (body === '') return undefined;

    return {
      heading: synthesisHeading(locale),
      query: topic,
      body,
      sources: [],
      // hits 供 renderer 判斷「查無資料」；這一節的依據是圖表數量而非檢索命中
      hits: charts,
    };
  } catch (err) {
    logger.warn({ err, tenantId }, '報告綜合建議節產生失敗，其餘章節照常輸出');
    return undefined;
  }
}
