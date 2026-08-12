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

export const reportController = {
  /**
   * 狀態查詢。job 只活在記憶體，重啟後會消失；此時若產出物還在，就以產出物為準回報 done——
   * 否則會出現「下載得到、狀態卻查不到」的矛盾。
   */
  async get(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    // formatsOf 是 async 且 db-aware：重啟後 job 已消失、記憶體也空，仍要能從 db 得知有哪些格式，
    // 否則會出現「狀態查詢 404、下載卻打得到」的矛盾
    const formats = await reportStore.formatsOf(id);
    const job = getReportJob(id);

    if (job && (job.tenantId !== tenantId || job.userId !== userId)) {
      throw AppError.notFound('報告不存在');
    }

    if (!job) {
      if (formats.length === 0) throw AppError.notFound('報告不存在');
      // job 已隨行程重啟消失，改以產出物的擁有者為準做同一套「一律 404」授權判斷——
      // formatsOf 不分租戶／使用者，若不在這裡補查 reportStore.get 核對擁有者，
      // 就會讓「重啟後任何登入者都能查到別人報告的狀態」悄悄繞過下載端點同樣守的門檻
      const owner = await reportStore.get(id, formats[0]);
      if (!owner || owner.tenantId !== tenantId || owner.userId !== userId) {
        throw AppError.notFound('報告不存在');
      }
      res.json({ data: { id, status: 'done', doneSections: 0, formats } });
      return;
    }

    res.json({
      data: {
        id: job.id,
        status: job.status,
        topic: job.topic,
        doneSections: job.doneSections,
        ...(job.totalSections !== undefined ? { totalSections: job.totalSections } : {}),
        formats,
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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(stored.filename)}"`,
    );
    res.send(stored.content);
  },
};
