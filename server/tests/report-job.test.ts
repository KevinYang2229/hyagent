/**
 * 報告 job：狀態流轉、全零命中 → empty 且不產檔、大綱失敗 → failed、同租戶併發 409。
 */
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
import type { Outline, ReportSection } from '@/modules/report/report.types';
import { reportStore } from '@/modules/report/report.store';
import { REPORT_FORMATS, renderers } from '@/modules/report/report.render';
import {
  _resetJobsForTest,
  getReportJob,
  purgeFinishedReportJobs,
  startReportJob,
  waitForJobForTest,
} from '@/modules/report/report.job';

const llm = {} as LLMProvider;

const outline: Outline = {
  title: '報告',
  sections: [
    { heading: 'A', query: 'a？' },
    { heading: 'B', query: 'b？' },
  ],
};

function sectionWith(hits: number): (t: string, s: { heading: string; query: string }) => Promise<ReportSection> {
  return async (_t, s) => ({
    heading: s.heading,
    query: s.query,
    body: hits > 0 ? '內文' : '',
    sources: hits > 0 ? [{ title: '來源' }] : [],
    hits,
  });
}

beforeEach(() => reportStore._resetForTest());

describe('收尾的綜合建議節', () => {
  const synthesis: ReportSection = {
    heading: '綜合觀察與建議', query: '主題', body: '兩展的走向相反。', sources: [], hits: 2,
  };

  it('產得出來就接在最後一節之後', async () => {
    const job = startReportJob(
      { tenantId: 't-syn', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(2), synthesize: async () => synthesis },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('done');
    const md = (await reportStore.get(job.id, 'md'))?.content.toString() ?? '';
    expect(md).toContain('## 綜合觀察與建議');
    expect(md.indexOf('## 綜合觀察與建議')).toBeGreaterThan(md.indexOf('## B'));
  });

  /*
   * 進度回報的分母是大綱的節數。綜合節是流程收尾時才決定產不產得出來的，
   * 不能讓它把 doneSections 推過 totalSections——那會讓輪詢端看到 3/2。
   */
  it('不影響進度回報的分母與分子', async () => {
    const job = startReportJob(
      { tenantId: 't-syn2', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(2), synthesize: async () => synthesis },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.totalSections).toBe(2);
    expect(done.doneSections).toBe(2);
  });

  it('產不出來時報告照樣完成，只是少了這一節', async () => {
    const job = startReportJob(
      { tenantId: 't-syn3', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(2), synthesize: async () => undefined },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('done');
    const md = (await reportStore.get(job.id, 'md'))?.content.toString() ?? '';
    expect(md).toContain('## A');
    expect(md).not.toContain('綜合觀察與建議');
  });
});

describe('startReportJob', () => {
  it('完成後狀態為 done，並存下所有登錄格式', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(2) },
    );
    expect(job.status).toBe('queued');

    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('done');
    expect(done.totalSections).toBe(2);
    expect(done.doneSections).toBe(2);
    expect(done.finishedAt).toBeDefined();
    const formats = (await reportStore.formatsOf(job.id)).sort();
    // pdf 要有 Chromium；環境沒有就會被跳過，但 md 與 html 一定要在
    expect(formats).toEqual(expect.arrayContaining(['html', 'md']));
    expect([...REPORT_FORMATS].sort()).toEqual(expect.arrayContaining(formats));
    expect((await reportStore.get(job.id, 'md'))?.content.toString()).toContain('## A');
  });

  /*
   * 單一格式渲染失敗不得讓整份報告作廢。PDF 要有 Chromium 才印得出來，那是部署環境的
   * 條件而不是報告本身的問題——缺了它，md 與 html 仍然是完整可用的產出。
   */
  it('一種格式渲染失敗時，其餘照存、狀態仍是 done', async () => {
    const spy = jest.spyOn(renderers.html, 'render').mockRejectedValue(new Error('沒有瀏覽器'));
    try {
      const job = startReportJob(
        { tenantId: 't1', userId: 'u1', topic: '主題', llm },
        { outline: async () => outline, compose: sectionWith(2) },
      );
      const done = await waitForJobForTest(job.id);
      expect(done.status).toBe('done');
      const formats = await reportStore.formatsOf(job.id);
      expect(formats).not.toContain('html');
      expect(formats).toContain('md');
    } finally {
      spy.mockRestore();
    }
  });

  it('所有格式都失敗才算 failed——不能標成 done 讓使用者下載到空氣', async () => {
    const spies = Object.values(renderers).map((r) =>
      jest.spyOn(r, 'render').mockRejectedValue(new Error('沒有瀏覽器')),
    );
    try {
      const job = startReportJob(
        { tenantId: 't1', userId: 'u1', topic: '主題', llm },
        { outline: async () => outline, compose: sectionWith(2) },
      );
      const done = await waitForJobForTest(job.id);
      expect(done.status).toBe('failed');
      expect(await reportStore.formatsOf(job.id)).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('全部節零命中 → empty，且不產檔', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(0) },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('empty');
    expect(await reportStore.formatsOf(job.id)).toEqual([]);
  });

  it('只要有一節命中就照常產檔（缺口以查無資料呈現）', async () => {
    let call = 0;
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => outline,
        compose: async (_t, s) => {
          call += 1;
          return {
            heading: s.heading,
            query: s.query,
            body: call === 1 ? '內文' : '',
            sources: [],
            hits: call === 1 ? 1 : 0,
          };
        },
      },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('done');
    const md = (await reportStore.get(job.id, 'md'))?.content.toString() ?? '';
    expect(md).toContain('## A');
    expect(md).toContain('知識庫查無相關資料。');
  });

  it('大綱失敗 → failed 並記錄原因', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => {
          throw new Error('報告大綱解析失敗：模型未輸出 JSON');
        },
        compose: sectionWith(2),
      },
    );
    const done = await waitForJobForTest(job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('大綱');
    expect(await reportStore.formatsOf(job.id)).toEqual([]);
  });

  it('同租戶已有進行中任務 → 409', async () => {
    const job1 = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return outline;
        },
        compose: sectionWith(1),
      },
    );
    expect(() =>
      startReportJob(
        { tenantId: 't1', userId: 'u2', topic: '另一個主題', llm },
        { outline: async () => outline, compose: sectionWith(1) },
      ),
    ).toThrow(/進行中/);
    // 等待這個未在斷言中處理的背景任務跑完，避免它繼續佔用 t1 的「進行中」名額、
    // 污染後面測試對同一租戶的 startReportJob 呼叫
    await waitForJobForTest(job1.id);
  });

  it('不同租戶可同時進行', async () => {
    const job1 = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return outline;
        },
        compose: sectionWith(1),
      },
    );
    expect(() =>
      startReportJob(
        { tenantId: 't2', userId: 'u2', topic: '主題', llm },
        { outline: async () => outline, compose: sectionWith(1) },
      ),
    ).not.toThrow();
    // 同上：等 t1 這個背景任務跑完，避免佔用名額污染下一個測試
    await waitForJobForTest(job1.id);
  });

  it('getReportJob 取得目前狀態快照', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(1) },
    );
    expect(getReportJob(job.id)?.topic).toBe('主題');
    await waitForJobForTest(job.id);
  });
});

