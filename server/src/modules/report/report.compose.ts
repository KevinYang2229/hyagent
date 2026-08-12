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
    const body = (result.text ?? '').trim();
    if (body === '') {
      return { ...base, body: fallbackBody(chunks, locale), sources: toSources(chunks), hits: chunks.length, degraded: true };
    }
    return { ...base, body, sources: toSources(chunks), hits: chunks.length };
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
