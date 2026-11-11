/* 知識庫 ingest 服務：爬取靜態網站→抽正文→切段→embedding→產生每租戶索引。CLI 與 admin API 共用。 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { getEmbeddingProvider, type EmbeddingProvider } from '@/lib/embedding';
import { logger } from '@/lib/logger';
import { publicOnlyFetch } from '@/lib/public-network';
import { AppError } from '@/utils/app-error';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { replaceWebsiteChunks } from './knowledge.index.repo';
import { htmlToMarkdown } from './doc-parse';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';
import { knowledgeStore } from './knowledge.store';
import { WebsiteBrowser } from './website-browser';
import { MAX_WEBSITE_CHUNKS, MAX_WEBSITE_TEXT_CHARS, WebsiteIngestLimitError, assertWebsiteHeapBudget, readWebsiteHtml } from './website-limits';

// 注意：carryOverFileChunks 定義於本檔（而非 knowledge-file.service.ts），
// 是為了維持單向依賴——knowledge-file.service 已經需要 import 本檔的 chunkText/squash，
// 若反過來讓本檔 import knowledge-file.service 會形成循環引用。

export interface IngestParams {
  tenantId: string;
  startUrl: string;
  renderJavaScript?: boolean;
  renderWaitMs?: number;
  maxPages: number;
  pathPrefix?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  chunkChars: number;
  embeddingModel: string;
  /** 租戶管理者設定的來源：只連公開網段（publicOnlyFetch），且不啟動瀏覽器渲染 */
  restrictNetwork?: boolean;
}
export interface IngestProgress {
  phase: 'crawling' | 'embedding' | 'done';
  pagesCrawled: number;
  chunks: number;
  embedded: number;
}

export const EMBED_BATCH = 64;
/**
 * 單次 embedding 請求的字元上限。
 *
 * OpenAI embeddings 端點的硬限制是 300k tokens/request（超過回 400 Invalid 'input'），
 * 中文約 1 字元 ≈ 1 token。只靠 64 筆的筆數上限擋不住：chunkChars 最大可設到 4000，
 * 64 × 4000 = 256k 字元就已逼近硬限制，故另外加一道字元預算，取 100k 留足安全邊際。
 */
const EMBED_BATCH_CHARS = 100_000;

/**
 * 依「筆數 + 字元數」雙上限切批。單筆本身超過字元預算時自成一批（不可能再切小，
 * 交給 API 判定；chunkChars 上限 4000、摘要上限 24000 字元，實務上不會發生）。
 */
