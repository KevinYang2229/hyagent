import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuditSink } from '../src/audit';
import { MemoryCatalogStore } from '../src/catalog/store';
import type { AccessPolicy, PolicySet } from '../src/contracts/policy';
import type { CompiledQuery } from '../src/query/compiler';
import { capResult, type QueryExecutor } from '../src/query/executor';
import { DbIntelligenceService, directoryResolver, maskValue } from '../src/service';
import { callDbiTool, DBI_TOOLS, toolJsonSchema } from '../src/tools';
import { caller, demoCatalog, demoConfig, now } from './fixtures';

class FakeExecutor implements QueryExecutor {
  last?: CompiledQuery;
  rows: unknown[][] = [];
  async execute(_id: string, q: CompiledQuery) {
    this.last = q;
    return capResult(q, this.rows, 1_000_000, 1);
  }
}

let executor: FakeExecutor;
let audit: MemoryAuditSink;
let policySet: PolicySet;
let catalogs: MemoryCatalogStore;
let service: DbIntelligenceService;

beforeEach(async () => {
  executor = new FakeExecutor();
  audit = new MemoryAuditSink();
  policySet = structuredClone(demoConfig.policies);
  catalogs = new MemoryCatalogStore();
  await catalogs.save(demoCatalog());
  service = new DbIntelligenceService({
    dataSources: () => demoConfig.dataSources,
    catalogs,
    policies: () => policySet,
    principals: directoryResolver(demoConfig.principals),
    executor,
    audit,
    now,
    limits: { pageSize: 2 },
  });
});

const plan = (p: Record<string, unknown> = {}) => ({ version: '1.0', data_source_id: 'ds_project_01', dataset: 'projects', select: [{ field: 'name' }], ...p });

