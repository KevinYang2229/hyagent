/**
 * 知識庫 admin controller：每租戶知識來源設定、觸發解析、查進度、測試查詢、清除索引。
 * 全部端點受 requireAdmin 保護（掛載於 admin.routes）。
 */
import { existsSync, rmSync } from 'node:fs';
import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { indexPathFor } from './index-path';
import type { IngestParams } from './ingest.service';
import { ingestFile, removeFile } from './knowledge-file.service';
import { getJob, getRunningJobForTenant, startIngestJob } from './knowledge.job';
import { knowledgeStore, type KnowledgeSource } from './knowledge.store';
import { invalidateIndexCache, staticIndexRetriever } from './retriever.staticIndex';

/** 由已存來源設定組出 ingest 參數；未設定起始網址則擋下 */
function ingestParamsFor(tenantId: string): IngestParams {
  const s = knowledgeStore.getSource(tenantId);
  if (!s.startUrl) throw AppError.unprocessable('尚未設定知識來源網址');
  return {
    tenantId,
    startUrl: s.startUrl,
    maxPages: s.maxPages,
    pathPrefix: s.pathPrefix,
    includePatterns: s.includePatterns,
    excludePatterns: s.excludePatterns,
    chunkChars: s.chunkChars,
    embeddingModel: s.embeddingModel,
  };
}

export const knowledgeAdminController = {
  async get(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    res.json({
      data: {
        source: knowledgeStore.getSource(tenantId),
        meta: knowledgeStore.getMeta(tenantId),
        runningJob: getRunningJobForTenant(tenantId) ?? null,
      },
    });
  },

  async saveSource(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const saved = knowledgeStore.saveSource(tenantId, req.body as Omit<KnowledgeSource, 'updatedAt'>);
    res.json({ data: saved });
  },

  async ingest(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const body = req.body as Partial<KnowledgeSource>;
    // 有帶覆寫參數時先存起來，再依最終設定啟動 job
    if (body.startUrl) {
      knowledgeStore.saveSource(tenantId, {
        ...knowledgeStore.getSource(tenantId),
        ...body,
      } as Omit<KnowledgeSource, 'updatedAt'>);
    }
    const job = startIngestJob(ingestParamsFor(tenantId));
    res.status(202).json({ data: { jobId: job.id, status: job.status } });
  },

  async job(req: Request, res: Response): Promise<void> {
    const job = getJob(String(req.params.jobId));
    if (!job || job.tenantId !== String(req.params.id)) throw AppError.notFound('job not found');
    res.json({ data: job });
  },

  async queryTest(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { question } = req.body as { question: string };
    const hits = await staticIndexRetriever.search(tenantId, question);
    res.json({
      data: {
        hits: hits.map((h) => ({
          title: h.title,
          url: h.url,
          score: h.score,
          snippet: h.content.slice(0, 160),
        })),
      },
    });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const path = indexPathFor(tenantId);
    if (existsSync(path)) rmSync(path);
    invalidateIndexCache(tenantId);
    knowledgeStore.setMeta(tenantId, { status: 'none', chunkCount: 0 });
    res.json({ data: { ok: true } });
  },

  /** 上傳單一檔案（multipart field: file）：解析→切塊→embed→附加索引 */
  async uploadFile(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    // 索引檔無鎖：爬網 job 進行中同時附加會有 read-modify-write 競態（可能默默蓋掉彼此的 chunks），
    // 比照「重複爬網」守門以 409 擋下，待 job 結束再上傳。
    if (getRunningJobForTenant(tenantId)) {
      throw AppError.conflict('解析任務進行中，請待完成後再上傳檔案');
    }
    if (!req.file) throw AppError.badRequest('缺少上傳檔案（欄位 file）');
    // multer/busboy 依 RFC 把 Content-Disposition 的檔名當 latin1 解，UTF-8 檔名（如中文）需轉回來
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const fileMeta = await ingestFile(tenantId, originalName, req.file.buffer);
    res.status(201).json({ data: fileMeta });
  },

  /** 刪除已上傳檔案：索引與 meta 一併移除；查無回 404 */
  async deleteFile(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    // 同上：爬網進行中不允許動索引（競態守門）
    if (getRunningJobForTenant(tenantId)) {
      throw AppError.conflict('解析任務進行中，請待完成後再刪除檔案');
    }
    const fileId = String(req.params.fileId);
    const removed = removeFile(tenantId, fileId);
    if (!removed) throw AppError.notFound('檔案不存在');
    res.json({ data: { fileId } });
  },
};
