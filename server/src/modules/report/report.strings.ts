/**
 * 報告的共用文案與來源整併規則，各輸出格式共用。
 *
 * 不放在任何一個 renderer 裡：這些是報告本身的性質（查無資料怎麼說、來源怎麼去重），
 * 不是某種格式的性質。放進 markdown.ts 會讓 html.ts 反向依賴 markdown.ts。
 */
import { env } from '@/config/env';
import { normalizeLocale } from '@/lib/locale';
import type { ReportSection, SectionChart, SectionSource } from './report.types';

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
/**
 * 圖表底下的說明，**兩個 renderer 都必須印**。
 *
 * 圖表的數值來自 top-k 檢索片段，必然是節錄。少了這句，一張長條圖看起來就像完整分布——
 * 這是圖表相對於散文特別危險的地方：散文會說「根據檢索到的資料」，圖表不會自己聲明範圍。
 */
export function chartCaptionText(locale: string, points: number, hits: number): string {
  const en = normalizeLocale(locale) === 'en';
  const detail = excerptDetail(locale, points, hits);
  return en ? `${detail} — ${captionSuffix(locale, false)}` : `${detail}，${captionSuffix(locale, false)}`;
}

/**
 * 可信度標記：一眼可辨的等級，HTML renderer 把它做成圖表旁的憑證標籤。
 *
 * 這份報告的主題其實是「這些數字可不可信」——每一張圖都得交代它是原始資料還是節錄。
 * 把那件事從灰色小字提升成看得見的標記，是這份版面唯一刻意張揚的地方。
 */
export function captionTag(locale: string, complete: boolean): string {
  if (normalizeLocale(locale) === 'en') return complete ? 'From source' : 'Excerpt';
  return complete ? '原始資料' : '節錄';
}

/** 可信度的完整句尾：flat 版說明（md / docx / xlsx）用它把 detail 收成一句話 */
export function captionSuffix(locale: string, complete: boolean): string {
  if (normalizeLocale(locale) === 'en') {
    return complete ? 'read directly from the source.' : 'a sample, not the full data set.';
  }
  return complete ? '數值直接讀自原始資料。' : '屬節錄而非完整母體。';
}

/** 節錄圖的細節：可回頭核對的範圍描述，不含可信度的評語 */
export function excerptDetail(locale: string, points: number, hits: number): string {
  return normalizeLocale(locale) === 'en'
    ? `${points} data points drawn from ${hits} retrieved excerpts`
    : `依 ${hits} 個檢索片段整理出的 ${points} 筆資料`;
}

/**
 * 精確圖表的說明：數字來自結構化表的完整資料列，由程式讀出、未經 LLM 轉述。
 * 與 chartCaptionText 分成兩句而非共用一句：兩者的可信度差很多，
 * 讀者必須看得出手上這張圖是哪一種。
 */
export function exactChartCaptionText(locale: string, chart: SectionChart): string {
  const detail = exactDetail(locale, chart);
  return normalizeLocale(locale) === 'en'
    ? `${detail}, ${captionSuffix(locale, true)}`
    : `${detail}，${captionSuffix(locale, true)}`;
}

/** 精確圖的細節：取自哪一張表的哪個範圍。可信度的評語由 captionSuffix 接手 */
export function exactDetail(locale: string, chart: SectionChart): string {
  const points = chart.points.length;
  const totalRows = chart.totalRows ?? points;
  const sourceLabel = chart.sourceLabel ?? '';
  const kind = chart.kind;
  /*
   * 切片型的每一片是一個**欄**、全部取自同一列，「共 N 列」的講法會誤導。
   * 圖上的數字沒錯不代表描述它的句子可以將就。
   */
  if (chart.sliced) {
    return normalizeLocale(locale) === 'en'
      ? `${points} columns from the "${chart.sliced}" row of ${sourceLabel}`
      : `取自 ${sourceLabel} 的「${chart.sliced}」一列共 ${points} 個項目`;
  }
  const partial = points < totalRows;
  /*
   * 節錄的方式因類型而異，說法必須跟著變：長條與圓餅依數值遞減取「前 N 筆」，
   * 折線依年份遞增取**最後** N 筆（也就是最近的 N 年）。兩者都寫成「前 N 筆」的話，
   * 一張 2014–2025 的折線會被說成「16 列中的前 12 筆」——那是不實的描述。
   */
  const recent = kind === 'line';
  if (normalizeLocale(locale) === 'en') {
    if (!partial) return `All ${totalRows} rows from ${sourceLabel}`;
    return recent
      ? `Most recent ${points} of ${totalRows} rows from ${sourceLabel}`
      : `Top ${points} of ${totalRows} rows from ${sourceLabel}`;
  }
  if (!partial) return `取自 ${sourceLabel} 全部 ${totalRows} 列`;
  return recent
    ? `取自 ${sourceLabel} 共 ${totalRows} 列中最近的 ${points} 筆`
    : `取自 ${sourceLabel} 共 ${totalRows} 列中的前 ${points} 筆`;
}

