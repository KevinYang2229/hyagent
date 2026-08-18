/**
 * 上傳檔 → 文字解析層（供 knowledge-file.service 的 ingest 管線使用）。
 *
 * RAG 準確度的瓶頸不在「字有沒有抽出來」，而在「結構有沒有留下來」——標題階層與表格
 * 決定了切塊邊界對不對、chunk 帶不帶得到所屬章節。因此可取得結構的格式一律轉成 Markdown：
 *   docx  → mammoth 轉 HTML（原生 OOXML，樣式資訊完整）→ Markdown
 *   htm   → cheerio 清雜訊 → Markdown（涵蓋 Word「另存為網頁」的產物）
 *   xlsx  → exceljs 逐張工作表轉 Markdown 表格（工作表名當標題）
 * 取不到結構的格式只能降級為純文字，並以 fidelity='text' 標示：
 *   doc   → word-extractor 讀 OLE2 二進位，僅有文字流
 *   pdf   → pdf-parse，版面固定格式無語意結構
 *
 * Markdown 只是 parse → chunk 之間的中繼表示，不落地成檔（本模組不保存原始檔）。
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Workbook, type CellValue, type Worksheet } from 'exceljs';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import WordExtractor from 'word-extractor';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';

export type DocFormat = 'txt' | 'md' | 'html' | 'docx' | 'doc' | 'pdf' | 'xlsx';

/** structured = 標題/清單/表格已保留為 Markdown；text = 僅有純文字流 */
export type DocFidelity = 'structured' | 'text';

/**
 * 從試算表抽出的結構化子表。
 *
 * 與 text 並存而非取代：text 供 RAG 切塊（回答敘述性問題），本結構供報告做精確計算。
 * 圖表若從 RAG 片段的文字讀數字，會同時吃到「轉述失真」與「top-k 只是節錄」兩個問題，
 * 而圖表不像散文會自己聲明範圍——所以需要一條看得到完整資料列的路徑。
 */
export interface ParsedTable {
  /** 工作表名 */
  sheet: string;
  /** 跨欄橫幅（例：展覽名稱:X 展覽年度:Y）；沒有則不存在 */
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface ParsedDoc {
  text: string;
  format: DocFormat;
  fidelity: DocFidelity;
  /** 僅 xlsx 有；其他格式沒有可靠的表格邊界可抽 */
  tables?: ParsedTable[];
}

export const SUPPORTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.htm',
  '.html',
  '.doc',
  '.docx',
  '.pdf',
  '.xlsx',
] as const;

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

/** 副檔名宣稱是二進位容器者，內容必須通過 magic bytes 驗證 */
const BINARY_EXT = new Set(['.doc', '.docx', '.pdf', '.xlsx']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * 解碼後無法辨識的字元佔比超過此值，即視為「沒有任何候選編碼解得開」。
 * 寧可 422 擋下也不要把亂碼寫進索引——亂碼 chunk 一樣會被 embed、佔據檢索名額，
 * 但永遠答不出東西，事後也很難從索引裡看出根因是編碼。
 */
const MAX_JUNK_RATIO = 0.02;

/** 依序嘗試的候選編碼；utf-8 擺第一，確保既有 UTF-8 檔案的行為完全不變 */
const FALLBACK_ENCODINGS = ['utf-8', 'big5', 'gbk'];

/**
 * 「沒解開」的字元：U+FFFD、私用區、以及 tab/換行以外的控制字元。
 *
 * 只數 U+FFFD 不夠——寬鬆的 decoder 會宣稱零錯誤卻產出整片垃圾：Big5 把 0xFF 映到
 * 私用區 U+F8F8，於是滿是 0xFF 的壞檔在 Big5 下「零替換字元」，反而贏過誠實回報
 * U+FFFD 的 UTF-8 被選中。
 */
// eslint-disable-next-line no-control-regex -- 控制字元正是要偵測的目標
const JUNK_CHARS = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function junkRatio(s: string): number {
  return s.length === 0 ? 1 : (s.match(JUNK_CHARS)?.length ?? 0) / s.length;
}

/** 讀出 BOM 指定的編碼並去掉 BOM 本身（留著會變成內容裡的 U+FEFF） */
function stripBom(buf: Buffer): { encoding?: string; body: Buffer } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', body: buf.subarray(3) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', body: buf.subarray(2) };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', body: buf.subarray(2) };
  }
  return { body: buf };
}

