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