export function planEmbedBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (batch.length > 0 && (batch.length >= EMBED_BATCH || chars + t.length > EMBED_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(t);
    chars += t.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * 分批向量化，每批算完立刻 yield 出去，**不累積整份向量**。
 *
 * 這是大檔匯入的記憶體上界所在。halfvec(3072) 的一個向量在 V8 裡約 25KB，轉成寫入用的
 * 文字字面值又是 59KB；「先全部算完再全部寫出」的寫法讓峰值隨檔案大小線性成長，1200 個
 * chunk 實測就從 43MB 漲到 330MB，容器記憶體一到頂就是 SIGKILL——沒有例外、沒有 500、
 * 沒有補償刪除，只留下孤兒 chunks 和瀏覽器端一個看起來毫不相干的 CORS 錯誤。
 *
 * 呼叫端消化完一批才會拿到下一批（generator 的背壓天生如此），峰值於是被壓在 O(單批)。
 * offset 是該批第一筆在原始 texts 中的索引，供呼叫端對回自己的資料。
 */
export async function* embedBatchesStreamed(
  embedder: EmbeddingProvider,
  texts: string[],
  model: string,
  onBatch?: (tokens: number, embedded: number) => void,
): AsyncGenerator<{ vectors: number[][]; offset: number }> {
  let offset = 0;
  for (const batch of planEmbedBatches(texts)) {
    const res = await embedder.embed(batch, model);
    yield { vectors: res.vectors, offset };
    offset += batch.length;
    onBatch?.(res.tokens, offset);
  }
}

/**
 * 分批向量化，回傳與輸入順序對應的向量。
 * onBatch 於每批完成後呼叫（用量歸戶／進度回報），失敗時已完成的批次用量仍已記錄。
 *
 * **會把整份向量握在記憶體裡**，僅適用於總量可控的呼叫端（如表格描述句，一張表一筆）。
 * 使用者上傳的檔案走 embedBatchesStreamed，理由見該函式註解。
 */
export async function embedInBatches(
  embedder: EmbeddingProvider,
  texts: string[],
  model: string,
  onBatch?: (tokens: number, embedded: number) => void,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for await (const { vectors: batch } of embedBatchesStreamed(embedder, texts, model, onBatch)) {
    vectors.push(...batch);
  }
  return vectors;
}

export function squash(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

/**
 * 文件文字正規化。與 squash 的差別只有一個但很關鍵：**保留段落換行**。
 *
 * squash 服務的是 HTML 文字節點——那裡的換行是排版產物、壓掉才對；
 * 但檔案解析結果的換行是語意邊界，一旦壓成空格，chunkText 的 `\n` 切點就永遠不會觸發，
 * 段落被硬湊成 maxLen 一塊。Markdown 的標題行也會黏進前一段而失去結構。
 */
export function normalizeDocText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ') // 只壓水平空白
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n') // 段落之間最多留一個空行
    .trim();
}

/**
 * 網站重爬寫索引前呼叫：新的 web chunks + 既有索引中帶 fileId 的檔案來源 chunks。
 * 檔案來源與網站來源分屬不同管線各自 ingest，重爬只重建網站部分，檔案 chunks 原樣保留。
 */
export function carryOverFileChunks(
  existing: KnowledgeIndexFile | null,
  webChunks: IndexedChunk[],
): IndexedChunk[] {
  const fileChunks = existing?.chunks.filter((c) => c.fileId) ?? [];
  return [...webChunks, ...fileChunks];
}

export function normalizeUrl(href: string, base: string, origin: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.origin !== origin) return null;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i.test(u.pathname)) return null;
    u.hash = ''; u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch { return null; }
}

/** 網站單頁的抽取結果：正文已轉成 Markdown，交給 chunkWebsitePage 依標題切塊。 */
export interface WebsitePage {
  title: string;
  markdown: string;
}

/**
 * 抽出頁面正文並轉成 Markdown。
 *
 * 舊做法是「找每個 h1–h3，再抓它後面的同層元素」，實測會：漏掉第一個標題前的內容
 * （首頁簡介、文章導言）、把包在容器裡的標題底下的內容併進前一節、子標題的內容收錄兩次。
 * 改成依文件順序轉 Markdown 後走與上傳檔案相同的 chunkMarkdown，這些問題一次消失，
 * 也順帶得到完整標題路徑、片段重疊與表格逐列切塊。
 */
export function extractPage(html: string): WebsitePage {
  const $ = cheerio.load(html);
  const footerText = squash($('footer').text());
  // 頁首、頁尾、導覽列與側欄是每頁重複的版型，不是正文；頁尾的聯絡資訊另外收成一節
  $('script, style, noscript, nav, header, footer, aside, form, svg, iframe').remove();
  const title = squash($('title').first().text() || $('h1').first().text() || '').slice(0, 500);
  const root = $('main').length ? $('main').first() : $('body');
  const body = normalizeDocText(htmlToMarkdown($.html(root) ?? ''));
  if (body.length > MAX_WEBSITE_TEXT_CHARS) throw new WebsiteIngestLimitError('單頁抽取文字超過 200 萬字元');
  const footer = footerText.length >= 20 ? `\n\n# 聯絡資訊\n${footerText}` : '';
  return { title, markdown: `${body}${footer}` };
}

