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
import type { KnowledgeChunk, RetrievalPrincipal } from '@/modules/knowledge/retriever.types';
import { usageStore } from '@/modules/usage/usage.store';
import { getEmbeddingProvider } from '@/lib/embedding';
import {
  listTableCatalog,
  loadTable,
  searchTableCatalog,
  type StoredTable,
  type TableCatalogEntry,
} from '@/modules/knowledge/knowledge.tables.repo';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type {
  ChartKind,
  OutlineSection,
  ReportSection,
  SectionChart,
  SectionSource,
} from './report.types';

function sectionSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You write ONE section of a knowledge-base report. Respond entirely in English.',
      'Rules:',
      '- Use ONLY the reference material and the table contents below; for anything not covered, say "Not mentioned in the materials." Never fabricate.',
      '- For any NUMBER, trust "Table contents" over "Reference material": the latter are retrieved excerpts,',
      '  and superlatives drawn from them ("highest", "most") will contradict the chart.',
      '- A year series may have GAPS — some shows are biennial (2021, 2023, 2025). "The last three years"',
      '  means the three MOST RECENT years present in the table, not three consecutive calendar years.',
      '- Before writing "rose", "fell", or "declined year over year", put the two numbers you are comparing',
      '  side by side and check the direction.',
      '- Write the body of this section only. Do NOT repeat the section heading.',
      '- Do NOT write conclusions, summaries, or transitions to other sections.',
      '- Output Markdown. Sub-headings, if any, MUST start at level 3 (###) — the section heading is already level 2.',
      '- Cite sources inline as (Source: title) where helpful.',
      'Chart from structured tables (PREFERRED when a table fits):',
      '- The tables listed under "Available tables" hold the original spreadsheet rows.',
      '- If one answers this section, append a block naming the table and the two columns:',
      '  ```chart-ref',
      '  {"table":"<id>","label":"<column>","value":"<column>","kind":"bar|line|pie|donut","title":"...","unit":"..."}',
      '- When one row holds several comparable numeric columns, give "values":["A","B",...] (max 4) instead',
      '  of "value"; the system renders a grouped bar chart.',
      '- When those columns are the PARTS OF ONE WHOLE for a single row (e.g. visitor sources:',
      '  self-registered / sponsored / self-funded / on-site), give "values" with kind pie or donut —',
      '  the system turns each column into a slice, taking the total row (max 6 slices).',
      '- To compare TWO OR MORE shows/files, give "tables" instead — one series per table:',
      '  {"tables":[{"id":"<id>","series":"Cycle Show"},{"id":"<id>","series":"Machine Tool Show"}],',
      '   "label":"年度","value":"參展總家數","title":"...","unit":"..."}',
      '  The system reads each table separately and aligns them on the label column (max 4 series).',
      '  Only labels present in EVERY table are plotted; a year missing from one side is dropped, never zero-filled.',
      '- If the section discusses ANY comparable numbers, attach a chart. Do not settle for prose.',
      '- Pick kind by intent: bar for magnitude, line for change across years, pie for a few parts of a whole.',
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
    '- 只根據下方「參考資料」與「資料表實際內容」撰寫；未提到的部分明說「資料中未提及」，切勿杜撰。',
    '- **數字一律以「資料表實際內容」為準**：參考資料是檢索片段，只是節錄，'
      + '拿它下「最高」「最多」這類全稱判斷會與圖表互相矛盾。',
    '- **年度序列可能不連續**：有些展覽是雙年展（2021、2023、2025）。「最近三年」指的是'
      + '資料表裡**最新的三個年度**，不是從今年往回推三個自然年，也不是表上任意三列。',
    '- 寫「上升」「下滑」「逐年減少」之前，先把要比較的那兩個數字並列核對一次——'
      + '方向寫反比數字寫錯更難被發現。',
    '- 只寫這一節的內文，不要重複章節標題。',
    '- 不要寫結論、總結或銜接其他章節的過渡句（章節銜接由排版負責）。',
    '- 以 Markdown 輸出。若要分小節，標題一律從第三級（###）起跳——章節標題本身已經是第二級。',
    '- 必要時於句末以（來源：標題）標註引用。',
    '圖表——優先使用結構化表：',
    '- 「可用資料表」列出的是試算表的原始資料列。',
    '- 若其中一張能回答本節，附上一個區塊，指名該表與要用的兩個欄位：',
    '  ```chart-ref',
    '  {"table":"<id>","label":"<欄位名>","value":"<欄位名>","kind":"bar|line|pie|donut","title":"標題","unit":"人數"}',
    '- 若同一列有多個值得並排比較的數值欄（例如「今年預登／今年報到／上屆預登／上屆報到」），',
    '  改給 "values":["欄位A","欄位B",...]（最多 4 個），系統會畫成分組長條；此時 value 可省略。',
    '- 若那幾個欄是**同一列構成一個整體**（例如訪客來源：自行預登／駐外補助／駐外自費／',
    '  廠商申請補助／現場報名），一樣給 "values" 但 kind 用 pie 或 donut——系統會取合計列，',
    '  把每個欄畫成一塊切片（最多 6 塊）。這類構成資料用圓餅遠比長條清楚。',
    '- 若本節要**比較兩個以上的展覽／檔案**，改給 "tables"，每張表一個數列：',
    '  {"tables":[{"id":"<id>","series":"自行車展"},{"id":"<id>","series":"工具機展"}],',
    '   "label":"年度","value":"參展總家數","title":"標題","unit":"家"}',
    '  系統會各自從各表讀值、以 label 欄對齊成同一張分組圖（最多 4 個數列）。',
    '  各表都有的標籤才會畫；某一年只有一邊有（雙年展）就整個略過，不補 0。',
    '  談對比就用這個形式——兩張各自獨立的圖並排，讀者得自己在腦中對齊。',
    '- **只要本節談到任何可比較的數字，就該附圖**；資料表在上面列著，不要只寫文字。',
    '- kind 依這一節在講什麼選：比大小用 bar、隨年度變化用 line、少數幾塊構成整體用 pie。',
    '  選不定就給 bar；donut 與 pie 規則相同，只是中央留白。',
'  系統會依實際資料形狀驗證，不合適會自動改成 bar。',
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

/**
 * 圓餅的下限是 2 而非 3。
 *
 * 「台灣 128／海外 232」這種兩分佔比本來就是圓餅最典型的用法，一律要求 3 點是把
 * 長條的門檻硬套到圓餅上。長條仍維持 3：兩條長條沒有比一句話多說什麼。
 */
function minPointsFor(kind: ChartKind): number {
  return kind === 'pie' || kind === 'donut' ? 2 : MIN_CHART_POINTS;
}

