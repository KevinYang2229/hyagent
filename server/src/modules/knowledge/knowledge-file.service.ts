/**
 * 知識庫檔案來源：上傳檔解析成文字，沿用 chunk/embedding 管線附加進租戶索引（chunk 標 fileId）。
 * 與網站來源並存：網站重爬經 carryOverFileChunks（定義於 ingest.service）保留檔案 chunks；刪檔只移除該檔 chunks。
 * 不保存原始檔（重傳即更新）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { getEmbeddingProvider } from '@/lib/embedding';
import { AppError } from '@/utils/app-error';
import { indexPathFor } from './index-path';
// carryOverFileChunks 從 ingest.service 匯入（而非本檔自行定義），維持單向依賴：
// 本檔已需要 ingest.service 的 chunkText/squash，若 ingest.service 反過來 import 本檔會形成循環引用。
import { carryOverFileChunks, chunkText, squash } from './ingest.service';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';
import { knowledgeStore, type KnowledgeFileMeta } from './knowledge.store';
import { invalidateIndexCache } from './retriever.staticIndex';

export type { KnowledgeFileMeta };
export { carryOverFileChunks };

const MIN_TEXT_CHARS = 20;

/**
 * 依副檔名解析為純文字；不支援的副檔名回 400。
 *
 * pdf-parse 已升級為 2.x（class-based API：`new PDFParse({ data }).getText()`，
 * 不再是 1.x 的 `pdfParse(buffer)` 單一函式），故採官方新版 API 呼叫方式。
 */
export async function parseFileToText(name: string, buf: Buffer): Promise<string> {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext === '.txt' || ext === '.md') return buf.toString('utf8');
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buf });
    try {
      const out = await parser.getText();
      return out.text ?? '';
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') {
    const out = await mammoth.extractRawText({ buffer: buf });
    return out.value ?? '';
  }
  throw AppError.badRequest(`不支援的檔案格式：${ext}（支援 .txt/.md/.pdf/.docx）`);
}

function loadIndexFile(tenantId: string): KnowledgeIndexFile | null {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
}

function saveIndexFile(tenantId: string, idx: KnowledgeIndexFile): void {
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx));
  invalidateIndexCache(tenantId);
}

/** 上傳檔 ingest：解析→切塊→embed→附加索引→meta.files。解析成功前不動索引/meta。 */
export async function ingestFile(
  tenantId: string,
  name: string,
  buf: Buffer,
): Promise<KnowledgeFileMeta> {
  const text = squash(await parseFileToText(name, buf));
  if (text.length < MIN_TEXT_CHARS) {
    throw AppError.unprocessable('無可抽取文字（可能為掃描檔或空檔）');
  }
  const source = knowledgeStore.getSource(tenantId);
  const pieces = chunkText(text, source.chunkChars);

  const existing = loadIndexFile(tenantId);
  // 模型一致性：同一份索引只能用同一個 embedding 模型
  const model = existing?.model ?? source.embeddingModel;
  const vectors = await getEmbeddingProvider().embed(pieces, model);

  const fileId = randomUUID();
  const fileChunks: IndexedChunk[] = pieces.map((t, i) => ({
    id: `${fileId}-${i}`,
    url: `file://${name}`,
    title: name,
    text: t,
    vector: vectors[i],
    fileId,
  }));

  const idx: KnowledgeIndexFile = existing
    ? { ...existing, generatedAt: new Date().toISOString(), chunks: [...existing.chunks, ...fileChunks] }
    : {
        generatedAt: new Date().toISOString(),
        model,
        source: `file://${name}`,
        chunks: fileChunks,
      };
  saveIndexFile(tenantId, idx);

  const fileMeta: KnowledgeFileMeta = {
    fileId,
    name,
    chunks: fileChunks.length,
    ingestedAt: new Date().toISOString(),
  };
  const meta = knowledgeStore.getMeta(tenantId);
  knowledgeStore.setMeta(tenantId, {
    ...meta,
    status: 'ready',
    chunkCount: idx.chunks.length,
    generatedAt: idx.generatedAt,
    model: idx.model,
    files: [...(meta.files ?? []), fileMeta],
  });
  return fileMeta;
}

/** 刪除檔案：索引剔除該 fileId 的 chunks + meta 移除；查無回 false。 */
export function removeFile(tenantId: string, fileId: string): boolean {
  const meta = knowledgeStore.getMeta(tenantId);
  if (!meta.files?.some((f) => f.fileId === fileId)) return false;
  const existing = loadIndexFile(tenantId);
  if (existing) {
    const chunks = existing.chunks.filter((c) => c.fileId !== fileId);
    saveIndexFile(tenantId, { ...existing, generatedAt: new Date().toISOString(), chunks });
    knowledgeStore.setMeta(tenantId, {
      ...meta,
      chunkCount: chunks.length,
      files: meta.files.filter((f) => f.fileId !== fileId),
    });
  } else {
    knowledgeStore.setMeta(tenantId, { ...meta, files: meta.files.filter((f) => f.fileId !== fileId) });
  }
  return true;
}