/**
 * 無 BOM 的 UTF-16 判定：其中的 ASCII 字元（HTML 標記、數字、英文）會產生大量
 * 規律落在單側的 NUL——LE 在奇數位、BE 在偶數位。UTF-8 內容不會有 NUL。
 */
function sniffUtf16(buf: Buffer): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(buf.length, 2048);
  if (n < 4) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) { if (i % 2 === 0) evenNul++; else oddNul++; }
  }
  const threshold = (n / 2) * 0.3;
  if (oddNul > threshold && evenNul === 0) return 'utf-16le';
  if (evenNul > threshold && oddNul === 0) return 'utf-16be';
  return null;
}

/** HTML 自己宣告的 charset：<meta charset=big5> 或 content="text/html; charset=big5" */
function sniffMetaCharset(buf: Buffer): string | null {
  const head = buf.subarray(0, 4096).toString('latin1');
  return /charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1].toLowerCase() ?? null;
}

/**
 * 位元組 → 文字，自動偵測編碼。
 *
 * 不能無條件 `buf.toString('utf8')`：Word 在中文 Windows 的「另存為網頁」預設輸出
 * UTF-16LE，政府單位的舊檔則常見 Big5。誤判的後果不只是中文變成 U+FFFD——UTF-16 被當成
 * UTF-8 讀時，ASCII 標記之間會夾 NUL，HTML parser 因此認不出任何標籤，整份文件會以
 * raw markup 的形式進索引。
 */
export function decodeText(buf: Buffer, opts: { html?: boolean } = {}): string {
  const { encoding: bomEncoding, body } = stripBom(buf);
  if (body.length === 0) return ''; // 空檔交由呼叫端的「內容過短」判斷處理，不算編碼錯誤
  const candidates = [
    bomEncoding, // BOM 最權威
    sniffUtf16(body),
    opts.html ? sniffMetaCharset(body) : null,
    ...FALLBACK_ENCODINGS,
  ].filter((e): e is string => Boolean(e));

  let best = '';
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const encoding of new Set(candidates)) {
    let text: string;
    try {
      text = new TextDecoder(encoding).decode(body);
    } catch {
      continue; // 執行環境不認得的編碼名稱，跳過
    }
    const ratio = junkRatio(text); // 空字串回 1（該編碼把整段吞掉），不會被誤判為乾淨
    if (ratio === 0) return text; // 完全解得開就不必再比
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = text;
    }
  }
  if (bestRatio > MAX_JUNK_RATIO) {
    throw AppError.unprocessable(
      '檔案編碼無法辨識，內容解析後為亂碼。請以 UTF-8 重新儲存後再上傳（Word 請選「另存新檔 → 網頁(篩選過)」或直接上傳 .docx）',
    );
  }
  return best;
}

/**
 * 以檔頭辨識實際容器格式。改副檔名在實務上是常態（.doc 其實是 docx、或反之），
 * 只信副檔名會拿錯 parser 然後噴出使用者看不懂的錯誤。
 */
