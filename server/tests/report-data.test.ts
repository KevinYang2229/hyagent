/**
 * 數據報告：依主題查資料庫 → 每個查詢一節（表格＋圖表由程式產生）→ 交給既有 renderer。
 */
import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { parseTopic } from '@/modules/report/report.agent-service';
import {
  autoChart,
  buildDataReport,
  parseReportPlan,
  resultTable,
  type DataQueryResult,
} from '@/modules/report/report.data';
import { _resetJobsForTest, startReportJob, waitForJobForTest } from '@/modules/report/report.job';
import { reportStore } from '@/modules/report/report.store';
import { toolRegistry, type ToolDef } from '@/modules/tools';

const result = (p: Partial<DataQueryResult> = {}): DataQueryResult => ({
  no: 1,
  columns: ['dept', 'headcount'],
  labels: ['部門', '在職人數'],
  rows: [
    { dept: '視覺設計部', headcount: '8' },
    { dept: '人資行政部', headcount: 7 },
  ],
  rowCount: 2,
  truncated: false,
  hasMore: false,
  warnings: [],
  dataSourceId: 'ds_oa_org',
  datasets: ['employee', 'department'],
  ...p,
});

beforeEach(() => {
  reportStore._resetForTest();
  _resetJobsForTest();
  jest.restoreAllMocks();
});

describe('parseTopic', () => {
  it('依前綴判斷資料來源；沒有前綴視為知識庫', () => {
    expect(parseTopic('DB: 各部門在職人數')).toEqual({ topic: '各部門在職人數', source: 'database' });
    expect(parseTopic('kb:請假規定')).toEqual({ topic: '請假規定', source: 'knowledge' });
    expect(parseTopic('請假規定')).toEqual({ topic: '請假規定', source: 'knowledge' });
    expect(parseTopic('DB: NONE')).toBeUndefined();
    expect(parseTopic('  ')).toBeUndefined();
  });
});

describe('parseReportPlan', () => {
  it('容忍圍欄與前後文字，略過沒有 query_no 的節', () => {
    const plan = parseReportPlan('好的\n```json\n{"title":"人力","sections":[{"query_no":2,"heading":"分布","analysis":"重點"},{"heading":"x"}],"summary":"結論"}\n```');
    expect(plan).toEqual({ title: '人力', summary: '結論', sections: [{ no: 2, heading: '分布', analysis: '重點' }] });
    expect(parseReportPlan('沒有 JSON')).toBeUndefined();
  });
});

describe('autoChart', () => {
  it('一個名稱欄＋一個數值欄畫長條；PostgreSQL 字串數字也算數值', () => {
    const chart = autoChart(result(), '各部門人數');
    expect(chart).toMatchObject({ kind: 'bar', unit: '在職人數', complete: true, totalRows: 2 });
    expect(chart?.points).toEqual([{ label: '視覺設計部', value: 8 }, { label: '人資行政部', value: 7 }]);
  });

  it('多個數值欄畫分組長條；名稱欄不是恰好一個、只有一列或結果還有下一頁時的處理', () => {
    const grouped = autoChart(result({ columns: ['dept', 'a', 'b'], labels: ['部門', '正職', '兼職'], rows: [{ dept: 'X', a: 1, b: 2 }, { dept: 'Y', a: 3, b: 4 }] }), 't');
    expect(grouped).toMatchObject({ kind: 'grouped', series: ['正職', '兼職'] });
    expect(grouped?.points[1]).toEqual({ label: 'Y', value: 3, values: [3, 4] });
    expect(autoChart(result({ columns: ['dept', 'company', 'n'], rows: [{ dept: 'a', company: 'b', n: 1 }, { dept: 'c', company: 'd', n: 2 }] }), 't')).toBeUndefined();
    expect(autoChart(result({ rows: [{ dept: 'a', headcount: 1 }] }), 't')).toBeUndefined();
    expect(autoChart(result({ hasMore: true }), 't')?.complete).toBe(false);
  });
});

describe('resultTable', () => {
  it('中文表頭、跳脫直線符號、註明資料來源與筆數', () => {
    const md = resultTable(result({ rows: [{ dept: 'A|B', headcount: null }, { dept: 'C', headcount: 3 }] }));
    expect(md).toContain('| 部門 | 在職人數 |');
    expect(md).toContain('| A\\|B | – |');
    expect(md).toContain('資料來源：ds_oa_org（employee、department）；共 2 筆');
    expect(resultTable(result({ hasMore: true, rowCount: 65 }))).toContain('僅列出前 2 筆');
  });
});