/** 網站頁面切塊：title 為「站名 > 章節路徑」，供引用出處顯示；text 開頭同樣帶這段路徑。 */
export function chunkWebsitePage(page: WebsitePage, maxLen: number): { title: string; text: string }[] {
  return chunkMarkdownSections(page.markdown, maxLen, page.title).map(({ prefix, text }) => ({ title: prefix, text }));
}

export function extractLinks(html: string, base: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const n = normalizeUrl($(el).attr('href') ?? '', base, origin);
    if (n) links.push(n);
  });
  return links;
}

/**
 * 依句尾/換行切句後湊滿 maxLen 成塊。
 * overlap > 0 時，每塊結尾的 overlap 字元會複製到下一塊開頭，避免答案剛好被切在邊界上
 * （網站與檔案來源都經 chunkMarkdown 指定重疊比例）。
 */
export function chunkText(text: string, maxLen = 800, overlap = 0): string[] {
  const sentences = text.split(/(?<=[。！？；!?;\n])/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  const tailOf = (s: string): string => (overlap > 0 ? s.slice(-overlap) : '');
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > maxLen && buf) { chunks.push(buf.trim()); buf = tailOf(buf.trim()); }
    if (s.length > maxLen) for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen));
    else buf += s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length >= 20);
}

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** chunk 內留給標題路徑的字元預算下限，避免深層標題把正文擠光 */
const MIN_BODY_CHARS = 200;
/** 重疊比例：夠讓被切斷的句子在下一塊留有前文，又不至於灌爆索引體積 */
const OVERLAP_RATIO = 0.12;

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;
/** 「欄位：值」的分隔符（全形冒號，與中文表格用語一致） */
const FIELD_SEP = '：';
/**
 * 可充當識別鍵的欄位長度上限。代號、日期、單位這類短欄位重複帶進每個片段成本低、
 * 辨識價值高；長敘述欄位重複帶會把 chunk 撐爆。
 */
const KEY_FIELD_MAX_CHARS = 40;

