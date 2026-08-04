/**
 * 知識庫檔案來源：上傳檔解析成文字，沿用 chunk/embedding 管線附加進租戶索引（chunk 標 fileId）。
 * 與網站來源並存：網站重爬經 carryOverFileChunks（定義於 ingest.service）保留檔案 chunks；刪檔只移除該檔 chunks。
 * 不保存原始檔（重傳即更新）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getEmbeddingProvider } from '@/lib/embedding';
import { getLLMProvider } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import { indexPathFor } from './index-path';
// carryOverFileChunks 從 ingest.service 匯入（而非本檔自行定義），維持單向依賴：
// 本檔已需要 ingest.service 的 chunkText/squash，若 ingest.service 反過來 import 本檔會形成循環引用。
import {
  carryOverFileChunks,
  chunkMarkdown,
  embedInBatches,
  normalizeDocText,
  squash,
} from './ingest.service';
import { parseDocument } from './doc-parse';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';
import { knowledgeStore, type KnowledgeFileMeta } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';
import { invalidateIndexCache } from './retriever.staticIndex';
import { countBySource } from './prompt-slots';

export type { KnowledgeFileMeta };
export { carryOverFileChunks };

const MIN_TEXT_CHARS = 20;

/** 摘要輸入上限：超長文件截前段即可（摘要只求鳥瞰，兼顧 token 成本） */
const SUMMARY_MAX_INPUT_CHARS = 24000;

/**
 * 全文摘要 chunk：入庫時先「消化一次」，讓籠統問題（這份文件在講什麼）有可命中的候選。
 * 只是多一個檢索候選、不取代原文 chunks；失敗一律回 null，匯入照常進行。
 */
async function summarizeText(tenantId: string, name: string, text: string): Promise<string | null> {
  try {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
      system: [
        '你是文件摘要員。將使用者提供的文件濃縮成 150~250 字的繁體中文摘要。',
        '只能濃縮原文內容，嚴禁補充原文沒有的資訊；專有名詞、代號、網址保留原文寫法。',
        '直接輸出摘要文字，不要任何前後綴或條列符號。',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `文件名稱：${name}\n\n${text.slice(0, SUMMARY_MAX_INPUT_CHARS)}` }],
        },
      ],
      maxTokens: 512,
      model: env.LLM_ROUTER_MODEL, // 摘要屬輔助任務，用便宜模型即可（同意圖分類器）
    });
    usageStore.recordLLMUsage(tenantId, result); // 摘要呼叫此前漏記用量，一併補上
    const summary = squash(result.text ?? '');
    return summary.length >= MIN_TEXT_CHARS ? summary : null;
  } catch (err) {
    logger.warn({ err, name }, 'file summary generation failed; ingest continues without summary');
    return null;
  }
}

/** 只要文字的呼叫端用這個；格式判定與各格式解析見 doc-parse。 */
export async function parseFileToText(name: string, buf: Buffer): Promise<string> {
  return (await parseDocument(name, buf)).text;
}

/** 直讀索引檔（不經 retriever 的記憶體快取）；無索引回 null */
export function loadIndexFile(tenantId: string): KnowledgeIndexFile | null {
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
  const parsed = await parseDocument(name, buf);
  // normalizeDocText（而非 squash）：保留段落與 Markdown 標題行，切塊才切得到語意邊界
  const text = normalizeDocText(parsed.text);
  if (text.length < MIN_TEXT_CHARS) {
    throw AppError.unprocessable('無可抽取文字（可能為掃描檔或空檔）');
  }
  const source = knowledgeStore.getSource(tenantId);
  const pieces = chunkMarkdown(text, source.chunkChars);

  // 單一 chunk 就是全文本身，摘要無增益；多 chunk 才值得花一次 LLM 呼叫
  const summary = pieces.length >= 2 ? await summarizeText(tenantId, name, text) : null;
  const toEmbed = summary ? [...pieces, summary] : pieces;

  const existing = loadIndexFile(tenantId);
  // 模型一致性：同一份索引只能用同一個 embedding 模型
  const model = existing?.model ?? source.embeddingModel;
  const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
  // 必須分批：整份文件一次送出會撞 embeddings 端點的 300k tokens/request 上限（400 Invalid 'input'）
  const vectors = await embedInBatches(embedder, toEmbed, model, (tokens) => {
    usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
  });

  const fileId = randomUUID();
  const fileChunks: IndexedChunk[] = pieces.map((t, i) => ({
    id: `${fileId}-${i}`,
    url: `file://${name}`,
    title: name,
    text: t,
    vector: vectors[i],
    fileId,
  }));
  if (summary) {
    // 標明「全文摘要」讓回答模型知道這是衍生內容，細節仍以原文 chunks 為準
    fileChunks.push({
      id: `${fileId}-summary`,
      url: `file://${name}`,
      title: `${name}（全文摘要）`,
      text: summary,
      vector: vectors[pieces.length],
      fileId,
    });
  }

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
    format: parsed.format,
    fidelity: parsed.fidelity,
  };
  const meta = knowledgeStore.getMeta(tenantId);
  knowledgeStore.setMeta(tenantId, {
    ...meta,
    status: 'ready',
    chunkCount: idx.chunks.length,
    generatedAt: idx.generatedAt,
    model: idx.model,
    files: [...(meta.files ?? []), fileMeta],
    chunkCountBySource: countBySource(idx.chunks),
  });
  void refreshSuggestedPrompts(tenantId, idx).catch(() => {});
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
      chunkCountBySource: countBySource(chunks),
    });
    void refreshSuggestedPrompts(tenantId, { ...existing, chunks }).catch(() => {});
  } else {
    knowledgeStore.setMeta(tenantId, { ...meta, files: meta.files.filter((f) => f.fileId !== fileId) });
  }
  return true;
}
