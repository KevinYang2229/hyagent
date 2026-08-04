/* 知識庫 ingest 非同步 job 管理：啟動、追蹤進度、同租戶單一任務限制。 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { runIngest as defaultRun, type IngestParams } from './ingest.service';
import { knowledgeStore } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';
import { invalidateIndexCache } from './retriever.staticIndex';
import { splitChunksBySource } from './prompt-slots';

/** 單一 ingest job 的狀態快照 */
export interface IngestJob {
  /** 唯一識別碼 */
  id: string;
  /** 所屬租戶 */
  tenantId: string;
  /** 目前狀態 */
  status: 'queued' | 'crawling' | 'embedding' | 'done' | 'failed';
  /** 已爬取頁數 */
  pagesCrawled: number;
  /** 總 chunk 數 */
  chunks: number;
  /** 已嵌入 chunk 數 */
  embedded: number;
  /** 任務開始時間（ISO 8601） */
  startedAt: string;
  /** 任務結束時間（ISO 8601，僅 done/failed 時有值） */
  finishedAt?: string;
  /** 失敗原因（status=failed 時） */
  error?: string;
}

/** 以 jobId 為 key 的記憶體 job 狀態 Map */
const jobs = new Map<string, IngestJob>();

/** 依 jobId 取得 job；不存在則回 undefined */
export function getJob(jobId: string): IngestJob | undefined {
  return jobs.get(jobId);
}

/** 取得指定租戶目前進行中的 job（queued/crawling/embedding）；不存在則回 undefined */
export function getRunningJobForTenant(tenantId: string): IngestJob | undefined {
  return [...jobs.values()].find(
    (j) =>
      j.tenantId === tenantId &&
      (j.status === 'queued' || j.status === 'crawling' || j.status === 'embedding'),
  );
}

/**
 * 啟動一個新的 ingest job，非同步在程序內執行。
 * 同一租戶只允許一個進行中任務；若已存在則拋出 409 Conflict。
 *
 * @param params  ingest 所需參數
 * @param run     可注入的 runIngest 實作（測試用途）；預設為 defaultRun
 * @returns       已建立的 IngestJob（status 為 'queued'）
 */
export function startIngestJob(
  params: IngestParams,
  run: typeof defaultRun = defaultRun,
): IngestJob {
  // 同租戶已有進行中任務時拒絕新建
  if (getRunningJobForTenant(params.tenantId)) {
    throw AppError.conflict('該租戶已有解析任務進行中');
  }

  const job: IngestJob = {
    id: randomUUID(),
    tenantId: params.tenantId,
    status: 'queued',
    pagesCrawled: 0,
    chunks: 0,
    embedded: 0,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  // 非同步執行，不等待
  void (async () => {
    try {
      const idx = await run(params, (p) => {
        // 進度回呼：將 phase 對應到 status（done 階段由外層覆寫，這裡先設 embedding）
        job.status = p.phase === 'done' ? 'embedding' : (p.phase as IngestJob['status']);
        job.pagesCrawled = p.pagesCrawled;
        job.chunks = p.chunks;
        job.embedded = p.embedded;
      });

      // ingest 完成後：清除快取、更新索引 meta
      invalidateIndexCache(params.tenantId);
      // setMeta 是整包覆蓋、不會 merge；重爬不得清掉既有的檔案來源清單，
      // 否則檔案 chunks 雖仍留在索引中（carry-over），卻因 meta.files 消失而變孤兒、無法透過 API 刪除
      const { files } = knowledgeStore.getMeta(params.tenantId);
      const bySource = splitChunksBySource(idx.chunks);
      knowledgeStore.setMeta(params.tenantId, {
        status: 'ready',
        chunkCount: idx.chunks.length,
        generatedAt: idx.generatedAt,
        model: idx.model,
        source: idx.source,
        chunkCountBySource: { website: bySource.website.length, file: bySource.file.length },
        ...(files ? { files } : {}),
      });

      // 推薦問句生成：不阻塞、不影響索引狀態。失敗時前端就不顯示推薦 chip
      void refreshSuggestedPrompts(params.tenantId, idx).catch(() => {});

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      logger.info(
        { jobId: job.id, tenantId: params.tenantId, chunks: idx.chunks.length },
        'ingest job done',
      );
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();

      // 失敗路徑同樣不得清掉既有的檔案來源清單（理由同上）
      const { files: filesOnFail } = knowledgeStore.getMeta(params.tenantId);
      knowledgeStore.setMeta(params.tenantId, {
        status: 'failed',
        chunkCount: 0,
        error: job.error,
        ...(filesOnFail ? { files: filesOnFail } : {}),
      });

      logger.warn({ err, tenantId: params.tenantId }, 'ingest job failed');
    }
  })();

  return job;
}
