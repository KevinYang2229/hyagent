/* 知識庫 ingest 非同步 job 管理：啟動、追蹤進度、同租戶單一任務限制。 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { runIngest as defaultRun, type IngestParams } from './ingest.service';
import { knowledgeStore } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';
import { invalidatePgvectorModelCache } from './retriever.pgvector';
import { invalidateIndexCache } from './retriever.staticIndex';
import { countChunksBySource, loadIndexText } from './knowledge.index.repo';

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

      // ingest 完成後：清除快取、更新索引 meta（file 與 db 兩種檢索器快取都要清，
      // 避免重爬後 pgvector 檢索器繼續拿舊模型查詢）
      invalidateIndexCache(params.tenantId);
      invalidatePgvectorModelCache(params.tenantId);
      // setMeta 是整包覆蓋、不會 merge；重爬不得清掉既有的 files 與 suggestedPrompts：
      // - files 消失會讓仍留在索引中的檔案 chunks（carry-over）變孤兒、無法透過 API 刪除；
      // - suggestedPrompts 消失會把管理者設定的 manual 一併清掉——且這裡清空後緊接著的
      //   void refreshSuggestedPrompts(...) 會讀到已清空的 meta，兩格都判定「無 manual」
      //   而重新生成，manual 因此永久消失（而非暫時被蓋過）。
      const { files, suggestedPrompts, customSuggestedPrompts } = knowledgeStore.getMeta(params.tenantId);
      // 計數向資料層要：runIngest 回傳的 idx 只含本次爬到的網站 chunks，檔案來源的 chunks
      // 由 replaceWebsiteChunks 原地保留、從不經過這裡，拿 idx.chunks 算會漏掉它們
      const counts = await countChunksBySource(params.tenantId);
      knowledgeStore.setMeta(params.tenantId, {
        status: 'ready',
        chunkCount: counts.website + counts.file,
        generatedAt: idx.generatedAt,
        model: idx.model,
        source: idx.source,
        chunkCountBySource: counts,
        ...(files ? { files } : {}),
        ...(suggestedPrompts ? { suggestedPrompts } : {}),
        ...(customSuggestedPrompts ? { customSuggestedPrompts } : {}),
      });

      // 推薦問句生成：不阻塞、不影響索引狀態。失敗時前端就不顯示推薦 chip。
      // 同樣要全租戶視角——只餵網站 chunks 的話，檔案那一格會因「該來源已無內容」被清空。
      void loadIndexText(params.tenantId)
        .then((full) => (full ? refreshSuggestedPrompts(params.tenantId, full) : undefined))
        .catch(() => {});

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

      // 失敗路徑同樣不得清掉既有的 files 與 suggestedPrompts（理由同上）。
      // 這裡比成功路徑更嚴重：失敗路徑不會觸發 refreshSuggestedPrompts 補救，
      // 若漏帶 suggestedPrompts，manual 與 generated 會一起永久消失、無從恢復。
      const { files: filesOnFail, suggestedPrompts: suggestedPromptsOnFail, customSuggestedPrompts: customOnFail } = knowledgeStore.getMeta(
        params.tenantId,
      );
      knowledgeStore.setMeta(params.tenantId, {
        status: 'failed',
        chunkCount: 0,
        error: job.error,
        chunkCountBySource: { website: 0, file: 0 },
        ...(filesOnFail ? { files: filesOnFail } : {}),
        ...(suggestedPromptsOnFail ? { suggestedPrompts: suggestedPromptsOnFail } : {}),
        // 與 suggestedPrompts 各自判斷：自訂提示詞不依附預設推薦詞存在
        ...(customOnFail ? { customSuggestedPrompts: customOnFail } : {}),
      });

      logger.warn({ err, tenantId: params.tenantId }, 'ingest job failed');
    }
  })();

  return job;
}