function sniff(buf: Buffer): 'zip' | 'ole2' | 'pdf' | null {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) return 'zip'; // PK\x03\x04 → OOXML(docx)
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) {
    return 'ole2'; // Office 97-2003 複合文件
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

/**
 * ZIP 容器內容判別：docx 與 xlsx 都是 OOXML，檔頭同樣是 PK\x03\x04，magic bytes 分不出來，
 * 只能看容器裡有哪些 part。zip 的 entry 檔名在 local file header 中是未壓縮的明文，
 * 直接掃 buffer 就找得到，不必真的解壓。
 *
 * word/document.xml 優先判定：內嵌 Excel 圖表的 docx 會夾帶 word/embeddings/*.xlsx，
 * 但那是巢狀 zip（其內部檔名已被壓縮，掃不到），因此不會反被認成試算表。
 * 兩者皆無（其他 zip，如 pptx 或改名的壓縮檔）時回 null，交由既有的 docx 預設路徑處理。
 */
function zipKind(buf: Buffer): 'docx' | 'xlsx' | null {
  if (buf.includes('word/document.xml')) return 'docx';
  if (buf.includes('xl/workbook.xml')) return 'xlsx';
  return null;
}

/** 副檔名決定「意圖」，magic bytes 決定「事實」；兩者衝突時以內容為準。 */
export function detectFormat(name: string, buf: Buffer): DocFormat {
  const ext = extOf(name);
  if (!SUPPORTED.has(ext)) {
    throw AppError.badRequest(
      `不支援的檔案格式：${ext || '(無副檔名)'}（支援 ${SUPPORTED_EXTENSIONS.join(' / ')}）`,
    );
  }

  const magic = sniff(buf);
  if (magic === 'pdf') return 'pdf';
  // 判不出種類的 zip 一律當 docx（維持既有行為）：mammoth 對非 docx 的 zip 會自己報錯
  if (magic === 'zip') return zipKind(buf) === 'xlsx' ? 'xlsx' : 'docx';
  if (magic === 'ole2') {
    // Excel 97-2003 的 .xls 也是 OLE2，交給 word-extractor 只會抽出一堆二進位雜訊，
    // 不如在這裡明講——這是「舊檔改個副檔名就上傳」最常見的失敗形態
    if (ext === '.xlsx') {
      throw AppError.badRequest('這是舊版 Excel（.xls）格式，請以 Excel 另存為 .xlsx 後再上傳');
    }
    return 'doc';
  }

  // 無 magic 代表是文字檔；此時副檔名若宣稱是二進位格式，就是損毀或根本不是該格式
  if (BINARY_EXT.has(ext)) {
    throw AppError.badRequest(`檔案內容與副檔名 ${ext} 不符（可能已損毀或並非該格式）`);
  }
  if (ext === '.htm' || ext === '.html') return 'html';
  return ext === '.md' ? 'md' : 'txt';
}

/**
 * HTML → Markdown。刻意的取捨：
 * - 保留標題（切塊邊界＋章節語意）與表格（壓成單行純文字後幾乎不可讀）
 * - 去掉粗體/斜體/連結網址等純裝飾標記，這些對 embedding 只是雜訊
 */
function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx', // '## 標題' 比 setext 好切也好辨識
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    hr: '',
  });
  td.use(gfm); // 表格轉成 | a | b | 形式
  td.addRule('unwrapEmphasis', {
    filter: ['strong', 'b', 'em', 'i', 'u', 'span'],
    replacement: (content) => content,
  });
  td.addRule('linkTextOnly', {
    filter: 'a',
    replacement: (content) => content, // 保留錨點文字、丟掉 URL
  });
  td.addRule('dropImage', { filter: 'img', replacement: () => '' });
  return td;
}

const turndown = createTurndown();

/**
 * 展開 rowspan / colspan：被合併掉的儲存格在後續列補回相同內容。
 *
 * Markdown 表格沒有合併儲存格的概念，turndown 也不補——被 rowspan 蓋住的列會少幾格，
 * **後面每一欄都往左位移**。實務後果是「主辦單位」被讀成「管制代號」，答案錯得理直氣壯，
 * 比查不到更危險。Word 匯出的公文表格大量使用 rowspan，這一步不能省。
 */
