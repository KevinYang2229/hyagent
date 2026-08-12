/**
 * 報告 job：狀態流轉、全零命中 → empty 且不產檔、大綱失敗 → failed、同租戶併發 409。
 */
import type { LLMProvider } from '@/lib/llm/types';
import type { Outline, ReportSection } from '@/modules/report/report.types';
import { reportStore } from '@/modules/report/report.store';
import {
  getReportJob,
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
    expect((await reportStore.formatsOf(job.id)).sort()).toEqual(['html', 'md']);
    expect((await reportStore.get(job.id, 'md'))?.content.toString()).toContain('## A');
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