/**
 * 抽出所有 ```<tag> 區塊，回傳「移除全部區塊後的內文」與各區塊的內容。
 *
 * 必須移除**全部**而非第一個：模型常在一節裡吐好幾個區塊（它想畫多張圖），
 * 只移除第一個會讓其餘的原樣留在內文，讀者看到的就是一段裸露的 JSON。
 * 目前一節只採用第一個有效區塊——一節多圖牽涉版面與各自的說明文字，是另一個設計問題。
 *
 * tag 後面要求緊接換行，所以 `chart` 不會誤吃 `chart-ref`（後者接的是 `-`）。
 *
 * 兩個實跑時踩到的漏網情形，兩者都會讓裸 JSON 原樣印給讀者看：
 * - 行尾是 CRLF：`[ \t]*\n` 吃不掉中間的 `\r`。先把行尾正規化成 LF 一次解決。
 * - 區塊沒有閉合的 ```：LLM 輸出被 maxTokens 截斷時就是這樣。收尾那一段照樣要移除——
 *   沒有閉合的區塊在 markdown 裡本來就會把後面全部吃成程式碼區塊，留著只會更糟。
 */
function stripBlocks(raw: string, tag: string): { body: string; payloads: string[] } {
  const text = raw.replace(/\r\n/g, '\n');
  const payloads: string[] = [];
  const take = (_m: string, inner: string): string => {
    payloads.push(inner);
    return '';
  };
  const body = text
    .replace(new RegExp('```' + tag + '[ \\t]*\\n([\\s\\S]*?)```', 'g'), take)
    .replace(new RegExp('```' + tag + '[ \\t]*\\n([\\s\\S]*)$'), take);
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), payloads };
}

/** 抽出 ```chart 區塊（LLM 直接給數值的節錄版）；全部通過驗證的都採用 */
export function extractCharts(raw: string): { body: string; charts: SectionChart[] } {
  const { body, payloads } = stripBlocks(raw, 'chart');
  const charts: SectionChart[] = [];
  for (const payload of payloads) {
    const chart = parseInlineChart(payload);
    if (chart) charts.push(chart);
  }
  return { body, charts: charts.slice(0, MAX_SECTION_CHARTS) };
}

/** 解析單一 inline 圖表區塊；不合格回 undefined */
function parseInlineChart(payload: string): SectionChart | undefined {
  // 解析或驗證失敗一律只丟掉圖表、保留散文：圖表是加分項，不值得讓整節降級
  try {
    const parsed = JSON.parse(payload) as Partial<SectionChart> & { kind?: string };
    const points = Array.isArray(parsed.points) ? parsed.points : [];
    const clean = points.filter(
      (pt): pt is { label: string; value: number } =>
        typeof pt?.label === 'string' && pt.label.trim() !== '' && Number.isFinite(pt?.value),
    );
    if (clean.length > MAX_CHART_POINTS) return undefined;
    if (typeof parsed.title !== 'string' || parsed.title.trim() === '') return undefined;
    const pts = clean.map((pt) => ({ label: pt.label.trim(), value: pt.value }));
    const kind = resolveChartKind(
      typeof parsed.kind === 'string' ? parsed.kind : undefined,
      pts.map((x) => x.label),
      pts.map((x) => x.value),
    );
    if (pts.length < minPointsFor(kind)) return undefined;
    return {
      kind,
      complete: false, // LLM 從檢索片段讀出的節錄
      title: parsed.title.trim(),
      ...(typeof parsed.unit === 'string' && parsed.unit.trim() !== '' ? { unit: parsed.unit.trim() } : {}),
      points: pts,
    };
  } catch {
    return undefined;
  }
}

/** 精確圖表最多畫幾條：超過就只取前幾名，說明文字會標出「共 N 列中的前 M 筆」 */
const MAX_EXACT_POINTS = 12;

/** LLM 對結構化表的挑選結果；數字不經它的手 */
interface ChartRef {
  /**
   * 單表路徑的表 id。跨表對比由 tables 取代，模型不會給這個欄位——
   * 解析時會補上第一張表當代表值，讓去重鍵與「用過哪些表」的記錄有一致的落點。
   */
  table?: string;
  label: string;
  value: string;
  /** grouped 專用：多個數值欄名。給了它就走分組長條，value 忽略 */
  values?: string[];
  /**
   * 跨表對比：每張表貢獻一個數列，全部以 label 欄對齊。
   *
   * 兩個展分屬兩個檔案，而 table 只吃得下一個 id——「對比」這件事因此沒有任何一張圖
   * 表達得出來。數值仍由程式各自從各表的完整資料列讀出，模型只挑表、挑欄位、命名數列。
   */
  tables?: { id: string; series: string }[];
  title?: string;
  unit?: string;
  /** 模型提出的類型；最終仍由 resolveChartKind 依資料形狀決定 */
  kind?: string;
}

/**
 * 一節的圖表上限。
 *
 * 模型常常一次吐好幾個 chart-ref（它想畫多張圖），過去只採用第一個、其餘丟掉——
 * 「訪客來源」那一節同時有五類構成與歷年趨勢，只挑一張等於丟掉一半的資訊。
 * 但也不能全收：一節塞五張圖，讀者會失去「這節在講什麼」的主線。
 */
const MAX_SECTION_CHARTS = 3;

/** 圓餅的扇形上限。超過就分不出角度，長條至少排得出高低 */
const MAX_PIE_SLICES = 6;

/**
 * 分組長條的數列上限。
 *
 * 超過四組之後同一類別下的長條會細到看不出差異，圖例也開始搶版面——
 * 真的需要比較更多維度時，正解是拆成幾張小圖而不是把一張塞爆。
 */
const MAX_SERIES = 4;
/** 分組長條的類別上限：類別 × 數列才是實際的長條數 */
const MAX_GROUPED_CATEGORIES = 8;

/** 年份的字面形式（1900–2099）。欄位判定與標籤判定必須用同一個定義，否則兩處會各說各話 */
const YEAR_CELL = /^(19|20)\d{2}$/;

/** 標籤是否為年份序列——折線只在時間序列上成立 */
function looksLikeYears(labels: string[]): boolean {
  const years = labels.filter((l) => YEAR_CELL.test(l.trim()));
  return years.length === labels.length && new Set(years).size === labels.length;
}

/**
 * 決定最終圖表類型：模型的提議 + 資料形狀的否決權。
 *
 * 覆寫一律往 bar 收斂——它對任何一組「類別 vs 數值」都成立，是安全的落點。
 */
