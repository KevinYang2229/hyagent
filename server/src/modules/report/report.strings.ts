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

/** ATX 標題行：`## 標題`。setext（底線式）標題 LLM 幾乎不用，刻意不處理。 */
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

/** 章節內文中，標題允許的最淺層級——報告的章節標題本身是 h2，內文必須從 h3 起跳 */
const MIN_BODY_HEADING_LEVEL = 3;

/**
 * 章節內文的正規化。內文是 LLM 產生的 Markdown（與聊天訊息同一慣例，client 用
 * react-markdown 渲染），但模型有兩個穩定的壞習慣，靠 prompt 擋不住：
 *
 * 1. 重複輸出章節標題——prompt 已明寫「不要重複章節標題」，模型照樣輸出。
 * 2. 自己從 `#` 或 `##` 開子標題——與報告章節（h2）同級甚至更高，階層會壞掉。
 *
 * prompt 會漂移，renderer 不會，所以防線放在這裡。兩種輸出格式都需要，故不屬於任一
 * renderer：放進其中一個會讓另一個反向依賴它。
 *
 * 降級採「相對位移」而非一律壓成 h3，保留內文自己的階層關係。
 */
export function normalizeSectionBody(body: string, heading: string): string {
  const lines = body.split('\n');
  const wantedHeading = heading.trim();

  // 逐行掃描時要略過程式碼區塊——裡面的 # 是內容，不是標題
  let inFence = false;
  const headingAt: { index: number; level: number; text: string }[] = [];
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = ATX_HEADING.exec(line);
    if (match) headingAt.push({ index, level: match[1].length, text: match[2].trim() });
  });

  if (headingAt.length === 0) return body.trim();

  // 開頭若是與章節同名的標題就剔除（含其後緊接的空行），避免同一個標題出現兩次
  const first = headingAt[0];
  const onlyBlankBefore = lines.slice(0, first.index).every((l) => l.trim() === '');
  const dropIndex = onlyBlankBefore && first.text === wantedHeading ? first.index : -1;

  const remaining = dropIndex === -1 ? headingAt : headingAt.slice(1);
  const shallowest = remaining.reduce((min, h) => Math.min(min, h.level), 6);
  // 只降不升：內文本來就從 h3 以下開始時維持原樣，不要把它往上拉
  const shift = Math.max(0, MIN_BODY_HEADING_LEVEL - shallowest);

  const shiftByIndex = new Map(remaining.map((h) => [h.index, h]));
  const out = lines
    .filter((_, index) => index !== dropIndex)
    .map((line, indexAfterDrop) => {
      // filter 之後 index 會位移，改用原始索引查表
      const originalIndex = dropIndex !== -1 && indexAfterDrop >= dropIndex ? indexAfterDrop + 1 : indexAfterDrop;
      const found = shiftByIndex.get(originalIndex);
      if (!found || shift === 0) return line;
      const level = Math.min(6, found.level + shift);
      return `${'#'.repeat(level)} ${found.text}`;
    });

  return out.join('\n').trim();
}
