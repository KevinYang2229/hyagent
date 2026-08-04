/* 知識庫 ingest 服務：爬取靜態網站→抽正文→切段→embedding→產生每租戶索引。CLI 與 admin API 共用。 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { getEmbeddingProvider, type EmbeddingProvider } from '@/lib/embedding';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { loadIndex, saveIndex } from './knowledge.index.repo';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';

// 注意：carryOverFileChunks 定義於本檔（而非 knowledge-file.service.ts），
// 是為了維持單向依賴——knowledge-file.service 已經需要 import 本檔的 chunkText/squash，
// 若反過來讓本檔 import knowledge-file.service 會形成循環引用。

export interface IngestParams {
  tenantId: string;
  startUrl: string;
  maxPages: number;
  pathPrefix?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  chunkChars: number;
  embeddingModel: string;
}
export interface IngestProgress {
  phase: 'crawling' | 'embedding' | 'done';
  pagesCrawled: number;
  chunks: number;
  embedded: number;
}

const EMBED_BATCH = 64;
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
 * 分批向量化，回傳與輸入順序對應的向量。
 * onBatch 於每批完成後呼叫（用量歸戶／進度回報），失敗時已完成的批次用量仍已記錄。
 */
export async function embedInBatches(
  embedder: EmbeddingProvider,
  texts: string[],
  model: string,
  onBatch?: (tokens: number, embedded: number) => void,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const batch of planEmbedBatches(texts)) {
    const res = await embedder.embed(batch, model);
    vectors.push(...res.vectors);
    onBatch?.(res.tokens, vectors.length);
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

export function extractPage(html: string): { title: string; sections: { heading: string; text: string }[] } {
  const $ = cheerio.load(html);
  const footerText = squash($('footer').text());
  $('script, style, noscript, nav, header, footer, aside, form, svg, iframe').remove();
  const title = squash($('title').first().text() || $('h1').first().text() || '');
  const root = $('main').length ? $('main') : $('body');
  const sections: { heading: string; text: string }[] = [];
  root.find('h1, h2, h3').each((_, el) => {
    const $el = $(el);
    const text = squash($el.nextUntil('h1, h2, h3').text());
    if (text.length >= 20) sections.push({ heading: squash($el.text()), text });
  });
  if (sections.length === 0) {
    const text = squash(root.text());
    if (text.length >= 40) sections.push({ heading: '', text });
  }
  if (footerText.length >= 20) sections.push({ heading: '聯絡資訊', text: footerText });
  return { title, sections };
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
 * （網站爬取沿用預設 0，維持既有行為；檔案來源由 chunkMarkdown 指定）。
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
  const overlap = Math.round(maxLen * OVERLAP_RATIO);
  const out: string[] = [];
  const path: string[] = []; // index = 標題層級 - 1
  let body: string[] = [];
  const prefixOf = (): string => path.filter(Boolean).join(' > ');

  const flush = (): void => {
    const text = body.join('\n').trim();
    body = [];
    if (!text) return;
    const prefix = prefixOf();
    const budget = Math.max(MIN_BODY_CHARS, maxLen - prefix.length - 1);
    for (const piece of chunkText(text, budget, overlap)) {
      out.push(prefix ? `${prefix}\n${piece}` : piece);
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
        out.push(...chunkTableRow(table.headers, cells, prefixOf(), maxLen, overlap));
      }
      i = table.end;
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
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
  const pages: { url: string; title: string; sections: { heading: string; text: string }[] }[] = [];

  while (queue.length && pages.length < params.maxPages) {
    const url = queue.shift() as string;
    if (seen.has(url) || !allowed(url, params)) continue;
    seen.add(url);
    try {
      const resp = await fetch(url, { headers: { 'user-agent': 'oa-agent-knowledge-ingest' } });
      const ct = resp.headers.get('content-type') ?? '';
      if (!resp.ok || !ct.includes('text/html')) continue;
      const html = await resp.text();
      const { title, sections } = extractPage(html);
      if (sections.length) pages.push({ url, title: title || url, sections });
      for (const link of extractLinks(html, url, origin)) if (!seen.has(link)) queue.push(link);
      onProgress?.({ phase: 'crawling', pagesCrawled: pages.length, chunks: 0, embedded: 0 });
    } catch (err) {
      logger.warn({ err, url }, 'ingest page failed');
    }
  }

  const seenHash = new Set<string>();
  const pending: Omit<IndexedChunk, 'vector'>[] = [];
  for (const page of pages) {
    for (const section of page.sections) {
      const crumb = [page.title, section.heading].filter(Boolean).join(' › ');
      chunkText(section.text, params.chunkChars).forEach((body, i) => {
        const text = crumb ? `${crumb}\n${body}` : body;
        const hash = createHash('sha1').update(text).digest('hex');
        if (seenHash.has(hash)) return;
        seenHash.add(hash);
        pending.push({ id: `${hash.slice(0, 12)}-${i}`, url: page.url, title: crumb || page.title, text });
      });
    }
  }

  const embedder = getEmbeddingProvider(tenantStore.getTenant(params.tenantId)?.llmConfig);
  const vectors = await embedInBatches(
    embedder,
    pending.map((c) => c.text),
    params.embeddingModel,
    (tokens, embedded) => {
      usageStore.recordEmbeddingUsage(params.tenantId, tokens, params.embeddingModel, embedder.keySource);
      onProgress?.({ phase: 'embedding', pagesCrawled: pages.length, chunks: pending.length, embedded });
    },
  );
  const chunks: IndexedChunk[] = pending.map((c, i) => ({ ...c, vector: vectors[i] }));

  // 重爬會整批重建網站 chunks；寫回前併入既有索引中帶 fileId 的檔案來源 chunks，避免蓋掉上傳檔內容
  const existing = await loadIndex(params.tenantId);
  const mergedChunks = carryOverFileChunks(existing, chunks);
  const index: KnowledgeIndexFile = {
    generatedAt: new Date().toISOString(),
    model: params.embeddingModel,
    source: params.startUrl,
    chunks: mergedChunks,
  };
  await saveIndex(params.tenantId, index);
  onProgress?.({ phase: 'done', pagesCrawled: pages.length, chunks: pending.length, embedded: chunks.length });
  return index;
}