function expandTableSpans($: cheerio.CheerioAPI, table: AnyNode): void {
  /** 尚未用完的 rowspan：key = 欄索引 */
  const carried = new Map<number, { html: string; tag: string; rowsLeft: number }>();

  for (const tr of $(table).find('tr').toArray()) {
    const $tr = $(tr);
    const cells = $tr.children('td, th').toArray();
    const rendered: string[] = [];
    let col = 0;
    let next = 0;
    const lastCarriedCol = () => Math.max(-1, ...carried.keys());

    while (next < cells.length || col <= lastCarriedCol()) {
      const carry = carried.get(col);
      if (carry) {
        rendered.push(`<${carry.tag}>${carry.html}</${carry.tag}>`);
        carry.rowsLeft -= 1;
        if (carry.rowsLeft <= 0) carried.delete(col);
        col += 1;
        continue;
      }
      if (next >= cells.length) break;
      const $cell = $(cells[next]);
      next += 1;
      const tag = 'tagName' in cells[next - 1] ? String(cells[next - 1].tagName).toLowerCase() : 'td';
      const html = $cell.html() ?? '';
      const colspan = Math.max(1, Number.parseInt($cell.attr('colspan') ?? '1', 10) || 1);
      const rowspan = Math.max(1, Number.parseInt($cell.attr('rowspan') ?? '1', 10) || 1);
      for (let i = 0; i < colspan; i++) {
        rendered.push(`<${tag}>${html}</${tag}>`);
        if (rowspan > 1) carried.set(col, { html, tag, rowsLeft: rowspan - 1 });
        col += 1;
      }
    }
    $tr.html(rendered.join(''));
  }
}

/**
 * 表格正規化，讓 turndown-plugin-gfm 吃得下：
 * 該外掛只轉「首列是 th」的表格，其餘原樣保留成 HTML 字串——而 Word/mammoth 產出的表格
 * 首列一律是 td（表頭只是視覺樣式，沒有語意標記），不補這一步整張表會以 raw HTML 進索引。
 * 儲存格內的 <p> 也要拆掉，否則換行會把 Markdown 表格結構撐破。
 */
function normalizeTables($: cheerio.CheerioAPI): void {
  $('table').each((_, el) => {
    const $table = $(el);
    $table.find('td > p, th > p').each((_, p) => {
      const $p = $(p);
      $p.replaceWith($p.html() ?? '');
    });
    expandTableSpans($, el); // 必須在補 th 之前：展開後首列才是完整的欄位數
    if ($table.find('th').length > 0) return;
    $table
      .find('tr')
      .first()
      .find('td')
      .each((_, td) => {
        const $td = $(td);
        $td.replaceWith(`<th>${$td.html() ?? ''}</th>`);
      });
  });
}

/** 清掉不含正文的節點；Word「另存為網頁」會塞大量 mso 專有標籤與條件註解 */
function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta, form, nav, aside').remove();
  $('*')
    .filter((_, el) => 'tagName' in el && typeof el.tagName === 'string' && el.tagName.includes(':'))
    .remove(); // <o:p>、<w:sdt> 等 Office 命名空間標籤
  $('*')
    .contents()
    .filter((_, node) => node.type === 'comment')
    .remove(); // <!--[if gte mso 9]> 條件註解
  normalizeTables($);
  return $.html();
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(sanitizeHtml(html));
}

async function parseDocx(buf: Buffer): Promise<string> {
  // convertToHtml（而非 extractRawText）：後者會把標題/清單/表格全部壓成無差別的文字行
  const out = await mammoth.convertToHtml({ buffer: buf });
  for (const m of out.messages) {
    if (m.type === 'error') logger.warn({ message: m.message }, 'docx conversion warning');
  }
  return htmlToMarkdown(out.value ?? '');
}

async function parsePdf(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buf });
  try {
    const out = await parser.getText();
    return out.text ?? '';
  } finally {
    await parser.destroy();
  }
}

/**
 * 每張工作表最多取用的資料列數。
 *
 * xlsx 的壓縮率極高，10MB 的上限檔可以是數十萬列——全部灌進索引會炸開 embedding 成本，
 * 而逐列切出的 chunk 對問答幾乎沒有檢索價值。超過就截斷，但必須在文中留下明示標記：
 * 安靜地少掉一半資料，比直接失敗更難察覺。
 */
const MAX_SHEET_ROWS = 2000;

/** Excel 的日期欄多半只有日期；帶時間才輸出完整時刻，免得整欄都拖著無意義的 T00:00:00.000Z */
function formatCellDate(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

/**
 * exceljs 的 CellValue 是聯集型別（公式、超連結、RichText 各有各的形狀），統一取其可讀文字。
 * 公式取 result 而非算式本身——使用者問的是數字，不是 =SUM(B2:B9)。
 */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatCellDate(value);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('hyperlink' in value) return cellText(value.text); // 留錨點文字、丟 URL，比照 htmlToMarkdown
    if ('formula' in value || 'sharedFormula' in value) return cellText(value.result ?? null);
    if ('error' in value) return ''; // #REF! / #DIV/0! 不是內容，寫進索引只是雜訊
    return '';
  }
  return String(value);
}

