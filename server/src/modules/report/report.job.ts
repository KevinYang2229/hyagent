/**
 * 報告非同步 job：啟動、追蹤進度、同租戶單一任務限制（比照 knowledge.job）。
 *
 * 對話輪次不能等一份報告跑完（1 次大綱 + N 次檢索 + N 次彙整），因此 handleTurn 只負責
 * 啟動並立刻回覆，實際工作在程序內非同步進行、由前端輪詢。
 */
import { randomUUID } from 'node:crypto';
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { normalizeLocale } from '@/lib/locale';
import { buildOutline } from './report.outline';
import { composeSection } from './report.compose';
import { composeSynthesis } from './report.synthesis';
import { buildDataReport } from './report.data';
import { renderers } from './report.render';
import { reportStore } from './report.store';
import type { ReportDoc, ReportJob, ReportSection } from './report.types';

const jobs = new Map<string, ReportJob>();
/** 供測試等待背景工作結束；正式流程一律走輪詢 */
const running = new Map<string, Promise<void>>();

export interface ReportJobDeps {
  outline?: typeof buildOutline;
  compose?: typeof composeSection;
  synthesize?: typeof composeSynthesis;
  dataReport?: typeof buildDataReport;
}

/** 報告的資料來源：knowledge＝知識庫檢索；database＝依主題自動查資料庫（Database Intelligence） */
export type ReportSource = 'knowledge' | 'database';

export interface StartReportParams {
  tenantId: string;
  userId: string;
  topic: string;
  locale?: string;
  llm: LLMProvider;
  source?: ReportSource;
}

export function listReportJobsByUser(tenantId: string, userId: string): ReportJob[] {
  const cutoff = Date.now() - env.REPORT_TTL_HOURS * 3_600_000;
  return [...jobs.values()].filter((job) => {
    if (job.tenantId !== tenantId || job.userId !== userId) return false;
    const terminal = ['done', 'empty', 'failed'].includes(job.status);
    return !terminal || Date.parse(job.finishedAt ?? job.startedAt) > cutoff;
  });
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
  const synthesize = deps.synthesize ?? composeSynthesis;
  const dataReport = deps.dataReport ?? buildDataReport;

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
      let title: string;
      const sections: ReportSection[] = [];
      if (params.source === 'database') {
        // 查詢規劃與執行是同一個 tool-loop，沒有可預知的節數：查完才知道
        const data = await dataReport({
          tenantId: params.tenantId, userId: params.userId, topic: params.topic, locale: params.locale, llm: params.llm,
        });
        title = data.title;
        sections.push(...data.sections);
        job.totalSections = sections.length;
        job.doneSections = sections.length;
        job.status = 'composing';
      } else {
        const plan = await outline(
          params.tenantId, params.userId, params.topic, params.locale, params.llm,
        );
        title = plan.title;
        job.totalSections = plan.sections.length;
        job.status = 'composing';

        // 逐節序列執行：併發會讓同租戶的 embedding / rerank 呼叫尖峰疊在一起，
        // 而報告本來就是非同步任務，沒有必要用尖峰換那幾秒
        // 跨節共用：自動補圖只看「最相關的表 + 欄位型別」，不記錄的話同一張表會被多節重複選中
        const usedTables = new Set<string>();
        for (const section of plan.sections) {
          sections.push(
            await compose(params.tenantId, params.userId, section, params.locale, params.llm, {
              usedTables,
            }),
          );
          job.doneSections += 1;
      }

      /*
       * 收尾的綜合節：各節之間刻意不共享脈絡、也禁止寫結論，於是整份報告沒有任何一處
       * 把跨檔案的數字讀成一件事。這一節補上，而且只吃各節已產生的精確圖表資料點——
       * 那些數值是程式從原始儲存格讀出的，不是前面各節的轉述。
       * 條件不足或失敗都只是少一節，前面的內容照常交付。
       */
      const synthesis = await synthesize(
        params.tenantId, params.topic, sections, params.locale, params.llm,
      );
      if (synthesis) sections.push(synthesis);
      }

      // 全部節都零命中：流程成功但沒有內容可交付，不產檔
      if (sections.length === 0 || sections.every((s) => s.hits === 0)) {
        job.status = 'empty';
        job.finishedAt = new Date().toISOString();
        logger.info({ jobId: job.id, tenantId: params.tenantId }, 'report job empty');
        return;
      }

      const doc: ReportDoc = {
        title,
        topic: params.topic,
        locale: normalizeLocale(params.locale),
        generatedAt: new Date().toISOString(),
        sections,
      };

      const slug = slugify(title);
      /*
       * 單一格式失敗不得讓整份報告作廢。PDF 要有 Chromium 才印得出來，而那是部署環境的
       * 條件、不是報告本身的問題——缺了它，md 與 html 仍然是完整可用的產出。
       * 但一種都沒成功就是真的失敗了，不能標成 done 讓使用者下載到空氣。
       */
      let saved = 0;
      for (const renderer of Object.values(renderers)) {
        try {
          const content = await renderer.render(doc);
          reportStore.save({
            reportId: job.id,
            tenantId: params.tenantId,
            userId: params.userId,
            format: renderer.format,
            filename: `${slug}.${renderer.format}`,
            content,
          });
          saved += 1;
        } catch (err) {
          logger.warn(
            { err, jobId: job.id, tenantId: params.tenantId, format: renderer.format },
            'report render failed for one format',
          );
        }
      }
      if (saved === 0) throw new Error('所有輸出格式都渲染失敗');

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

/**
 * 清除已結束（done/empty/failed）且結束時間超過 TTL 的 job，避免 jobs Map 隨行程存活時間無限增長。
 * 進行中（queued/outlining/composing）的 job 一律保留，不受 TTL 影響。
 * 由 index.ts 的每日 sweeper 呼叫；沿用 reportStore 產出物同一把 TTL（REPORT_TTL_HOURS），
 * 讓「查得到 job 狀態」與「查得到產出物」的生命週期一致。
 */
export function purgeFinishedReportJobs(now: Date = new Date()): number {
  const cutoff = now.getTime() - env.REPORT_TTL_HOURS * 3600_000;
  let purged = 0;
  for (const [id, job] of jobs) {
    const isTerminal = job.status === 'done' || job.status === 'empty' || job.status === 'failed';
    if (isTerminal && job.finishedAt && new Date(job.finishedAt).getTime() <= cutoff) {
      jobs.delete(id);
      purged += 1;
    }
  }
  return purged;
}

/** 測試專用：清空 jobs Map，避免跨測試檔殘留背景 job 互相污染 */
export function _resetJobsForTest(): void {
  jobs.clear();
  running.clear();
}