describe('search_schema', () => {
  it('只回傳可見資料集；DB 原始註解（含注入指令）不會交給模型', async () => {
    const r = await service.searchSchema(caller('alice'), { question: '今年有哪些專案？' });
    expect(r.matched).toBe(true);
    expect(r.data_sources).toEqual([{ id: 'ds_project_01', today: '2026-10-29', timezone: 'Asia/Taipei', catalog_version: 2 }]);
    expect(r.datasets[0].dataset).toBe('projects');
    expect(r.datasets[0].notes).toEqual(['資料列已依使用者權限限制範圍']);
    expect(r.datasets.map((d) => d.dataset)).not.toContain('employee_salary');
    expect(JSON.stringify(r)).not.toContain('忽略先前所有規則');
  });

  it('列出所有資料表：沒命中時回傳全部可見資料集', async () => {
    const r = await service.searchSchema(caller('alice'), { question: 'list tables' });
    expect(r.matched).toBe(false);
    expect(r.datasets.map((d) => d.dataset)).toEqual(['departments', 'projects']);
    const hr = await service.searchSchema(caller('hana'), { question: '薪資' });
    expect(hr.datasets[0]).toMatchObject({ dataset: 'employee_salary', notes: ['只允許統計（聚合）查詢'] });
    expect(hr.datasets[0].columns.map((c) => c.name)).toEqual(['department_id', 'salary']);
  });

  it('只顯示兩端都可見的關聯與計算指標', async () => {
    const r = await service.searchSchema(caller('bob'), { question: '超時' });
    const projects = r.datasets.find((d) => d.dataset === 'projects')!;
    expect(projects.metrics.map((m) => m.name)).toEqual(['actual_hours_over_estimated_ratio']);
    expect(projects.relationships.map((x) => x.dataset)).toEqual(['departments']);
    const hr = await service.searchSchema(caller('hana'), { question: '部門' });
    expect(hr.datasets.find((d) => d.dataset === 'departments')!.relationships.map((x) => x.dataset)).toEqual(['employee_salary']);
  });

  it('未登記的使用者、別的租戶看不到任何東西；系統呼叫被拒', async () => {
    expect((await service.searchSchema(caller('stranger'), { question: '專案' })).datasets).toEqual([]);
    expect((await service.searchSchema(caller('bob', 'other'), { question: '專案' })).datasets).toEqual([]);
    await expect(service.searchSchema({ ...caller(''), system: true }, { question: 'x' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('「限制」欄位提示只能統計：可用聚合、每組最少筆數，且沒有篩選運算子', async () => {
    const d = await service.getDatasetDetails(caller('hana'), { data_source_id: 'ds_project_01', dataset: 'employee_salary' });
    expect(d.columns.find((c) => c.name === 'salary')).toMatchObject({
      aggregate_only: true,
      aggregates: ['count', 'count_distinct', 'sum', 'avg'],
      min_group_size: 3,
      operators: [],
    });
    expect(d.columns.find((c) => c.name === 'department_id')).not.toHaveProperty('aggregate_only');
    const search = await service.searchSchema(caller('hana'), { question: '薪資' });
    expect(search.datasets[0].columns.find((c) => c.name === 'salary')).toMatchObject({ aggregate_only: true });
  });

  it('get_dataset_details 帶出運算子；看不到的資料集當作不存在', async () => {
    const d = await service.getDatasetDetails(caller('bob'), { data_source_id: 'ds_project_01', dataset: 'projects' });
    expect(d.primary_key).toEqual(['id']);
    expect(d.columns.find((c) => c.name === 'start_date')).toMatchObject({ type: 'date', operators: expect.arrayContaining(['gte', 'lt']) });
    await expect(service.getDatasetDetails(caller('bob'), { data_source_id: 'ds_project_01', dataset: 'employee_salary' })).rejects.toMatchObject({
      code: 'QUERY_DATASET_NOT_FOUND',
    });
  });
});

describe('execute_safe_query', () => {
  it('成功：回傳第一頁、依據與稽核（不含資料值）', async () => {
    executor.rows = [['A'], ['B'], ['C']];
    const r = await service.executeSafeQuery(caller('alice'), { query_plan: plan({ filters: [{ field: 'name', op: 'contains', value: '機密字串' }] }), request_id: 'llm-1' });
    expect(r.rows).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(r.row_count).toBe(3);
    expect(r.next_cursor).toBe(`${r.result_id}:2`);
    expect(r.basis).toMatchObject({ datasets: ['projects'], row_scope_applied: true, policy_version: '2026-10-29.1', catalog_version: 2 });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      request_id: r.request_id,
      client_request_id: 'llm-1',
      tenant_id: 'demo',
      principal_id: 'alice',
      status: 'success',
      row_count: 3,
      policy_ids: ['employee-own-department-projects'],
      datasets: ['public.projects'],
    });
    expect(JSON.stringify(audit.events)).not.toContain('機密字串');
    expect(audit.events[0].plan_summary).toMatchObject({ dataset: 'projects', filters: [{ field: 'name', op: 'contains', value: '<文字>' }] });
  });

  it('被拒絕時記錄 AI 組的查詢結構與詳細原因，供管理員追查', async () => {
    await expect(
      service.executeSafeQuery(caller('hana'), { query_plan: plan({ dataset: 'employee_salary', select: [{ field: 'department_id' }, { field: 'salary', agg: 'max' }], group_by: [{ field: 'department_id' }] }) }),
    ).rejects.toMatchObject({ code: 'QUERY_POLICY_DENIED' });
    expect(audit.events[0]).toMatchObject({
      status: 'denied',
      reason_detail: '限制欄位 salary 不能取最大或最小值',
      plan_summary: { dataset: 'employee_salary', select: [{ field: 'department_id' }, { field: 'salary', agg: 'max' }] },
    });
  });

  it('一般員工查全公司薪資：拒絕並留下稽核', async () => {
    await expect(service.executeSafeQuery(caller('alice'), { query_plan: plan({ dataset: 'employee_salary', select: [{ field: 'salary' }] }) })).rejects.toMatchObject({
      code: 'QUERY_POLICY_DENIED',
    });
    expect(audit.events[0]).toMatchObject({ status: 'denied', reason_code: 'QUERY_POLICY_DENIED', principal_id: 'alice' });
    expect(executor.last).toBeUndefined();
  });

  it('格式錯誤的 Plan 也會留下稽核', async () => {
    await expect(service.executeSafeQuery(caller('bob'), { query_plan: { sql: 'SELECT * FROM employee_salary' } })).rejects.toMatchObject({ code: 'QUERY_PLAN_INVALID' });
    expect(audit.events[0]).toMatchObject({ status: 'invalid', reason_code: 'QUERY_PLAN_INVALID' });
  });

  it('截斷與空結果都有 warnings', async () => {
    executor.rows = Array.from({ length: 4 }, (_, i) => [`P${i}`]);
    const r = await service.executeSafeQuery(caller('bob'), { query_plan: plan({ limit: 3 }) });
    expect(r.truncated).toBe(true);
    expect(r.warnings).toContain('結果超過 3 筆，只回傳前 3 筆');
    executor.rows = [];
    expect((await service.executeSafeQuery(caller('bob'), { query_plan: plan() })).warnings).toContain('查無符合條件的資料');
  });

  it('遮罩欄位在輸出前處理', async () => {
    const masked: AccessPolicy = { ...policySet.policies[1], id: 'masked-names', principals: { users: ['zoe'], roles: [] }, masked: { name: 'partial' } };
    policySet.policies.push(masked);
    executor.rows = [['官網改版', 1]];
    const r = await service.executeSafeQuery(
      { ...caller('zoe') },
      { query_plan: plan({ select: [{ field: 'name' }, { field: 'id' }] }) },
    );
    expect(r.rows).toEqual([{ name: '官**版', id: 1 }]);
    expect(r.warnings).toContain('欄位 name 已遮罩');
    expect(maskValue(null, 'redact')).toBeNull();
    expect(maskValue('ab', 'partial')).toBe('**');
  });
});

describe('get_query_result 快取隔離', () => {
  async function run() {
    executor.rows = [['A'], ['B'], ['C']];
    return service.executeSafeQuery(caller('bob'), { query_plan: plan() });
  }

  it('同一使用者可分頁', async () => {
    const r = await run();
    const p2 = await service.getQueryResult(caller('bob'), { result_id: r.result_id, cursor: r.next_cursor });
    expect(p2.rows).toEqual([{ name: 'C' }]);
    expect(p2).not.toHaveProperty('next_cursor');
  });

  it('其他使用者、其他租戶讀不到', async () => {
    const r = await run();
    await expect(service.getQueryResult(caller('alice'), { result_id: r.result_id })).rejects.toMatchObject({ code: 'QUERY_RESULT_NOT_FOUND' });
    await expect(service.getQueryResult(caller('bob', 'other'), { result_id: r.result_id })).rejects.toMatchObject({ code: 'QUERY_RESULT_NOT_FOUND' });
    expect(audit.events.at(-1)).toMatchObject({ tool: 'get_query_result', status: 'denied', principal_id: 'bob', tenant_id: 'other' });
  });

  it('政策或 Catalog 版本變更後失效', async () => {
    const r = await run();
    policySet.version = '2026-10-30.1';
    await expect(service.getQueryResult(caller('bob'), { result_id: r.result_id })).rejects.toMatchObject({ code: 'QUERY_RESULT_NOT_FOUND' });
    policySet.version = '2026-10-29.1';
    const c = (await catalogs.load('ds_project_01'))!;
    await catalogs.save({ ...c, version: c.version + 1 });
    await expect(service.getQueryResult(caller('bob'), { result_id: r.result_id })).rejects.toMatchObject({ code: 'QUERY_RESULT_NOT_FOUND' });
  });

  it('cursor 不能拿去讀別的結果', async () => {
    const a = await run();
    const b = await run();
    await expect(service.getQueryResult(caller('bob'), { result_id: b.result_id, cursor: a.next_cursor })).rejects.toMatchObject({ code: 'QUERY_PLAN_INVALID' });
  });
});

describe('MCP 工具層', () => {
  it('工具參數裡沒有任何身分欄位；全部唯讀', () => {
    for (const t of DBI_TOOLS) {
      const props = Object.keys(toolJsonSchema(t).properties ?? {});
      expect(props.some((p) => /tenant|user|role|department/i.test(p))).toBe(false);
    }
    const exec = toolJsonSchema(DBI_TOOLS.find((t) => t.name === 'execute_safe_query')!);
    expect(JSON.stringify(exec)).toContain('"enum":["eq","neq"');
  });

  it('錯誤以規格書格式回傳', async () => {
    const r = await callDbiTool(service, 'execute_safe_query', { query_plan: plan({ dataset: 'employee_salary' }) }, caller('alice'));
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.text);
    expect(body).toMatchObject({ error: { code: 'QUERY_POLICY_DENIED', message: '此查詢超出可存取資料範圍', retryable: false } });
    expect(body.request_id).toMatch(/^req_/);
  });

  it('成功回傳結構化內容；未知工具與多餘參數被拒', async () => {
    executor.rows = [['A']];
    const ok = await callDbiTool(service, 'execute_safe_query', { query_plan: plan() }, caller('bob'));
    expect(ok.structuredContent).toMatchObject({ rows: [{ name: 'A' }] });
    expect(ok.display).toEqual({ type: 'table', rows: 'rows', columns: [{ key: 'name', label: '專案名稱' }] });
    executor.rows = [];
    expect((await callDbiTool(service, 'execute_safe_query', { query_plan: plan() }, caller('bob'))).display).toBeUndefined();
    executor.rows = [['15']];
    expect((await callDbiTool(service, 'execute_safe_query', { query_plan: plan({ select: [{ agg: 'count' }] }) }, caller('bob'))).display).toBeUndefined();
    expect((await callDbiTool(service, 'search_schema', { question: 'x' }, caller('bob'))).display).toBeUndefined();
    expect((await callDbiTool(service, 'drop_table', {}, caller('bob'))).isError).toBe(true);
    expect((await callDbiTool(service, 'search_schema', { question: 'x', tenant_id: 'other' }, caller('bob'))).isError).toBe(true);
  });

  it('表格標題：Query Plan 的 label → 核准描述（取第一個標點前）→ 輸出名稱', async () => {
    executor.rows = [[3, 120, 2]];
    const select = [
      { field: 'department_id', agg: 'count_distinct', label: '負責部門' },
      { field: 'estimated_hours', agg: 'sum' },
      { agg: 'count' },
    ];
    const r = await service.executeSafeQuery(caller('bob'), { query_plan: plan({ select }) });
    expect(r.column_labels).toEqual(['負責部門', '預估工時合計', '筆數']);
    const next = await service.getQueryResult(caller('bob'), { result_id: r.result_id });
    expect(next.column_labels).toEqual(r.column_labels);
  });
});