describe('buildDataReport', () => {
  const tool = (name: string): ToolDef =>
    ({ id: `mcp.dbi.${name}`, description: name, inputSchema: { type: 'object' }, effect: 'read', scopes: [], agentExposed: true }) as unknown as ToolDef;

  function fakeLlm(final: string): LLMProvider & { calls: LLMCreateParams[] } {
    const calls: LLMCreateParams[] = [];
    const reply = (p: Partial<LLMResult>): LLMResult => ({ text: '', toolCalls: [], stopReason: 'end_turn', model: 'm', keySource: 'platform', ...p }) as LLMResult;
    return {
      name: 'fake',
      calls,
      async createMessage(params) {
        calls.push(params);
        if (calls.length === 1) {
          return reply({ toolCalls: [{ id: 'c1', name: 'mcp_dbi_execute_safe_query', input: { query_plan: {} } }], stopReason: 'tool_use' });
        }
        return reply({ text: final });
      },
    };
  }

  function stubTools(invoke: () => Promise<unknown>) {
    jest.spyOn(toolRegistry, 'prepare').mockResolvedValue();
    jest.spyOn(toolRegistry, 'availableFor').mockReturnValue(
      ['search_schema', 'execute_safe_query', 'other_write'].map((n) => ({ name: `mcp.dbi.${n}`, description: n, inputSchema: { type: 'object' } })),
    );
    jest.spyOn(toolRegistry, 'resolve').mockImplementation((id) => tool(id.split('.')[2]));
    return jest.spyOn(toolRegistry, 'invoke').mockImplementation(invoke);
  }

  const queryData = {
    columns: ['dept', 'headcount'],
    column_labels: ['部門', '在職人數'],
    rows: [{ dept: '視覺設計部', headcount: 8 }, { dept: '總經理室', headcount: 6 }],
    row_count: 2,
    truncated: false,
    warnings: [],
    basis: { data_source_id: 'ds_oa_org', datasets: ['employee'] },
  };

  it('只交出資料庫查詢工具；每個成功查詢一節，數字取自查詢結果', async () => {
    const invoke = stubTools(async () => queryData);
    const llm = fakeLlm('{"title":"人力配置","sections":[{"query_no":1,"heading":"各部門人數","analysis":"視覺設計部最多。"}],"summary":"人力集中在設計。"}');
    const report = await buildDataReport({ tenantId: 't1', userId: 'u1', topic: '人力配置', llm });

    expect(llm.calls[0].tools?.map((t) => t.name)).toEqual(['mcp_dbi_search_schema', 'mcp_dbi_execute_safe_query']);
    expect(invoke).toHaveBeenCalledWith('mcp.dbi.execute_safe_query', { query_plan: {} }, expect.objectContaining({ tenantId: 't1', userId: 'u1' }));
    expect(report.title).toBe('人力配置');
    expect(report.sections.map((s) => s.heading)).toEqual(['各部門人數', '總結']);
    expect(report.sections[0].body).toContain('視覺設計部最多。');
    expect(report.sections[0].body).toContain('| 視覺設計部 | 8 |');
    expect(report.sections[0].charts?.[0]).toMatchObject({ kind: 'bar', complete: true });
  });

  it('模型沒給出可解析的 JSON 時，查到的結果照樣列成一節', async () => {
    stubTools(async () => queryData);
    const report = await buildDataReport({ tenantId: 't1', userId: 'u1', topic: '人力', llm: fakeLlm('完成了') });
    expect(report.title).toBe('人力');
    expect(report.sections.map((s) => s.heading)).toEqual(['查詢 1']);
  });

  it('查詢失敗或沒有資料庫工具時沒有任何一節', async () => {
    stubTools(async () => { throw new Error('此查詢超出可存取資料範圍'); });
    expect((await buildDataReport({ tenantId: 't1', userId: 'u1', topic: '人力', llm: fakeLlm('{}') })).sections).toEqual([]);

    jest.spyOn(toolRegistry, 'availableFor').mockReturnValue([]);
    const llm = fakeLlm('{}');
    expect((await buildDataReport({ tenantId: 't1', userId: 'u1', topic: '人力', llm })).sections).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('報告 job：資料庫來源', () => {
  const llm = {} as LLMProvider;

  it('不跑知識庫大綱，產出含表格的報告', async () => {
    const outline = jest.fn();
    const job = startReportJob(
      { tenantId: 't-db', userId: 'u1', topic: '人力', llm, source: 'database' },
      {
        outline,
        dataReport: async () => ({
          title: '人力配置',
          sections: [{ heading: '各部門人數', query: '', body: '重點\n\n| 部門 | 人數 |\n| --- | ---: |\n| A | 1 |', sources: [{ title: 'ds_oa_org' }], hits: 1 }],
        }),
      },
    );
    const done = await waitForJobForTest(job.id);
    expect(done).toMatchObject({ status: 'done', totalSections: 1, doneSections: 1 });
    expect(outline).not.toHaveBeenCalled();
    const md = (await reportStore.get(job.id, 'md'))?.content.toString() ?? '';
    expect(md).toContain('# 人力配置');
    expect(md).toContain('| A | 1 |');
    const html = (await reportStore.get(job.id, 'html'))?.content.toString() ?? '';
    expect(html).toContain('<table>');
  });

  it('沒有任何查詢結果 → empty', async () => {
    const job = startReportJob(
      { tenantId: 't-db2', userId: 'u1', topic: '人力', llm, source: 'database' },
      { dataReport: async () => ({ title: '', sections: [] }) },
    );
    expect((await waitForJobForTest(job.id)).status).toBe('empty');
  });
});
