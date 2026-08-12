/**
 * 報告非同步 job：啟動、追蹤進度、同租戶單一任務限制（比照 knowledge.job）。
 *
 * 對話輪次不能等一份報告跑完（1 次大綱 + N 次檢索 + N 次彙整），因此 handleTurn 只負責
 * 啟動並立刻回覆，實際工作在程序內非同步進行、由前端輪詢。
 */
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { normalizeLocale } from '@/lib/locale';
import { buildOutline } from './report.outline';
import { composeSection } from './report.compose';
import { renderers } from './report.render';
import { reportStore } from './report.store';
import type { ReportDoc, ReportJob, ReportSection } from './report.types';

const jobs = new Map<string, ReportJob>();
/** 供測試等待背景工作結束；正式流程一律走輪詢 */
const running = new Map<string, Promise<void>>();

export interface ReportJobDeps {
  outline?: typeof buildOutline;
  compose?: typeof composeSection;
}

export interface StartReportParams {
  tenantId: string;
  userId: string;
  topic: string;
  locale?: string;
  llm: LLMProvider;
}

export function getReportJob(id: string): ReportJob | undefined {
  return jobs.get(id);
}

export function getRunningReportJobForTenant(tenantId: string): ReportJob | undefined {
  return [...jobs.values()].find(
    (j) =>
      j.tenantId === tenantId &&
      (j.status === 'queued' || j.status === 'outlining' || j.status === 'composing'),
  );
}

/** 檔名用的安全片段：只留中英數字，其餘轉底線，避免 Content-Disposition 被標題內容破壞 */
function slugify(title: string): string {
  const cleaned = title.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 40) || 'report';
}

export function startReportJob(params: StartReportParams, deps: ReportJobDeps = {}): ReportJob {
  if (getRunningReportJobForTenant(params.tenantId)) {
    throw AppError.conflict('該租戶已有報告產生任務進行中');
  }

  const outline = deps.outline ?? buildOutline;
  const compose = deps.compose ?? composeSection;

  const job: ReportJob = {
    id: randomUUID(),
    tenantId: params.tenantId,
    userId: params.userId,
    topic: params.topic,
    status: 'queued',
    doneSections: 0,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  const work = (async () => {
    // async 函式在第一個 await 之前是同步執行的：若沒有這個 yield，下面的
    // job.status = 'outlining' 會在 startReportJob 都還沒 return 給呼叫端前就先生效，
    // 讓 'queued' 這個狀態永遠沒有機會被外部（測試、輪詢者）觀察到。
    await Promise.resolve();
    try {
      job.status = 'outlining';
      const plan = await outline(params.tenantId, params.topic, params.locale, params.llm);
      job.totalSections = plan.sections.length;
      job.status = 'composing';

      // 逐節序列執行：併發會讓同租戶的 embedding / rerank 呼叫尖峰疊在一起，
      // 而報告本來就是非同步任務，沒有必要用尖峰換那幾秒
      const sections: ReportSection[] = [];
      for (const section of plan.sections) {
        sections.push(await compose(params.tenantId, section, params.locale, params.llm));
        job.doneSections += 1;
      }

      // 全部節都零命中：流程成功但沒有內容可交付，不產檔
      if (sections.every((s) => s.hits === 0)) {
        job.status = 'empty';
        job.finishedAt = new Date().toISOString();
        logger.info({ jobId: job.id, tenantId: params.tenantId }, 'report job empty');
        return;
      }

      const doc: ReportDoc = {
        title: plan.title,
        topic: params.topic,
        locale: normalizeLocale(params.locale),
        generatedAt: new Date().toISOString(),
        sections,
      };

      const slug = slugify(plan.title);
      for (const renderer of Object.values(renderers)) {
        reportStore.save({
          reportId: job.id,
          tenantId: params.tenantId,
          userId: params.userId,
          format: renderer.format,
          filename: `${slug}.${renderer.format}`,
          content: await renderer.render(doc),
        });
      }

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      logger.info(
        { jobId: job.id, tenantId: params.tenantId, sections: sections.length },
        'report job done',
      );
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();
      logger.warn({ err, tenantId: params.tenantId }, 'report job failed');
    } finally {
      running.delete(job.id);
    }
  })();

  running.set(job.id, work);
  return job;
}

/** 測試專用：等背景工作結束後回傳最終狀態 */
export async function waitForJobForTest(id: string): Promise<ReportJob> {
  await running.get(id);
  const job = jobs.get(id);
  if (!job) throw new Error(`unknown report job: ${id}`);
  return job;
}