export function resolveChartKind(
  requested: string | undefined,
  labels: string[],
  values: number[],
): ChartKind {
  const want =
    requested === 'line' || requested === 'pie' || requested === 'donut' ? requested : 'bar';
  // 折線要求時間序列：拿它畫類別資料會暗示不存在的連續性
  if (want === 'line') return looksLikeYears(labels) ? 'line' : 'bar';
  // 圓餅／甜甜圈要求「少數幾塊構成一個整體」：負值無法構成佔比，太多扇形則角度比不出大小
  if (want === 'pie' || want === 'donut') {
    if (labels.length > MAX_PIE_SLICES) return 'bar';
    if (values.some((v) => v < 0)) return 'bar';
    return want;
  }
  // 模型沒提但標籤就是年份序列時，主動用折線——趨勢用長條看不出走向
  return looksLikeYears(labels) ? 'line' : 'bar';
}

/**
 * 每節最多列出幾張表。
 *
 * 這批資料有 165 張子表、整份目錄約 10k token，而目錄是**每一節都要送一次**的——
 * 六節就是六萬 token 的純清單，既貴，又讓模型在雜訊裡找針。先用查詢句篩過再送。
 */
const CATALOG_LIMIT = 20;

/**
 * 同一個工作表名在清單中最多保留幾份。
 *
 * 這批資料每個工作表都有逐年的複本（8-CC-參展商展區 有 16 份），名稱與欄位完全相同、
 * 只有橫幅的年度不同——bigram 分不出它們，於是 20 個名額被同一張表的複本佔掉十幾個，
 * 結構不同的表（例如畫佔比需要的兩列統計表）根本擠不進清單，模型自然不可能選它。
 *
 * 保留 2 份而非 1：同名表之間確實有「今年 vs 某個歷史年度」的差別，留一份備選才有得挑。
 */
const MAX_PER_SHEET = 2;

/**
 * 依查詢句挑出最可能相關的表。以字元 bigram 重疊度計分——中文沒有空白可切詞，
 * 而表名與橫幅（「參觀者預登國家數」「展覽年度:2025」）本來就是短字串，
 * bigram 足以把「問各國人數」對到「預登國家數」而不需要斷詞器或額外的 embedding 呼叫。
 *
 * 計分之後再依工作表名做多樣性收斂：清單的價值在於呈現有哪些**不同形狀**的資料可用，
 * 同一張表的十幾個年度複本佔滿名額只是把選擇權從模型手上拿走。
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
  const scored = [...catalog]
    .map((t) => {
      const text = grams(`${t.source}${t.sheet}${t.caption ?? ''}${t.headers.join('')}`);
      let hit = 0;
      for (const g of q) if (text.has(g)) hit += 1;
      return { t, hit };
    })
    .sort((a, b) => b.hit - a.hit);

  return capPerSheet(scored.map((x) => x.t), limit);
}

/**
 * 排名融合（Reciprocal Rank Fusion）的常數。k 越大越壓抑「只在單一訊號拿到第一名」的項目。
 * 取 10：兩個訊號的清單都只有數十項，k 太小會讓任一邊的第一名直接定案，
 * 失去融合的意義。
 */
const RRF_K = 10;

/**
 * 從橫幅取出這張表屬於哪個展覽。取不到回 undefined——那種表視為中立。
 *
 * 橫幅格式是「展覽名稱:台北國際工具機展 展覽年度:2025」，年度不算在展名裡。
 */
export function exhibitionOf(entry: { caption?: string }): string | undefined {
  const hit = entry.caption?.match(/展覽名稱[:：]\s*(.+?)(?:\s*展覽年度|$)/);
  return hit?.[1].trim() || undefined;
}

/**
 * 展名裡不具辨識力的部分。四個展覽的名稱有一半是這些字，留著會讓每個展都對上每一句問話。
 * 長的排前面，否則「展」會先吃掉「展覽會」的尾巴。
 */
const GENERIC_NAME_PARTS = /台北國際|臺北國際|台灣國際|臺灣國際|展覽會|展覽|台北|臺北|台灣|臺灣|國際|大展|展|會|TAIPEI|TAIWAN|DG/gi;

/**
 * 展名的辨識鍵。中文取 3 字以上的連續片段，英文取 4 字以上的完整字詞。
 *
 * 中文不放寬到 2 字是有代價換來的：「自行」同時出現在「自行車展」與欄位名「自行預登」，
 * 放寬之後一句「自行預登人數」就會被當成在問自行車展，把其他三個展的表全部降級。
 * 3 字的代價是「禮品展」這種極短簡稱對不上——那是漏判，會退成 no-op，比誤判安全。
 */
function exhibitionKeys(name: string): string[] {
  const keys: string[] = [];
  for (const seg of name.replace(GENERIC_NAME_PARTS, ' ').split(/[\s、,，/]+/)) {
    if (seg === '') continue;
    if (/^[\x20-\x7e]+$/.test(seg)) {
      if (seg.length >= 4) keys.push(seg.toLowerCase());
      continue;
    }
    for (let i = 0; i + 3 <= seg.length; i++) keys.push(seg.slice(i, i + 3));
  }
  return keys;
}

/** 問句有沒有點名這個展覽 */
function mentionsExhibition(query: string, name: string): boolean {
  const q = query.toLowerCase();
  return q.includes(name.toLowerCase()) || exhibitionKeys(name).some((k) => q.includes(k));
}

/**
 * 把問句沒點名的展覽的表降到後面。
 *
 * 這批資料四個展覽的工作表名稱與欄位幾乎一模一樣（每個展都有 1-*-參觀者統計、
 * 6-*-參展商家數），語意與字面都分不出來——實跑「工具機展前三年參展商家數」時，
 * 自行車展的 1-CC-參觀者統計 排到第一名，工具機展自己的表只排第二。橫幅上的
 * 「展覽名稱:」是唯一的硬訊號，而問句幾乎都會直接點名展覽。
 *
 * 只降級不剔除，而且辨識不到（沒有任何展被點名、或全部都被點名）就整個退成 no-op：
 * 展名簡稱五花八門，漏判必然存在，但漏判只是回到現狀，誤殺卻會讓整節沒有正確的表可用。
 */
export function preferMentionedExhibitions(
  entries: TableCatalogEntry[],
  query: string,
): TableCatalogEntry[] {
  const names = new Set(
    entries.map((e) => exhibitionOf(e)).filter((n): n is string => n !== undefined),
  );
  if (names.size < 2) return entries;

  const mentioned = new Set([...names].filter((n) => mentionsExhibition(query, n)));
  if (mentioned.size === 0 || mentioned.size === names.size) return entries;

  const on: TableCatalogEntry[] = [];
  const off: TableCatalogEntry[] = [];
  for (const e of entries) {
    const name = exhibitionOf(e);
    (name !== undefined && !mentioned.has(name) ? off : on).push(e);
  }
  return [...on, ...off];
}

