/* 知識庫 ingest 服務：爬取靜態網站→抽正文→切段→embedding→產生每租戶索引。CLI 與 admin API 共用。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cheerio from 'cheerio';
import { getEmbeddingProvider } from '@/lib/embedding';
import { logger } from '@/lib/logger';
import { indexPathFor } from './index-path';
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

export function squash(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

/** 讀取租戶既有索引檔；不存在則回 null（模組內共用，避免與 knowledge-file.service 重複實作）。 */
function loadExistingIndex(tenantId: string): KnowledgeIndexFile | null {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
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

export function chunkText(text: string, maxLen = 800): string[] {
  const sentences = text.split(/(?<=[。！？；!?;\n])/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > maxLen && buf) { chunks.push(buf.trim()); buf = ''; }
    if (s.length > maxLen) for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen));
    else buf += s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length >= 20);
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

  const embedder = getEmbeddingProvider();
  const chunks: IndexedChunk[] = [];
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const vectors = await embedder.embed(batch.map((c) => c.text), params.embeddingModel);
    batch.forEach((c, j) => chunks.push({ ...c, vector: vectors[j] }));
    onProgress?.({ phase: 'embedding', pagesCrawled: pages.length, chunks: pending.length, embedded: chunks.length });
  }

  // 重爬會整批重建網站 chunks；寫回前併入既有索引中帶 fileId 的檔案來源 chunks，避免蓋掉上傳檔內容
  const existing = loadExistingIndex(params.tenantId);
  const mergedChunks = carryOverFileChunks(existing, chunks);
  const index: KnowledgeIndexFile = {
    generatedAt: new Date().toISOString(),
    model: params.embeddingModel,
    source: params.startUrl,
    chunks: mergedChunks,
  };
  const path = indexPathFor(params.tenantId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index), 'utf8');
  onProgress?.({ phase: 'done', pagesCrawled: pages.length, chunks: pending.length, embedded: chunks.length });
  return index;
}
