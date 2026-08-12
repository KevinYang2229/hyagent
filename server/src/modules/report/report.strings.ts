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
      const key = `${source.title}|${source.url || ''}`;
      if (!seen.has(key)) seen.set(key, source);
    }
  }
  return [...seen.values()];
}

/**
 * URL scheme 白名單檢查：只允許 http: / https:，防止 javascript: 等注入。
 * 報告內容來自被爬取的網站與 LLM 輸出，屬不可信輸入。
 * 回傳 undefined 表示 scheme 不合法，renderer 應改為輸出純文字而非連結。
 */
export function safeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