interface MarkdownTable {
  headers: string[];
  rows: string[][];
  /** 表格最後一行在原陣列中的索引 */
  end: number;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 自 start 起讀取一個 Markdown 表格；該處不是表格則回 null */
function readTable(lines: string[], start: number): MarkdownTable | null {
  if (!TABLE_ROW.test(lines[start] ?? '') || !TABLE_DIVIDER.test(lines[start + 1] ?? '')) return null;
  const headers = splitTableRow(lines[start]);
  const rows: string[][] = [];
  let i = start + 2;
  for (; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
    if (TABLE_DIVIDER.test(lines[i])) continue;
    const cells = splitTableRow(lines[i]);
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  }
  return { headers, rows, end: i - 1 };
}

/**
 * 一列一 chunk，並改寫成「欄位：值」而非 Markdown 管線列。
 *
 * 管線列切開後只剩 `| 430-05 | 教育文化處 | ... |`，表頭留在第一塊裡，其餘 chunk 無從得知
 * 哪一欄是「主辦單位」。改成每列自帶欄位名後，每個 chunk 都是完整且自我描述的一筆記錄，
 * 對 embedding 與作答模型都不必再依賴上下文。
 */
function chunkTableRow(
  headers: string[],
  cells: string[],
  prefix: string,
  maxLen: number,
  overlap: number,
): string[] {
  const nameOf = (i: number): string => headers[i]?.trim() || `欄位${i + 1}`;
  const valueOf = (i: number): string => cells[i]?.trim() ?? '';
  const indices = headers.map((_, i) => i).filter((i) => valueOf(i).length > 0);
  const field = (i: number): string => `${nameOf(i)}${FIELD_SEP}${valueOf(i)}`;

  const full = [prefix, ...indices.map(field)].filter(Boolean).join('\n');
  if (full.length <= maxLen) return [full];

  // 過長：短欄位當識別鍵重複帶進每一片段，長敘述欄位才切開
  const keys = indices.filter((i) => valueOf(i).length <= KEY_FIELD_MAX_CHARS);
  const head = [prefix, ...keys.map(field)].filter(Boolean).join('\n');
  const out: string[] = [];
  for (const i of indices) {
    if (keys.includes(i)) continue;
    const budget = Math.max(MIN_BODY_CHARS, maxLen - head.length - nameOf(i).length - 2);
    for (const piece of chunkText(valueOf(i), budget, overlap)) {
      out.push(`${head}\n${nameOf(i)}${FIELD_SEP}${piece}`);
    }
  }
  return out.length > 0 ? out : chunkText(full, maxLen, overlap);
}

/**
 * Markdown 感知切塊：先依標題分節，節內再按長度切，每塊前面補上「標題路徑」。
 *
 * 兩個目的：切點落在語意邊界而不是湊字數；chunk 自帶所屬章節，retrieval 命中後
 * LLM 才知道這段在講哪一節（先前每塊都是無標題散文，跨節的內容互相污染）。
 * 純文字來源（doc/pdf）沒有標題行，會自然退化成單一無前綴的節，行為與過去一致。
 */
export function chunkMarkdown(md: string, maxLen = 800): string[] {
  return chunkMarkdownSections(md, maxLen).map((c) => c.text);
}

/**
 * chunkMarkdown 的本體，另外回傳每塊的標題路徑（prefix）。
 * root 會放在標題路徑最前面（網站用頁面標題），讓沒有標題的段落也知道出自哪一頁。
 */
function chunkMarkdownSections(md: string, maxLen: number, root?: string): { prefix: string; text: string }[] {
  const overlap = Math.round(maxLen * OVERLAP_RATIO);
  const out: { prefix: string; text: string }[] = [];
  const path: string[] = []; // index = 標題層級 - 1
  let body: string[] = [];
  const prefixOf = (): string => [root, ...path].filter(Boolean).join(' > ');

  const flush = (): void => {
    const text = body.join('\n').trim();
    body = [];
    if (!text) return;
    const prefix = prefixOf();
    const budget = Math.max(MIN_BODY_CHARS, maxLen - prefix.length - 1);
    for (const piece of chunkText(text, budget, overlap)) {
      out.push({ prefix, text: prefix ? `${prefix}\n${piece}` : piece });
    }
  };

  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = MD_HEADING.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      path.length = level - 1; // 進入新標題即捨棄同級與更深的路徑
      path[level - 1] = m[2];
      continue;
    }
    const table = readTable(lines, i);
    if (table) {
      flush(); // 表格前的散文先各自成塊，不與表格混在一起
      for (const cells of table.rows) {
        const prefix = prefixOf();
        out.push(...chunkTableRow(table.headers, cells, prefix, maxLen, overlap).map((text) => ({ prefix, text })));
      }
      i = table.end;
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
}

/** 起始頁抓取錯誤的可讀說明：fetch 的 TypeError 只說 'fetch failed'，真正原因在 cause.code */
function describeFetchError(err: unknown): string {
  // AbortSignal.timeout 丟的是 DOMException，不一定是 Error 的實例，改看 name
  const name = (err as { name?: string } | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return '連線逾時';
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${message}（${detail}）` : message;
}

function allowed(url: string, p: IngestParams): boolean {
  const path = new URL(url).pathname;
  if (p.pathPrefix && !path.startsWith(p.pathPrefix)) return false;
  if (p.excludePatterns?.some((re) => new RegExp(re).test(url))) return false;
  if (p.includePatterns?.length && !p.includePatterns.some((re) => new RegExp(re).test(url))) return false;
  return true;
}

export async function runIngest(
  params: IngestParams,
  onProgress?: (p: IngestProgress) => void,
): Promise<KnowledgeIndexFile> {
  const origin = new URL(params.startUrl).origin;
  const seen = new Set<string>();
  const start = normalizeUrl(params.startUrl, params.startUrl, origin) ?? params.startUrl;
  const queue: string[] = [start];
  const scheduled = new Set<string>([start]);
  const seenHash = new Set<string>();
  const pending: Omit<IndexedChunk, 'vector'>[] = [];
  let pagesCrawled = 0;
  let totalTextChars = 0;
  // 起始頁沒產出內容的原因；最後沒有任何片段時帶進錯誤訊息，讓後台看得到為何失敗
  let startIssue: string | undefined;
  logger.info({ tenantId: params.tenantId, maxPages: params.maxPages,
    renderJavaScript: !!params.renderJavaScript,
    heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }, 'website crawl started');

  const restricted = !!params.restrictNetwork;
  // 瀏覽器自行解析 DNS、連線無法釘在檢查過的位址，旗標來源一律改用靜態抓取
  const browser = params.renderJavaScript && !restricted ? new WebsiteBrowser() : undefined;
  try {
    assertWebsiteHeapBudget();
    if (browser) await browser.open();
    while (queue.length && seen.size < params.maxPages) {
      const url = queue.shift() as string;
      if (seen.has(url) || !allowed(url, params)) {
        if (url === start) startIssue = '起始網址不符合路徑前綴或包含／排除規則';
        continue;
      }
      seen.add(url);
      try {
        assertWebsiteHeapBudget();
        let html: string;
        let pageUrl = url;
        if (browser) {
          const rendered = await browser.load(url, params.renderWaitMs ?? 1500);
          html = rendered.html;
          pageUrl = rendered.url;
          if (!allowed(pageUrl, params)) throw new Error('網站跳轉至解析範圍之外');
        } else {
          const init = { headers: { 'user-agent': 'oa-agent-knowledge-ingest' }, signal: AbortSignal.timeout(30_000) };
          const resp = restricted ? await publicOnlyFetch(url, init) : await fetch(url, init);
          const ct = resp.headers.get('content-type') ?? '';
          if (!resp.ok || !ct.includes('text/html')) {
            if (url === start) {
              startIssue = !resp.ok ? `起始頁回應 HTTP ${resp.status}` : `起始頁不是 HTML（content-type: ${ct || '未提供'}）`;
            }
            await resp.body?.cancel();
            continue;
          }
          html = await readWebsiteHtml(resp);
        }
        const page = extractPage(html);
        totalTextChars += page.markdown.length;
        if (totalTextChars > MAX_WEBSITE_TEXT_CHARS) {
          throw new WebsiteIngestLimitError('網站文字總量超過 200 萬字元');
        }
        // 逐頁切段後不保留整站原文，避免與全部向量同時占用 heap。
        const pageChunks = chunkWebsitePage(page, params.chunkChars);
        if (pageChunks.length) pagesCrawled += 1;
        else if (url === start) {
          startIssue = browser ? '起始頁沒有可抽取的正文' : '起始頁沒有可抽取的正文，若內容由 JavaScript 動態產生，需開啟 JavaScript 渲染';
        }
        for (const [i, chunk] of pageChunks.entries()) {
          // 頁尾等每頁重複的片段以內容雜湊去重，只收一次
          const hash = createHash('sha1').update(chunk.text).digest('hex');
          if (seenHash.has(hash)) continue;
          if (pending.length >= MAX_WEBSITE_CHUNKS) {
            throw new WebsiteIngestLimitError(`網站片段超過 ${MAX_WEBSITE_CHUNKS} 筆`);
          }
          seenHash.add(hash);
          pending.push({ id: `${hash.slice(0, 12)}-${i}`, url: pageUrl, title: chunk.title || pageUrl, text: chunk.text });
        }
        for (const link of extractLinks(html, pageUrl, origin)) {
          if (scheduled.has(link) || !allowed(link, params)) continue;
          // 佇列只保留有限候選，避免每頁重複導覽連結或無正文頁讓工作量無上限。
          if (scheduled.size >= params.maxPages * 10) break;
          scheduled.add(link);
          queue.push(link);
        }
        onProgress?.({ phase: 'crawling', pagesCrawled, chunks: pending.length, embedded: 0 });
      } catch (err) {
        // 起始頁渲染失敗時直接回報，避免把登入頁或空內容寫成成功索引。
        // 旗標來源的起始頁被公開網段限制擋下時也直接回報，讓管理者看得到原因
        if (err instanceof WebsiteIngestLimitError || (browser && url === start)
          || (restricted && url === start && err instanceof AppError)) throw err;
        if (url === start) startIssue = `起始頁抓取失敗：${describeFetchError(err)}`;
        logger.warn({ err, url }, 'ingest page failed');
      }
    }
  } finally {
    await browser?.close();
  }
  if (pending.length === 0) {
    throw new Error(`沒有可解析的文字內容，原有索引未變更${startIssue ? `（${startIssue}）` : ''}`);
  }
  assertWebsiteHeapBudget();
  logger.info({ tenantId: params.tenantId, pagesCrawled, chunks: pending.length,
    heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }, 'website crawl ready for embedding');

  const embedder = getEmbeddingProvider(tenantStore.getTenant(params.tenantId)?.llmConfig, params.tenantId);
  const vectors = await embedInBatches(
    embedder,
    pending.map((c) => c.text),
    params.embeddingModel,
    (tokens, embedded) => {
      usageStore.recordEmbeddingUsage(params.tenantId, tokens, params.embeddingModel, embedder.keySource);
      assertWebsiteHeapBudget();
      onProgress?.({ phase: 'embedding', pagesCrawled, chunks: pending.length, embedded });
    },
  );
  // 網站來源的標籤掛在來源設定上（整個網站一組）。重爬會刪掉 file_id is null 的列再塞回，
  // 因此每次都必須重新蓋章——標籤的真相來源是 KnowledgeSource，不是上一輪的 chunk。
  const sourceScopes = knowledgeStore.getSource(params.tenantId).visibilityScopes;
  const chunks: IndexedChunk[] = pending.map((c, i) => ({
    ...c,
    vector: vectors[i],
    ...(sourceScopes ? { visibilityScopes: sourceScopes } : {}),
  }));
  assertWebsiteHeapBudget();
  logger.info({ tenantId: params.tenantId, chunks: chunks.length,
    heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }, 'website embedding ready for index write');

  /*
   * 重爬只整批重建「網站」chunks，檔案來源的 chunks 由 replaceWebsiteChunks 在資料層原地保留。
   *
   * 原本是「loadIndex 整份撈回 → carryOverFileChunks 併起來 → saveIndex 全部寫回」。
   * 那條路在檔案來源變多之後會從兩端一起崩：8.8k 個 chunk 的向量約 238MB，讀會撞
   * statement timeout、寫會撞交易逾時；而 saveIndex 先刪後寫，失敗時使用者上傳文件的
   * 向量已經沒了，重爬也產不回來。改成資料層只動網站那一半，這些風險全部不存在。
   *
   * 回傳的 index 因此只含本次爬到的網站 chunks（不再是「整份索引」）——需要全租戶視角的
   * 呼叫端請自行向資料層要（countChunksBySource / loadIndexText），見 knowledge.job。
   */
  const index: KnowledgeIndexFile = {
    generatedAt: new Date().toISOString(),
    model: params.embeddingModel,
    source: params.startUrl,
    chunks,
  };
  await replaceWebsiteChunks(params.tenantId, chunks, {
    generatedAt: index.generatedAt,
    model: index.model,
    source: index.source,
  });
  onProgress?.({ phase: 'done', pagesCrawled, chunks: pending.length, embedded: chunks.length });
  return index;
}
