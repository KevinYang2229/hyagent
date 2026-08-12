import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { getReportJob } from './report.job';
import { DEFAULT_REPORT_FORMAT, renderers } from './report.render';
import { reportStore } from './report.store';

function resolveUserId(req: Request): string {
  return req.user?.sub ?? req.header('x-user-id') ?? 'demo-user';
}

function resolveTenantId(req: Request): string {
  return req.tenant?.id ?? 'default';
}

/**
 * Content-Disposition 檔名：classic 的 `filename="..."` 只定義給 ASCII，本產品預設語系是繁中，
 * 報告標題（因此檔名）預設就是中文——把 percent-encoded 字串塞進 `filename="..."` 是非標準用法，
 * 各瀏覽器解讀不一致，使用者很可能下載到檔名字面是 `%E5%A0%B1...` 的檔案，這不是邊角案例。
 * 同時提供 RFC 5987 的 `filename*`（標準做法）與一個安全的 ASCII fallback 給不支援 filename* 的舊瀏覽器。
 * filename 只可能來自 report.job.ts 的 slugify（僅 \p{L}\p{N}_. 組成），不含引號／反斜線，無 header 注入風險。
 */
function contentDispositionHeader(filename: string): string {
  const isAscii = /^[\x20-\x7E]*$/.test(filename);
  const asciiFallback = isAscii ? filename : `report.${filename.split('.').pop() ?? 'txt'}`;
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const reportController = {
  /**
   * 狀態查詢。job 只活在記憶體，重啟後會消失；此時若產出物還在，就以產出物為準回報 done——
   * 否則會出現「下載得到、狀態卻查不到」的矛盾。
   */
  async get(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    // filesOf 是 async 且 db-aware：重啟後 job 已消失、記憶體也空，仍要能從 db 得知有哪些格式，
    // 否則會出現「狀態查詢 404、下載卻打得到」的矛盾。回傳格式連同檔名——與下載端點同一份
    // filename（reportStore 內部儲存值），前端才能把 <a download> 設成正確的中文檔名，
    // 而不是退化成只有 UUID 的 `${id}.${format}`。
    const files = await reportStore.filesOf(id);
    const job = getReportJob(id);

    if (job && (job.tenantId !== tenantId || job.userId !== userId)) {
      throw AppError.notFound('報告不存在');
    }

    if (!job) {
      if (files.length === 0) throw AppError.notFound('報告不存在');
      // job 已隨行程重啟消失，改以產出物的擁有者為準做同一套「一律 404」授權判斷——
      // filesOf 不分租戶／使用者，若不在這裡補查 reportStore.get 核對擁有者，
      // 就會讓「重啟後任何登入者都能查到別人報告的狀態」悄悄繞過下載端點同樣守的門檻
      const owner = await reportStore.get(id, files[0].format);
      if (!owner || owner.tenantId !== tenantId || owner.userId !== userId) {
        throw AppError.notFound('報告不存在');
      }
      res.json({ data: { id, status: 'done', doneSections: 0, files } });
      return;
    }

    res.json({
      data: {
        id: job.id,
        status: job.status,
        topic: job.topic,
        doneSections: job.doneSections,
        ...(job.totalSections !== undefined ? { totalSections: job.totalSections } : {}),
        files,
        ...(job.error ? { error: job.error } : {}),
      },
    });
  },

  async download(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const format = (req.query.format as string | undefined) ?? DEFAULT_REPORT_FORMAT;
    const stored = await reportStore.get(id, format);

    // 一律 404：403 等於向非建立者確認「這份報告存在」
    if (!stored) throw AppError.notFound('報告不存在');
    if (stored.tenantId !== resolveTenantId(req) || stored.userId !== resolveUserId(req)) {
      throw AppError.notFound('報告不存在');
    }

    res.setHeader('Content-Type', renderers[format].contentType);
    res.setHeader('Content-Disposition', contentDispositionHeader(stored.filename));
    res.send(stored.content);
  },
};