/**
 * xlsx 的字串。
 *
 * 試算表裡沒有散文的位置，所以工作表裝的是「圖表背後的數據」：一張章節總表，
 * 加上每張圖各一個工作表。表頭與工作表名同樣要跟著語系走。
 */
/** 報告開頭的兩個導覽區塊。長報告需要「一眼全貌」與「跳著讀」的入口 */
export function highlightsHeading(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Key figures' : '重點數字';
}

export function tocHeading(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Contents' : '目錄';
}

/**
 * 重點數字的註腳：這個數字在該圖裡是什麼位置。
 *
 * 時間序列看的是最新一期，其餘看的是最大值——標錯的話讀者會以為那是總計。
 */
export function highlightNote(locale: string, kind: 'latest' | 'peak', label: string): string {
  if (normalizeLocale(locale) === 'en') return kind === 'latest' ? `Latest: ${label}` : `Highest: ${label}`;
  return kind === 'latest' ? `最新：${label}` : `最高：${label}`;
}

export function sectionsSheetTitle(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Sections' : '章節';
}

export function summaryHeaderRow(locale: string): string[] {
  return normalizeLocale(locale) === 'en'
    ? ['Section', 'Question', 'Hits', 'Chart', 'Sources']
    : ['章節', '本節要回答', '命中片段', '圖表', '來源'];
}

export function chartItemHeader(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Item' : '項目';
}

export function chartValueHeader(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Value' : '數值';
}

export function sourcesHeading(locale: string): string {
  return normalizeLocale(locale) === 'en' ? 'Sources' : '來源';
}

/**
 * 全報告的來源去重：以 title 為準，有連結的那一筆勝出。
 *
 * 原本連 url 一起當鍵，於是同一個檔案「某節帶了連結、某節沒帶」會變成兩筆——
 * 實跑的報告底下就出現兩行 CC匯出.xlsx，一行可點一行不可點。同名不同連結的情況
 * 在這批資料裡不存在（來源就是檔名），而讀者看到重複的來源只會懷疑報告的嚴謹度。
 *
 * 以 Map 保序，讓輸出穩定可快照測試。
 */
export function dedupeSources(sections: ReportSection[]): SectionSource[] {
  const seen = new Map<string, SectionSource>();
  for (const section of sections) {
    for (const source of section.sources) {
      const kept = seen.get(source.title);
      if (kept === undefined) seen.set(source.title, source);
      // 先出現的沒有連結、後來的有，就換成有連結的那一筆：可點的來源比較有用
      else if (!safeUrl(kept.url) && safeUrl(source.url)) seen.set(source.title, source);
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

/**
 * 報告表頭的產生時間：ISO 8601 是給機器看的，報告是給人讀的文件，改成 YYYY-MM-DD HH:mm:ss。
 *
 * 刻意不用伺服器本地時間（`toLocaleString()` 無 timeZone）：正式環境跑在 UTC，會把台北的
 * 09:41 印成 01:41，而少了 Z 之後那串字看起來就是本地時間，比原本的 ISO 更容易誤導。
 * 時區固定由 env.REPORT_TIMEZONE 決定（預設 Asia/Taipei）。
 *
 * 用 formatToParts 而非字串樣板：各 runtime 對 en-CA 一類 locale 的輸出細節不完全一致，
 * 取 part 才能保證欄位順序與補零穩定。hourCycle h23 確保午夜是 00 而不是 24。
 */
export function formatReportTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso; // 解析不了就原樣輸出，不要在報告裡顯示 Invalid Date

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${at('year')}-${at('month')}-${at('day')} ${at('hour')}:${at('minute')}:${at('second')}`;
}