describe('purgeFinishedReportJobs', () => {
  // 前面 describe('startReportJob', ...) 的測試會在共用的 jobs Map 留下已結束的 job（模組級狀態，
  // 不隨 test case 結束自動清空）；每個測試開始前先清空，才能確保 purged 筆數只反映本測試建立的 job
  beforeEach(() => _resetJobsForTest());
  afterEach(() => _resetJobsForTest());

  it('已結束且超過 TTL 的 job 會被清除', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(1) },
    );
    await waitForJobForTest(job.id);
    expect(getReportJob(job.id)?.status).toBe('done');

    // finishedAt 為剛剛，用 25 小時後的「now」模擬已過 24 小時 TTL
    // 不寫死小時數：TTL 預設調整時測試不必跟著改
    const later = new Date(Date.now() + (env.REPORT_TTL_HOURS + 1) * 3600_000);
    const purged = purgeFinishedReportJobs(later);
    expect(purged).toBe(1);
    expect(getReportJob(job.id)).toBeUndefined();
  });

  it('已結束但未過 TTL 的 job 不會被清除', async () => {
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(1) },
    );
    await waitForJobForTest(job.id);
    expect(purgeFinishedReportJobs(new Date())).toBe(0);
    expect(getReportJob(job.id)).toBeDefined();
  });

  it('empty/failed 終態同樣會被 TTL 回收', async () => {
    const emptyJob = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      { outline: async () => outline, compose: sectionWith(0) },
    );
    await waitForJobForTest(emptyJob.id);
    const failedJob = startReportJob(
      { tenantId: 't2', userId: 'u2', topic: '主題', llm },
      {
        outline: async () => {
          throw new Error('報告大綱解析失敗');
        },
        compose: sectionWith(1),
      },
    );
    await waitForJobForTest(failedJob.id);

    // 不寫死小時數：TTL 預設調整時測試不必跟著改
    const later = new Date(Date.now() + (env.REPORT_TTL_HOURS + 1) * 3600_000);
    expect(purgeFinishedReportJobs(later)).toBe(2);
    expect(getReportJob(emptyJob.id)).toBeUndefined();
    expect(getReportJob(failedJob.id)).toBeUndefined();
  });

  it('進行中（composing）的 job 即使「finishedAt 之外的計算超過 TTL」也不會被誤刪——沒有 finishedAt 就一律保留', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const job = startReportJob(
      { tenantId: 't1', userId: 'u1', topic: '主題', llm },
      {
        outline: async () => outline,
        compose: async (_t, s) => {
          await gate;
          return { heading: s.heading, query: s.query, body: '內文', sources: [], hits: 1 };
        },
      },
    );
    expect(getReportJob(job.id)?.status).toBe('queued');

    // 不寫死小時數：TTL 預設調整時測試不必跟著改
    const later = new Date(Date.now() + (env.REPORT_TTL_HOURS + 1) * 3600_000);
    expect(purgeFinishedReportJobs(later)).toBe(0);
    expect(getReportJob(job.id)).toBeDefined();

    release();
    await waitForJobForTest(job.id);
  });
});