/** 儲存格 → Markdown 表格欄位：管線符號會拆散表格結構，換行會把整列撐破 */
function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 一列中最後一個有內容的欄位索引（+1 即實際寬度）；全空回 0 */
function usedWidth(cells: string[]): number {
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i] !== '') return i + 1;
  }
  return 0;
}

/**
 * 讀出一列，並判定它是不是「跨欄合併的橫幅」。
 *
 * 實務上的匯出檔（例如展覽統計）第 1 列往往是一格橫跨整張表的標題
 * （「展覽名稱:X 展覽年度:Y」），真正的欄位名在第 2 列。把橫幅當表頭的後果是
 * 每一欄都掛上同一個欄位名——「中華民國」與「37993」變成同一個欄位的兩個值，
 * 檢索命中之後根本分不出哪個是國家、哪個是人數。
 *
 * 判定依據是「整列的內容來自同一個合併儲存格、且真的跨了不只一欄」：
 * 一般表頭列的每格各自為政（master 就是自己），不會誤判。
 */
function readRow(ws: Worksheet, r: number, width: number): { cells: string[]; banner: string | null } {
  const cells: string[] = [];
  const masters = new Set<string>();
  for (let c = 1; c <= width; c++) {
    const cell = ws.getCell(r, c);
    // master：合併儲存格的內容只存在主格，其餘格回填相同值。等同 HTML 表格展開 rowspan，
    // 不補的話被合併蓋住的列會少幾格，後面每一欄都往左位移，答案錯得理直氣壯
    const text = mdCell(cellText(cell.master.value));
    cells.push(text);
    if (text !== '') masters.add(cell.master.address);
  }
  const spread = cells.filter((v) => v !== '').length;
  const banner = masters.size === 1 && spread > 1 ? (cells.find((v) => v !== '') ?? null) : null;
  return { cells, banner };
}

/** 一個子表：自己的橫幅（可能沒有）與資料列，首列為表頭 */
interface SheetBlock {
  banner: string | null;
  rows: string[][];
}