/**
 * 融合語意與字面兩份排名。
 *
 * 實測兩者互有勝負，而且失誤的方式互補：
 *   語意把「國際**參展商**來源地區分布」對到參觀者的表——它被「來源地區分布」帶走，
 *         丟掉了最關鍵的類別詞；
 *   字面把「歷年參展商數量成長**趨勢**」對到參展商統計——它抓得住類別詞，
 *         卻不知道「趨勢」要的是逐年那張表。
 * 單用任一邊都會固定在某一類問題上出錯，融合則要求「兩邊都覺得不錯」才排前面。
 */
export function fuseRankings(
  semantic: TableCatalogEntry[],
  lexical: TableCatalogEntry[],
): TableCatalogEntry[] {
  const score = new Map<string, number>();
  const byId = new Map<string, TableCatalogEntry>();
  for (const list of [semantic, lexical]) {
    // 先收斂成「每個工作表一票」再計分。不收斂的話，語意清單裡同一張表的十幾個逐年
    // 複本各自佔一個名次，等於替同一個答案投十幾票——實測直接融合反而比單用任一邊更差。
    oncePerSheet(list).forEach((t, i) => {
      byId.set(t.id, t);
      score.set(t.id, (score.get(t.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id) as TableCatalogEntry);
}

/** 每個工作表只留最前面那一筆；融合的投票單位是「工作表」而非「某年度的那一份」 */
function oncePerSheet(entries: TableCatalogEntry[]): TableCatalogEntry[] {
  const seen = new Set<string>();
  const out: TableCatalogEntry[] = [];
  for (const t of entries) {
    if (seen.has(t.sheet)) continue;
    seen.add(t.sheet);
    out.push(t);
  }
  return out;
}

/**
 * 同名工作表最多留 MAX_PER_SHEET 份。
 *
 * 逐年複本（8-CC-參展商展區 有 16 份）名稱與欄位完全相同，無論用字面或語意排序都會
 * 擠在一起——不收斂的話 20 個名額被同一張表佔掉十幾個，結構不同的表根本進不了清單。
 * 不足名額也不補：清單短而多樣，勝過用複本填滿。
 */
export function capPerSheet(
  entries: TableCatalogEntry[],
  limit: number,
): TableCatalogEntry[] {
  const perSheet = new Map<string, number>();
  const picked: TableCatalogEntry[] = [];
  for (const t of entries) {
    if (picked.length >= limit) break;
    const n = perSheet.get(t.sheet) ?? 0;
    if (n >= MAX_PER_SHEET) continue;
    perSheet.set(t.sheet, n + 1);
    picked.push(t);
  }
  return picked;
}

/**
 * 附上真實資料列的表數，以及每張最多幾列。
 *
 * 散文若只看檢索片段（top-5），會拿片面的數字下全稱判斷——實跑時模型寫出
 * 「2022 年 8,598 為歷年最高」，而完整表裡 2023 年是 18,697，它只是沒看到那一列。
 * 圖表由程式從完整表算出，於是同一節裡散文與圖互相矛盾，比兩者都錯更傷可信度。
 *
 * 解法不是多打一次 LLM，而是在同一次呼叫裡把最可能相關的幾張表的實際資料附上去。
 * 只附前幾張、每張只附排序後的前幾列：極值是散文最常引用的（「最高」「前三名」），
 * 而完整幾百列既無必要也塞不下。
 */
const PREVIEW_TABLES = 3;
const PREVIEW_ROWS = 12;

/**
 * 從查詢中取出使用者明確要的年度數。
 *
 * 平常查詢仍維持精簡預覽；「最近三年」或列出多個年份時，則不能再用固定的
 * 兩份同名工作表上限，否則第三年會在送給 LLM 前消失。
 */
export function requestedYearCount(query: string): number {
  const explicit = new Set(query.match(/(?:19|20)\d{2}/g) ?? []);
  if (explicit.size > 1) return explicit.size;

  /*
   * 「前三年」與「這三年」在中文裡就是在問最近三年，而且是實際打進來的寫法——
   * 少了它們，那次查詢的年數被當成 1，逐年表沒補齊、預覽也只給了 3 張。
   * 要求緊接「年」字，「前三名」這種同樣以「前」開頭的問法不會被誤收。
   */
  const RECENT = '(?:最近|近期|近|過去|前|這|此)';
  const arabic = query.match(new RegExp(`${RECENT}\\s*(\\d{1,2})\\s*年`));
  if (arabic) return Math.max(1, Math.min(10, Number(arabic[1])));
  const chinese = query.match(new RegExp(`${RECENT}\\s*([一二兩三四五六七八九十])\\s*年`));
  if (chinese) {
    const values: Record<string, number> = {
      一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    };
    return values[chinese[1]] ?? 1;
  }
  return 1;
}

/** 將已入選的逐年工作表補齊到查詢所要的年數，並以新到舊排列。 */
export function expandRequestedYears(
  shortlist: TableCatalogEntry[],
  catalog: TableCatalogEntry[],
  query: string,
  limit = CATALOG_LIMIT,
): TableCatalogEntry[] {
  const count = requestedYearCount(query);
  if (count <= MAX_PER_SHEET) return shortlist.slice(0, limit);

  const explicit = new Set(query.match(/(?:19|20)\d{2}/g) ?? []);
  const yearOf = (t: TableCatalogEntry): number => {
    const hit = t.caption?.match(/(?:19|20)\d{2}/)?.[0];
    return hit ? Number(hit) : -1;
  };
  const bySheet = new Map<string, TableCatalogEntry[]>();
  for (const entry of catalog) {
    const list = bySheet.get(entry.sheet) ?? [];
    list.push(entry);
    bySheet.set(entry.sheet, list);
  }

  const out: TableCatalogEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: TableCatalogEntry): void => {
    if (!seen.has(entry.id) && out.length < limit) {
      seen.add(entry.id);
      out.push(entry);
    }
  };
  for (const entry of shortlist) {
    const siblings = (bySheet.get(entry.sheet) ?? []).filter((t) => yearOf(t) > 0);
    if (siblings.length < 2) {
      add(entry);
      continue;
    }
    siblings
      .sort((a, b) => {
        const aWanted = explicit.size === 0 || explicit.has(String(yearOf(a))) ? 1 : 0;
        const bWanted = explicit.size === 0 || explicit.has(String(yearOf(b))) ? 1 : 0;
        return bWanted - aWanted || yearOf(b) - yearOf(a);
      })
      .slice(0, count)
      .forEach(add);
  }
  return out;
}

/** 找出第一個數值欄的索引；沒有回 -1 */
export function firstNumericColumn(table: StoredTable): number {
  for (let c = 0; c < table.headers.length; c++) {
    if (isNumericColumn(table, c)) return c;
  }
  return -1;
}

/** 一欄要有六成以上的列解析得出數字才算數值欄——少數缺值或備註列不該否決整欄 */
function isNumericColumn(table: StoredTable, c: number): boolean {
  const hits = table.rows.filter((r) => parseCellNumber(r[c] ?? '') !== null).length;
  return hits >= Math.max(2, Math.ceil(table.rows.length * 0.6));
}

/**
 * 一欄是否為年份欄。
 *
 * 年份解析得出數字，但它是**時間軸的刻度**而不是可以比長短的量：拿 2014…2025 當長條
 * 長度，每根的差距不到 0.5%，整排看起來都是滿格。數值欄與年份欄因此必須分開判定。
 */
function isYearColumn(table: StoredTable, c: number): boolean {
  const hits = table.rows.filter((r) => YEAR_CELL.test((r[c] ?? '').trim())).length;
  return hits >= Math.max(2, Math.ceil(table.rows.length * 0.6));
}

/**
 * 一張表的資料預覽。有數值欄就依它由大到小排序後取前幾列——散文引用的多半是極值；
 * 沒有就取原始順序的前幾列。列數不足全部的話明講，避免模型把節錄當成全部。
 */
export function tablePreview(table: StoredTable): string {
  const numeric = firstNumericColumn(table);
  const rows = numeric >= 0
    ? [...table.rows].sort((a, b) => (parseCellNumber(b[numeric] ?? '') ?? 0) - (parseCellNumber(a[numeric] ?? '') ?? 0))
    : table.rows;
  const shown = rows.slice(0, PREVIEW_ROWS);
  /*
   * 年度欄與數值欄的節錄要用不同說法。兩者都是由大到小取前幾列，但依年度取到的是
   * **最近**的幾年，說成「前 N 列」會被讀成「最早的 N 年」——renderer 早就為圖表
   * 區分過這兩種說法，預覽沒有。實跑時模型把工具機展的「前三年」寫成 2019／2017／2023，
   * 而那張表由新到舊的前三列是 2025／2023／2022。
   */
  const byYear = numeric >= 0 && isYearColumn(table, numeric);
  const note = shown.length < table.rows.length
    ? `（共 ${table.rows.length} 列，此處為${
      byYear
        ? `依「${table.headers[numeric]}」由新到舊、最近的 ${shown.length} 列`
        : `依「${table.headers[numeric]}」排序後的前 ${shown.length} 列`
    }）`
    : `（共 ${table.rows.length} 列，已全部列出）`;
  const head = `${table.sheet}${table.caption ? ` — ${table.caption}` : ''} ${note}`;
  const body = [table.headers.join(' | '), ...shown.map((r) => r.join(' | '))].join('\n');
  return `${head}\n${body}`;
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
 * 查詢句是否在問「部分佔整體」。
 *
 * 這是自動補圖唯一拿得到、而欄位型別看不出來的資訊。圓餅成立與否是語意判斷——
 * 「國內 757／國外 197」構成一個整體、「日本 30／美國 232」只是兩個並列的數字，
 * 兩者的欄位型別完全相同。查詢句就在手上，不用它等於自廢一半判斷依據。
 */
export function looksLikeProportion(query: string): boolean {
  return /佔比|比例|占比|組成|構成|比重|結構占|share|proportion|composition|breakdown/i.test(query);
}

/** 自動補圖時最多試幾張表：形狀不合就換下一張，但不值得為它把整個清單都載入 */
const AUTO_CHART_TRIES = 5;

/**
 * 沒有模型挑選時，直接從最相關的表自動產圖。
 *
 * 實測命中率只有一半上下：同一次呼叫裡模型既要寫文又要挑表，常常寫完就忘了附圖，
 * 而且那是注意力分配問題，把 prompt 講得更用力換不到穩定改善。既然候選清單已經是用
 * 查詢句排序過的，最相關那張表的「維度欄 vs 量值欄」就是合理的預設圖（見 pickChartColumns）。
 *
 * 只在模型完全沒挑時才用，絕不覆蓋它的選擇——它看得到章節的語意，這裡只看得到欄位型別。
 */
export function pickChartColumns(table: StoredTable): { li: number; vi: number } | undefined {
  const cols = table.headers.map((_, i) => i);
  // 量值欄：解析得出數字**且不是年份**。年份是刻度不是量，選錯這一欄整排長條都會滿格
  const vi = cols.find((i) => isNumericColumn(table, i) && !isYearColumn(table, i));
  if (vi === undefined) return undefined;
  /*
   * 標籤欄取維度：優先非數值欄；整張表都是數字時退而取年份欄——「年度 | 人數」的
   * 年度就是時間軸，交給 resolveChartKind 會自動變成折線。
   * 原本取「第一個不是量值欄的欄」，在兩欄都是數字的表上會把人數當標籤、年度當長度。
   */
  const li =
    cols.find((i) => i !== vi && !isNumericColumn(table, i)) ??
    cols.find((i) => i !== vi && isYearColumn(table, i));
  if (li === undefined) return undefined;
  return { li, vi };
}

/** Missing user identity uses explicit guest scopes, never an account named after the tenant. */
function principalOf(tenantId: string, userId?: string): RetrievalPrincipal {
  return { tenantId, userId: userId ?? '' };
}

async function autoChartFrom(
  tenantId: string,
  entry: TableCatalogEntry,
  kind?: string,
  userId?: string,
): Promise<SectionChart | undefined> {
  const table = await loadTable(principalOf(tenantId, userId), entry.id);
  if (!table) return undefined;
  // 選不出「維度 + 量值」就不畫：畫一張把年份當長度的圖，比沒有圖更糟
  const picked = pickChartColumns(table);
  if (!picked) return undefined;
  return buildExactChart(tenantId, {
    table: entry.id,
    label: table.headers[picked.li],
    value: table.headers[picked.vi],
    ...(kind ? { kind } : {}),
    title: `${table.sheet}${table.caption ? `（${table.caption}）` : ''}`,
  }, userId);
}

/**
 * 自動補圖的入口。
 *
 * 問佔比時**依形狀挑表**而不是直接拿排名第一的：最相關的常是逐年的長表（16 列），
 * 對它要求圓餅只會因超過扇形上限而退回長條——想畫佔比就得找到那張兩三列的統計表。
 * 找不到就回到預設行為，不會因為挑不到理想形狀而整節沒圖。
 */
export async function autoChart(
  tenantId: string,
  shortlist: TableCatalogEntry[],
  query: string,
  used: Set<string>,
  userId?: string,
): Promise<SectionChart | undefined> {
  /*
   * 排除整份報告已經用過的表。自動補圖只看「最相關的表 + 欄位型別」，同一張表很容易
   * 在多節之間重複中選——實測一份報告有三節都畫了同一張 6-CC-參展商家數，讀者看到的
   * 是三張一樣的圖。優先換一張沒用過的；全都用過了才退回原本的選擇（有圖仍勝過沒圖）。
   */
  const fresh = shortlist.filter((t) => !used.has(t.id));
  const pool = fresh.length > 0 ? fresh : shortlist;

  if (looksLikeProportion(query)) {
    /*
     * 原本「第一張畫得出 donut 的就收工」，實測永遠選到那張只有兩列的參觀者統計
     * （Taiwan／Overseas），於是整份報告的圓餅清一色兩片——那是資訊量最低的圓餅。
     * 改成偏好切片較多的；找到三片以上就停手，不必為了挑最大的把候選全部載入。
     */
    let best: { id: string; chart: SectionChart } | undefined;
    for (const entry of pool.slice(0, AUTO_CHART_TRIES)) {
      const chart = await autoChartFrom(tenantId, entry, 'donut', userId);
      if (chart?.kind !== 'donut') continue;
      if (!best || chart.points.length > best.chart.points.length) best = { id: entry.id, chart };
      if (best.chart.points.length >= 3) break;
    }
    if (best) {
      used.add(best.id);
      return best.chart;
    }
  }
  /*
   * 預設路徑同樣要往下試，不能只賭排第一的那張。
   *
   * 實跑「兩展的前三年參展商家數」時，工具機展那一節整節沒有圖：排序把 1-CC-參觀者統計
   * （3 列，扣掉合計只剩 2 個資料點）放在第一，它畫不出來，而排第二的 6-TM-參展商家數
   * 明明是該節要的那張。第一名畫不出來是常態——三列的統計表、只有一列的國家數表在這批
   * 資料裡到處都是——賭單張等於把「有沒有圖」交給排序的運氣。
   */
  for (const entry of pool.slice(0, AUTO_CHART_TRIES)) {
    const chart = await autoChartFrom(tenantId, entry, undefined, userId);
    if (chart) {
      used.add(entry.id);
      return chart;
    }
  }
  return undefined;
}

/**
 * 跨表對比：把不同檔案的同一個指標畫進同一張分組圖。
 *
 * 實跑「自行車展與工具機展的前三年參展商家數」時，對比分析那一節的散文在講對比，
 * 圖卻是兩張各自獨立的折線並排——chart-ref 只吃單一 table id，一張圖的數字永遠
 * 只能來自一張表，而兩個展分屬兩個檔案。「對比」這件事沒有任何一張圖表達得出來。
 *
 * 對齊方式是**交集**而不是聯集：工具機展是雙年展，2024 那一年在它的表上根本不存在，
 * 補 0 會在圖上長出一根不存在的長條，而且正好長在最容易被讀成「那年掉到谷底」的位置。
 * 這與單表路徑「數值解析不出來就整列略過」是同一條原則。
 */
async function buildComparisonChart(
  tenantId: string,
  ref: ChartRef,
  tables: { id: string; series: string }[],
  userId?: string,
): Promise<SectionChart | undefined> {
  const picked = tables.slice(0, MAX_SERIES);
  const loaded: { series: string; table: StoredTable; values: Map<string, number> }[] = [];

  for (const item of picked) {
    const table = await loadTable(principalOf(tenantId, userId), item.id);
    if (!table) return undefined;
    const li = table.headers.indexOf(ref.label);
    const vi = table.headers.indexOf(ref.value);
    // 欄位名在任一張表對不上就整張不畫：拿錯欄位的數字比沒有圖糟得多
    if (li < 0 || vi < 0 || li === vi) return undefined;

    const values = new Map<string, number>();
    for (const row of table.rows) {
      const label = (row[li] ?? '').trim();
      const value = parseCellNumber(row[vi] ?? '');
      if (label === '' || value === null) continue;
      if (TOTAL_LABELS.has(label)) continue; // 合計列與組成項不同層級
      values.set(label, value);
    }
    loaded.push({ series: item.series, table, values });
  }

  // 每張表都有的標籤才留下；順序先沿用第一張表，年度序列稍後改為由舊到新
  const shared = [...loaded[0].values.keys()].filter((label) =>
    loaded.every((l) => l.values.has(label)));
  if (shared.length < 2) return undefined;

  const byYear = looksLikeYears(shared);
  const ordered = byYear ? [...shared].sort((a, b) => Number(a) - Number(b)) : shared;
  // 年度取最近的幾筆（與折線同理），其餘沿用原順序取前幾筆
  const kept = byYear
    ? ordered.slice(-MAX_GROUPED_CATEGORIES)
    : ordered.slice(0, MAX_GROUPED_CATEGORIES);

  const points = kept.map((label) => {
    const values = loaded.map((l) => l.values.get(label) as number);
    return { label, value: values[0], values };
  });

  const where = loaded
    .map((l) => `${l.table.source} / ${l.table.sheet}`)
    .join('、');

  return {
    kind: 'grouped',
    complete: true,
    title: ref.title?.trim() || `${ref.value}對比`,
    ...(ref.unit?.trim() ? { unit: ref.unit.trim() } : {}),
    points,
    series: loaded.map((l) => l.series),
    sourceLabel: where,
    totalRows: shared.length,
    // 依年度截斷時取的是最近的幾筆，說明文字不能寫成「前 N 筆」
    ...(byYear ? { recent: true } : {}),
  };
}

/**
 * 分組長條：一列多欄的表（類型 | 今年預登 | 今年報到 | 上屆預登 | 上屆報到）。
 *
 * 這批資料裡資訊密度最高的幾張表就是這個形狀，而兩欄的 label/value 只抓得到其中一欄，
 * 等於把四個數字丟掉三個。數值同樣由程式讀出，LLM 只挑欄位。
 */
function buildGroupedChart(
  table: StoredTable,
  ref: ChartRef,
  cols: string[],
): SectionChart | undefined {
  const li = table.headers.indexOf(ref.label);
  const idx = cols.map((c) => table.headers.indexOf(c));
  if (li < 0 || idx.some((i) => i < 0 || i === li)) return undefined;

  const points: { label: string; value: number; values: number[] }[] = [];
  for (const row of table.rows) {
    const label = (row[li] ?? '').trim();
    if (label === '' || TOTAL_LABELS.has(label)) continue;
    const values = idx.map((i) => parseCellNumber(row[i] ?? ''));
    // 任一數列缺值就整列略過：補 0 會在圖上生出一根不存在的長條
    if (values.some((v) => v === null)) continue;
    const nums = values as number[];
    points.push({ label, value: nums[0], values: nums });
  }
  if (points.length < 2 || points.length > MAX_GROUPED_CATEGORIES) return undefined;

  const where = `${table.source} / ${table.sheet}${table.caption ? `（${table.caption}）` : ''}`;
  return {
    kind: 'grouped',
    complete: true,
    title: ref.title?.trim() || table.sheet,
    ...(ref.unit?.trim() ? { unit: ref.unit.trim() } : {}),
    points,
    series: cols,
    sourceLabel: where,
    totalRows: points.length,
  };
}

/**
 * 一列跨欄的構成圖：把指定的那幾個**欄**變成圓餅的切片。
 *
 * 「自行預登／駐外補助／駐外自費／廠商申請補助／現場報名」這種來源構成，在試算表裡
 * 是同一列的五個欄位；而 label/value 的形狀只讀得出「一欄當標籤、一欄當數值」，
 * buildGroupedChart 又寫死了分組長條，於是這類最典型的佔比資料反而畫不出圓餅。
 *
 * 取哪一列有合計列就用合計列（那才是「整體」），否則只在整張表僅一列資料時用它。
 * 多列又沒有合計列時不畫：要畫哪一列是語意問題，程式既不猜，也不自行加總——
 * 加總出來的數字不在任何一個儲存格裡，就不再是「直接讀自原始資料」。
 */
function buildSlicedChart(
  table: StoredTable,
  ref: ChartRef,
  cols: string[],
): SectionChart | undefined {
  const li = table.headers.indexOf(ref.label);
  const idx = cols.map((c) => table.headers.indexOf(c));
  if (li < 0 || idx.some((i) => i < 0 || i === li)) return undefined;

  const named = table.rows.filter((r) => (r[li] ?? '').trim() !== '');
  const total = named.find((r) => TOTAL_LABELS.has((r[li] ?? '').trim()));
  const data = named.filter((r) => !TOTAL_LABELS.has((r[li] ?? '').trim()));
  const row = total ?? (data.length === 1 ? data[0] : undefined);
  if (!row) return undefined;

  const points: { label: string; value: number }[] = [];
  cols.forEach((name, k) => {
    const value = parseCellNumber(row[idx[k]] ?? '');
    // 缺值的欄不成切片：補 0 會在圓餅上生出一塊不存在的區塊
    if (value !== null) points.push({ label: name, value });
  });

  const kind = resolveChartKind(ref.kind, points.map((p) => p.label), points.map((p) => p.value));
  if (points.length < minPointsFor(kind)) return undefined;

  const where = `${table.source} / ${table.sheet}${table.caption ? `（${table.caption}）` : ''}`;
  return {
    kind,
    complete: true,
    title: ref.title?.trim() || table.sheet,
    ...(ref.unit?.trim() ? { unit: ref.unit.trim() } : {}),
    points,
    sourceLabel: where,
    totalRows: points.length,
    sliced: (row[li] ?? '').trim(),
  };
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
  userId?: string,
): Promise<SectionChart | undefined> {
  // 跨表對比：一張圖的數字來自多張表，每張貢獻一個數列
  if (ref.tables && ref.tables.length >= 2) {
    return buildComparisonChart(tenantId, ref, ref.tables, userId);
  }

  if (ref.table === undefined) return undefined;
  const table = await loadTable(principalOf(tenantId, userId), ref.table);
  if (!table) return undefined;

  // values 給了多個欄位就走分組長條；只有一個或沒給則沿用單數列路徑
  const cols = Array.isArray(ref.values) ? ref.values.filter((c) => typeof c === 'string') : [];
  if (cols.length >= 2) {
    /*
     * 同樣是「多個欄」，要圓餅與要長條的意思完全不同：前者是一列的構成（欄變切片），
     * 後者是多列的並排比較（欄變數列）。切片不套 MAX_SERIES——那個上限是為了分組長條
     * 的可讀性，圓餅自有 MAX_PIE_SLICES 把關。
     */
    if (ref.kind === 'pie' || ref.kind === 'donut') return buildSlicedChart(table, ref, cols);
    return buildGroupedChart(table, ref, cols.slice(0, MAX_SERIES));
  }

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
  // 先決類型再套下限：下限因類型而異（圓餅 2、其餘 3），順序反過來會把合法的兩分佔比擋掉
  const kind = resolveChartKind(ref.kind, points.map((p) => p.label), points.map((p) => p.value));
  if (points.length < minPointsFor(kind)) return undefined;

  const totalRows = points.length;
  /*
   * 排序方式由類型決定：長條與圓餅比大小，依數值遞減才讀得出高低；
   * 折線是時間軸，必須依年份遞增，否則折線的走向毫無意義。
   */
  const ordered = kind === 'line'
    ? [...points].sort((a, b) => Number(a.label) - Number(b.label))
    : [...points].sort((a, b) => b.value - a.value);
  const top = kind === 'line' ? ordered.slice(-MAX_EXACT_POINTS) : ordered.slice(0, MAX_EXACT_POINTS);
  const where = `${table.source} / ${table.sheet}${table.caption ? `（${table.caption}）` : ''}`;
  return {
    kind,
    complete: true,
    title: ref.title?.trim() || `${table.sheet}`,
    ...(ref.unit?.trim() ? { unit: ref.unit.trim() } : {}),
    points: top,
    sourceLabel: where,
    totalRows,
  };
}

/** 抽出 ```chart-ref 區塊（LLM 挑表）；採用第一個欄位齊全的 */
export function extractChartRefs(raw: string): { body: string; refs: ChartRef[] } {
  const { body, payloads } = stripBlocks(raw, 'chart-ref');
  const refs: ChartRef[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload) as Partial<ChartRef>;
      if (typeof parsed.label !== 'string') continue;
      /*
       * tables 是跨表對比的形式：每張表一個數列。給了它就沒有單一的 table id，
       * 所以 table 的必要性要讓位——但仍填一個代表值（第一張表），
       * 讓去重鍵與「本節用過哪些表」的記錄不必為這條路徑另開一套。
       */
      const series = Array.isArray(parsed.tables)
        ? parsed.tables.filter(
          (t): t is { id: string; series: string } =>
            typeof t === 'object' && t !== null
            && typeof (t as { id?: unknown }).id === 'string'
            && typeof (t as { series?: unknown }).series === 'string',
        )
        : [];
      // 有 tables 但其中有項目缺 id 或缺數列名：圖例上不能有無名數列，整個 ref 丟掉
      if (Array.isArray(parsed.tables) && series.length !== parsed.tables.length) continue;
      // 只有一張表沒有對比可言，退回單表路徑
      const cross = series.length >= 2 ? series : undefined;
      const table = cross ? cross[0].id : parsed.table ?? series[0]?.id;
      if (typeof table !== 'string') continue;
      /*
       * value 與 values 二擇一即可。prompt 明說「給了 values 時 value 可省略」，
       * 但這裡原本硬性要求 value 是字串——模型照著 prompt 做，ref 就被整個丟掉，
       * 於是分組長條與構成圖從 chart-ref 這條路根本走不到。
       */
      const cols = Array.isArray(parsed.values)
        ? parsed.values.filter((c): c is string => typeof c === 'string')
        : [];
      const value = typeof parsed.value === 'string' && parsed.value !== '' ? parsed.value : cols[0];
      if (value === undefined) continue;
      // 同一張表的同一組欄位重複挑選就會畫出兩張一樣的圖；模型偶爾會這樣
      const key = `${table}|${parsed.label}|${value}|${cols.join(',')}|`
        + `${cross?.map((t) => t.id).join('+') ?? ''}|${parsed.kind ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ ...parsed, table, value, ...(cross ? { tables: cross } : { tables: undefined }) } as ChartRef);
    } catch {
      // 這一個壞掉，繼續看下一個
    }
  }
  return { body, refs: refs.slice(0, MAX_SECTION_CHARTS) };
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

export interface ComposeOptions {
  /** 整份報告已被自動補圖用過的表 id；跨節共用同一個 Set，避免多節畫出同一張圖 */
  usedTables?: Set<string>;
}

export async function composeSection(
  tenantId: string,
  userId: string,
  section: OutlineSection,
  locale: string | undefined,
  llm: LLMProvider,
  opts: ComposeOptions = {},
): Promise<ReportSection> {
  const base = { heading: section.heading, query: section.query };

  // 檢索失敗不得中斷整份報告：該節記為查無資料，其餘節照跑
  let chunks: KnowledgeChunk[] = [];
  try {
    const retriever = await pickRetriever(tenantId);
    const pool = await retriever.search({ tenantId, userId }, section.query);
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

  /*
   * 選表優先走語意相似度。字面重疊（bigram）實測分不出相關與否——「國際參展商來源地區
   * 分布」對到錯的表拿 30%，對的表只有 15%，訂任何門檻都會誤傷正確的。
   * 「來源地區分布」與「年度家數」是不是同一件事本來就是語意問題，字面答不了。
   *
   * 向量不可用時（未回填、embedding 失敗、file 後端）退回 bigram：它不夠準，但比沒有好。
   */
  const intent = `${section.heading}${section.query}`;
  let catalog: TableCatalogEntry[] = [];
  try {
    catalog = await listTableCatalog({ tenantId, userId });
  } catch (err) {
    logger.warn({ err, tenantId }, 'table catalog lookup failed; section falls back to excerpts only');
  }
  // 取寬一點：融合會先把兩邊各自收斂成每個工作表一筆，太窄會讓候選在收斂後所剩無幾
  const lexical = selectCatalog(catalog, intent, catalog.length);

  let semantic: TableCatalogEntry[] = [];
  try {
    const model = knowledgeStore.getSource(tenantId).embeddingModel;
    const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
    const { vectors, tokens } = await embedder.embed([intent], model);
    usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
    semantic = await searchTableCatalog({ tenantId, userId }, vectors[0], CATALOG_LIMIT * 6);
  } catch (err) {
    // 向量不可用（未回填、embedding 失敗、file 後端）就只剩字面——不夠準，但比沒有好
    logger.warn({ err, tenantId }, '語意選表失敗，本節只用字面比對');
  }
  // 先把問句沒點名的展覽降到後面，再收斂名額：這批資料四個展的表名幾乎相同，
  // 不先分展覽的話，20 個名額會被別的展的同名表佔掉（見 preferMentionedExhibitions）
  const baseShortlist = capPerSheet(
    preferMentionedExhibitions(
      semantic.length > 0 ? fuseRankings(semantic, lexical) : lexical,
      intent,
    ),
    CATALOG_LIMIT,
  );
  const shortlist = expandRequestedYears(baseShortlist, catalog, intent);
  const catalogBlock = shortlist.length > 0 ? `\n\n可用資料表：\n${catalogPrompt(shortlist)}` : '';

  // 最相關的幾張附上真實資料列，讓散文與圖表據同一份數字書寫；載入失敗只是少了預覽
  const previews: string[] = [];
  // 兩個展覽的「最近三年」至少需要 3×2 張逐年表；保留一般查詢的 3 張上限。
  const previewTables = Math.min(shortlist.length, Math.max(PREVIEW_TABLES, requestedYearCount(intent) * 2));
  for (const entry of shortlist.slice(0, previewTables)) {
    try {
      const table = await loadTable({ tenantId, userId }, entry.id);
      if (table) previews.push(tablePreview(table));
    } catch (err) {
      logger.warn({ err, tenantId, table: entry.id }, 'table preview load failed');
    }
  }
  const previewBlock = previews.length > 0 ? `\n\n資料表實際內容：\n${previews.join('\n\n')}` : '';

  try {
    const result = await llm.createMessage({
      system: sectionSystem(locale),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `章節標題：${section.heading}\n\n參考資料：\n${context}${catalogBlock}${previewBlock}\n\n本節要回答：${section.query}`,
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
    const refOut = extractChartRefs(result.text ?? '');
    const exact: SectionChart[] = [];
    for (const ref of refOut.refs) {
      try {
        const built = await buildExactChart(tenantId, ref, userId);
        if (!built) continue;
        exact.push(built);
        // 模型挑的也要記進去，否則後面的節會用自動補圖再畫一次同一張表。
        // 跨表對比一次用掉好幾張，每一張都要記——只記第一張會讓其餘的又被補一次圖。
        const usedIds = ref.tables?.map((t) => t.id) ?? (ref.table ? [ref.table] : []);
        for (const id of usedIds) opts.usedTables?.add(id);
      } catch (err) {
        logger.warn({ err, tenantId, table: ref.table }, 'exact chart build failed');
      }
    }
    const { body, charts: inline } = extractCharts(refOut.body);
    // 精確與節錄不混用：同一節裡一張是原始資料、一張是 LLM 轉述，讀者無從分辨可信度
    let charts = exact.length > 0 ? exact : inline;

    // 模型一張都沒挑才自動補：加再多圖型，模型不選也看不到
    if (charts.length === 0 && shortlist.length > 0) {
      try {
        const auto = await autoChart(
          tenantId,
          shortlist,
          `${section.heading}${section.query}`,
          opts.usedTables ?? new Set(),
          userId,
        );
        if (auto) {
          charts = [auto];
          logger.info({ tenantId, heading: section.heading }, '章節圖表由系統自動補上');
        }
      } catch (err) {
        logger.warn({ err, tenantId }, 'auto chart failed');
      }
    }
    if (body === '') {
      return { ...base, body: fallbackBody(chunks, locale), sources: toSources(chunks), hits: chunks.length, degraded: true };
    }
    return {
      ...base,
      body,
      sources: toSources(chunks),
      hits: chunks.length,
      ...(charts.length > 0 ? { charts } : {}),
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
