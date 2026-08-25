import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { getReportJob } from './report.job';
import { DEFAULT_REPORT_FORMAT, REPORT_FORMATS, renderers } from './report.render';
import { contentDispositionHeader } from './report.http';
import { reportStore } from './report.store';

function resolveUserId(req: Request): string {
  return req.user?.sub ?? req.header('x-user-id') ?? 'demo-user';
}

function resolveTenantId(req: Request): string {
  return req.tenant?.id ?? 'default';
}

/**
 * 產出物「還沒齊」時，判定它是仍在渲染、還是已經定案的寬限期。
 *
 * 上限取自最慢的那一步：pdf 的 PRINT_TIMEOUT_MS 是 30 秒，加上把數百 KB 的 PDF 寫進 db
 * 的時間（實測 7～18 秒），最壞情況約 50 秒。90 秒留了足夠餘裕，又短到不會讓真的少一種
 * 格式的報告卡在「產生中」太久。
 */
const RENDER_GRACE_MS = 90_000;

export const reportController = {
  /**
   * 狀態查詢。job 只活在記憶體，重啟後會消失；此時若產出物還在，就以產出物為準回報狀態——
   * 否則會出現「下載得到、狀態卻查不到」的矛盾。
   *
   * 但「有產出物」不等於「產完了」：job 是單一行程的記憶體狀態，輪詢請求若打到沒有該 job
   * 的行程（多副本、或期間重啟過），這條路徑看到的可能是渲染到一半的中間狀態。曾經一律
   * 回報 done，於是前端收到終態就永久停止輪詢，把當下那份殘缺清單凍結住——而 pdf 是最後
   * 產、也最慢產的一個（實測比 html 晚 7～18 秒），掉的永遠是它：使用者端少一顆 PDF 按鈕，
   * 後台每次即時查詢卻看得到。見下方 settled 的判定。
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
      /*
       * 定案的條件二擇一：
       * - 格式已達本部署會產的數量（REPORT_FORMATS 由登錄表推導）→ 確定產完了。
       *   用 >= 而非 ===：舊報告可能存於登錄表更多格式的年代（例如曾開放過 docx/xlsx），
       *   那些不該被當成「還在產」。
       * - 已超過寬限期 → 不論齊不齊都定案。少的那個格式是真的失敗了（或那份報告產於
       *   該格式還不存在的年代），再等也不會出現，不能讓它永遠停在產生中。
       * 兩者皆否，就誠實回報還在渲染，讓前端繼續輪詢到 pdf 落地為止。
       */
      const settled =
        files.length >= REPORT_FORMATS.length ||
        Date.now() - new Date(owner.createdAt).getTime() > RENDER_GRACE_MS;
      res.json({
        data: { id, status: settled ? 'done' : 'composing', doneSections: 0, files },
      });
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