/** 資料列 → Markdown 表格；無內容回空字串。首列當表頭（GFM 語法要求要有表頭列） */
function renderTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  // 收斂寬度：columnCount 取的是最右一個「曾被寫入」的欄，殘留的格式設定常讓它遠超實際
  // 資料範圍，不裁掉會產出整片空欄的表格
  const cols = Math.max(...rows.map(usedWidth));
  if (cols === 0) return '';
  const cells = rows.map((r) => r.slice(0, cols));
  return [
    `| ${cells[0].join(' | ')} |`,
    `| ${cells[0].map(() => '---').join(' | ')} |`,
    ...cells.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/**
 * 單一工作表 → Markdown；無內容回空字串。
 *
 * 一張工作表可以堆疊多個子表（各自帶橫幅與表頭，以空白列分隔），所以**由橫幅列開啟
 * 新子表**，而不是以空白列切割：空白列在單一表格中間也很常見，拿它當邊界會把一張
 * 完整的表切成兩半，而且第二半的首列會被誤當成表頭。
 *
 * 橫幅輸出成三級標題，讓 chunkMarkdown 把它併進標題路徑——每個資料列切出的 chunk
 * 於是自帶「哪個展覽、哪一年」，不必再依賴上下文。
 */
function sheetBlocks(ws: Worksheet): SheetBlock[] {
  const width = ws.columnCount;
  const height = Math.min(ws.rowCount, MAX_SHEET_ROWS);
  if (width < 1 || height < 1) return [];

  const blocks: SheetBlock[] = [];
  let current: SheetBlock | null = null;

  for (let r = 1; r <= height; r++) {
    const { cells, banner } = readRow(ws, r, width);
    if (usedWidth(cells) === 0) continue; // 整列皆空 = 純排版留白，不進索引也不切割
    if (banner !== null) {
      current = { banner, rows: [] };
      blocks.push(current);
      continue;
    }
    if (current === null) {
      current = { banner: null, rows: [] };
      blocks.push(current);
    }
    current.rows.push(cells);
  }
  return blocks;
}

/** 區塊 → Markdown（供 RAG 切塊使用） */
function sheetToMarkdown(ws: Worksheet): string {
  const blocks = sheetBlocks(ws);
  const height = Math.min(ws.rowCount, MAX_SHEET_ROWS);

  const parts: string[] = [];
  for (const b of blocks) {
    const table = renderTable(b.rows);
    if (!table) continue;
    parts.push(b.banner === null ? table : `### ${b.banner}\n\n${table}`);
  }
  if (parts.length === 0) return '';
  if (ws.rowCount > height) {
    parts.push(`（此工作表共 ${ws.rowCount} 列，僅擷取前 ${MAX_SHEET_ROWS} 列）`);
  }
  return parts.join('\n\n');
}

/**
 * 區塊 → 結構化表（供報告精確計算使用）。首列是表頭，其餘是資料列。
 * 只有一列（表頭沒有資料）的區塊不收：對計算沒有意義。
 */
function blockToTable(sheet: string, b: SheetBlock): ParsedTable | null {
  if (b.rows.length < 2) return null;
  const cols = Math.max(...b.rows.map(usedWidth));
  if (cols === 0) return null;
  const [headers, ...rows] = b.rows.map((r) => r.slice(0, cols));
  return {
    sheet,
    ...(b.banner === null ? {} : { caption: b.banner }),
    headers,
    rows,
  };
}

async function parseXlsxDoc(buf: Buffer): Promise<{ text: string; tables: ParsedTable[] }> {
  const wb = new Workbook();
  // exceljs 的型別宣告裡 `declare interface Buffer extends ArrayBuffer {}` 是其套件內的區域
  // 型別，並非 Node 的 Buffer，因此與 @types/node 對不起來。執行期收的就是 Node Buffer，
  // 這個轉型只是繞過該套件的型別瑕疵。
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const parts: string[] = [];
  const tables: ParsedTable[] = [];
  for (const ws of wb.worksheets) {
    // 隱藏工作表通常是查表資料或計算暫存，不是給人讀的內容——比照 sanitizeHtml 移除非正文節點
    if (ws.state === 'hidden' || ws.state === 'veryHidden') {
      logger.warn({ sheet: ws.name }, 'xlsx hidden sheet skipped');
      continue;
    }
    for (const b of sheetBlocks(ws)) {
      const table = blockToTable(ws.name, b);
      if (table) tables.push(table);
    }
    const md = sheetToMarkdown(ws);
    if (!md) continue;
    // 工作表名當標題：切塊後 chunk 才帶得到「這張表在講什麼」，否則只剩一堆無主的數字列
    parts.push(`## ${ws.name}\n\n${md}`);
  }
  return { text: parts.join('\n\n'), tables };
}

async function parseLegacyDoc(buf: Buffer): Promise<string> {
  const doc = await new WordExtractor().extract(buf);
  return doc.getBody();
}

/**
 * 解析上傳檔，回傳文字與其結構保真度。
 * fidelity='text' 的來源（doc/pdf）建議使用者改上傳 docx，準確度差距來自結構而非文字抽取。
 */
export async function parseDocument(name: string, buf: Buffer): Promise<ParsedDoc> {
  const format = detectFormat(name, buf);
  switch (format) {
    case 'txt':
    case 'md':
      return { text: decodeText(buf), format, fidelity: format === 'md' ? 'structured' : 'text' };
    case 'html':
      return { text: htmlToMarkdown(decodeText(buf, { html: true })), format, fidelity: 'structured' };
    case 'docx':
      return { text: await parseDocx(buf), format, fidelity: 'structured' };
    case 'xlsx': {
      const { text, tables } = await parseXlsxDoc(buf);
      return { text, format, fidelity: 'structured', tables };
    }
    case 'doc':
      return { text: await parseLegacyDoc(buf), format, fidelity: 'text' };
    case 'pdf':
      return { text: await parsePdf(buf), format, fidelity: 'text' };
  }
}
