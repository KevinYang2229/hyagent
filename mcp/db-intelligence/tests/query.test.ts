import { describe, expect, it } from 'vitest';
import { applyCatalogReview } from '../src/catalog/review';
import type { Catalog } from '../src/contracts/catalog';
import type { AccessPolicy } from '../src/contracts/policy';
import type { QueryPlanInput } from '../src/contracts/queryPlan';
import { compileQuery } from '../src/query/compiler';
import { resolveQuery, type ValidationContext } from '../src/query/validator';
import { demoCatalog, demoConfig, principal } from './fixtures';

const catalog = demoCatalog();

function ctx(userId: string, over: Partial<ValidationContext> = {}): ValidationContext {
  return { catalog, dataSources: demoConfig.dataSources, policies: demoConfig.policies.policies, principal: principal(userId), ...over };
}

const plan = (p: Partial<QueryPlanInput>): QueryPlanInput => ({
  version: '1.0',
  data_source_id: 'ds_project_01',
  dataset: 'projects',
  select: [{ field: 'name' }],
  ...p,
});

const compile = (p: Partial<QueryPlanInput>, userId = 'bob', over: Partial<ValidationContext> = {}) => compileQuery(resolveQuery(plan(p), ctx(userId, over)));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'OK';
};

describe('Demo 案例（規格書 10）', () => {
  it('今年有哪些專案：日期篩選走參數', () => {
    const q = compile({
      select: [{ field: 'name' }, { field: 'start_date' }],
      filters: [
        { field: 'start_date', op: 'gte', value: '2026-01-01' },
        { field: 'start_date', op: 'lt', value: '2027-01-01' },
      ],
      order_by: [{ field: 'start_date', direction: 'asc' }],
    });
    expect(q.sql).toBe(
      [
        'SELECT t0."name" AS "name", t0."start_date" AS "start_date"',
        'FROM "public"."projects" AS t0',
        'WHERE (t0."start_date" >= $1) AND (t0."start_date" < $2)',
        'ORDER BY "start_date" ASC',
        'LIMIT $3',
      ].join('\n'),
    );
    expect(q.params).toEqual(['2026-01-01', '2027-01-01', 101]);
  });

  it('哪些專案超時 20%：使用已核准計算欄位，除以零以 NULLIF 處理', () => {
    const q = compile({
      select: [{ field: 'name' }, { field: 'estimated_hours' }, { field: 'actual_hours' }, { field: 'actual_hours_over_estimated_ratio', alias: 'ratio' }],
      filters: [{ field: 'actual_hours_over_estimated_ratio', op: 'gt', value: 1.2 }],
    });
    expect(q.sql).toContain('(t0."actual_hours"::numeric / NULLIF(t0."estimated_hours"::numeric, 0)) AS "ratio"');
    expect(q.sql).toContain('WHERE ((t0."actual_hours"::numeric / NULLIF(t0."estimated_hours"::numeric, 0)) > $1)');
    expect(q.params).toEqual([1.2, 101]);
  });

  it('各部門專案數量：沿已核准外鍵 join 並聚合', () => {
    const q = compile({
      joins: [{ dataset: 'departments' }],
      select: [{ field: 'name', dataset: 'departments', alias: 'department' }, { agg: 'count', alias: 'project_count' }],
      group_by: [{ field: 'name', dataset: 'departments' }],
      order_by: [{ field: 'project_count', direction: 'desc' }],
    });
    expect(q.sql).toBe(
      [
        'SELECT t1."name" AS "department", count(*) AS "project_count"',
        'FROM "public"."projects" AS t0',
        'JOIN "public"."departments" AS t1 ON t0."department_id" = t1."id"',
        'GROUP BY t1."name"',
        'ORDER BY "project_count" DESC',
        'LIMIT $1',
      ].join('\n'),
    );
  });

  it('我的部門有哪些專案：部門範圍來自可信身分，不是模型', () => {
    const q = compile({ select: [{ field: 'name' }] }, 'alice');
    expect(q.sql).toContain('WHERE (t0."department_id" = $1)');
    expect(q.params).toEqual([1, 101]);
  });

  it('公司所有員工薪資：一般員工、主管都拒絕；HR 只能看每組 ≥ 3 人的統計', () => {
    const salaryRows = plan({ dataset: 'employee_salary', select: [{ field: 'salary' }] });
    expect(code(() => resolveQuery(salaryRows, ctx('alice')))).toBe('QUERY_POLICY_DENIED');
    expect(code(() => resolveQuery(salaryRows, ctx('bob')))).toBe('QUERY_POLICY_DENIED');
    expect(code(() => resolveQuery(salaryRows, ctx('hana')))).toBe('QUERY_POLICY_DENIED');
    expect(code(() => resolveQuery(plan({ dataset: 'employee_salary', select: [{ field: 'employee_name' }] }), ctx('hana')))).toBe('QUERY_FIELD_NOT_ALLOWED');

    const q = compile(
      { dataset: 'employee_salary', select: [{ field: 'department_id' }, { field: 'salary', agg: 'avg', alias: 'avg_salary' }], group_by: [{ field: 'department_id' }] },
      'hana',
    );
    expect(q.sql).toContain('GROUP BY t0."department_id"\nHAVING count(*) >= $1');
    expect(q.params).toEqual([3, 101]);
  });

  it('專案完成率（未定義）：不猜測，回報欄位未定義', () => {
    expect(code(() => resolveQuery(plan({ select: [{ field: 'completion_rate' }] }), ctx('bob')))).toBe('QUERY_FIELD_NOT_ALLOWED');
    const pending = applyCatalogReview(catalog, {
      datasets: [{ id: 'public.projects', metrics: [{ key: 'completion_rate', description: '', expression: { column: 'actual_hours' }, approvalStatus: 'pending' }] }],
    });
    expect(code(() => resolveQuery(plan({ select: [{ field: 'completion_rate' }] }), ctx('bob', { catalog: pending })))).toBe('QUERY_METRIC_UNDEFINED');
  });
});

describe('威脅測試（規格書 7.4）', () => {
  it('Query Plan 指定另一租戶或不存在的資料來源：同一個錯誤', () => {
    const other = { ...demoConfig.dataSources[0], id: 'ds_other', tenantId: 'other' };
    const c = ctx('bob', { dataSources: [...demoConfig.dataSources, other] });
    expect(code(() => resolveQuery(plan({ data_source_id: 'ds_other' }), c))).toBe('QUERY_DATA_SOURCE_DENIED');
    expect(code(() => resolveQuery(plan({ data_source_id: 'nope' }), c))).toBe('QUERY_DATA_SOURCE_DENIED');
  });

  it('身分只認可信 principal：Plan 夾帶 tenant_id／user_id 欄位直接被拒', () => {
    expect(code(() => resolveQuery({ ...plan({}), tenant_id: 'other', user_id: 'admin' }, ctx('alice')))).toBe('QUERY_PLAN_INVALID');
  });

  it('非法欄位、未核准 JOIN、未核准資料集', () => {
    expect(code(() => resolveQuery(plan({ select: [{ field: 'secret' }] }), ctx('bob')))).toBe('QUERY_FIELD_NOT_ALLOWED');
    expect(code(() => resolveQuery(plan({ dataset: 'internal_secrets' }), ctx('bob')))).toBe('QUERY_DATASET_NOT_FOUND');
    // employee_salary ↔ projects 沒有關聯
    expect(code(() => resolveQuery(plan({ joins: [{ dataset: 'employee_salary' }] }), ctx('hana')))).toBe('QUERY_JOIN_NOT_ALLOWED');
    const withPending = applyCatalogReview(catalog, {
      addRelationships: [{ from: { dataset: 'public.employee_salary', columns: ['department_id'] }, to: { dataset: 'public.projects', columns: ['department_id'] } }],
    });
    expect(code(() => resolveQuery(plan({ joins: [{ dataset: 'employee_salary' }] }), ctx('hana', { catalog: withPending })))).toBe('QUERY_JOIN_NOT_ALLOWED');
    const unapproved = applyCatalogReview(catalog, { datasets: [{ id: 'public.departments', approvalStatus: 'pending' }] });
    expect(code(() => resolveQuery(plan({ joins: [{ dataset: 'departments' }] }), ctx('bob', { catalog: unapproved })))).toBe('QUERY_DATASET_NOT_FOUND');
  });

  it('SQL 注入字串：值走參數、識別字只認 Catalog、別名有白名單', () => {
    const evil = "x'; DROP TABLE projects; --";
    const q = compile({ filters: [{ field: 'name', op: 'eq', value: evil }] });
    expect(q.sql).not.toContain('DROP');
    expect(q.params[0]).toBe(evil);
    const like = compile({ filters: [{ field: 'name', op: 'contains', value: '100%_\\' }] });
    expect(like.params[0]).toBe('%100\\%\\_\\\\%');
    expect(code(() => resolveQuery(plan({ select: [{ field: 'name"; DROP TABLE projects; --' }] }), ctx('bob')))).toBe('QUERY_FIELD_NOT_ALLOWED');
    expect(code(() => resolveQuery(plan({ select: [{ field: 'name', alias: 'x" FROM pg_shadow --' }] }), ctx('bob')))).toBe('QUERY_PLAN_INVALID');
    expect(code(() => resolveQuery(plan({ dataset: 'pg_catalog.pg_authid' }), ctx('bob')))).toBe('QUERY_DATASET_NOT_FOUND');
  });

  it('超大量資料：筆數上限取政策與硬上限較小者', () => {
    expect(compile({ limit: 1000 }, 'alice').limit).toBe(200);
    expect(compile({ limit: 1000 }, 'bob').limit).toBe(1000);
    expect(code(() => resolveQuery(plan({ limit: 5000 }), ctx('bob')))).toBe('QUERY_PLAN_INVALID');
  });

  it('Schema 新增的欄位預設不可查', () => {
    const c: Catalog = structuredClone(catalog);
    c.datasets.find((d) => d.key === 'projects')!.columns.push({ ...c.datasets[0].columns[0], name: 'budget', isQueryable: false, reviewStatus: 'new' });
    expect(code(() => resolveQuery(plan({ select: [{ field: 'budget' }] }), ctx('bob', { catalog: c })))).toBe('QUERY_FIELD_NOT_ALLOWED');
  });

  it('未發布的 Catalog 不能查', () => {
    expect(code(() => resolveQuery(plan({}), ctx('bob', { catalog: { ...catalog, published: false } })))).toBe('CATALOG_NOT_PUBLISHED');
    expect(code(() => resolveQuery(plan({}), ctx('bob', { catalog: undefined })))).toBe('CATALOG_NOT_PUBLISHED');
  });
});

describe('政策組合', () => {
  const extra = (p: Partial<AccessPolicy>): AccessPolicy => ({
    id: 'x',
    tenantId: 'demo',
    dataSourceId: 'ds_project_01',
    dataset: 'public.projects',
    principals: { users: [], roles: ['employee'] },
    columns: ['*'],
    masked: {},
    rowScope: [],
    aggregateOnly: false,
    ...p,
  });

  it('「部門範圍明細」＋「全公司僅聚合」不會拼成全公司明細', () => {
    const policies = [...demoConfig.policies.policies, extra({ id: 'company-stats', aggregateOnly: true })];
    const raw = compile({ select: [{ field: 'name' }] }, 'alice', { policies });
    expect(raw.sql).toContain('t0."department_id" = $1');
    const agg = compile({ select: [{ agg: 'count' }] }, 'alice', { policies });
    expect(agg.sql).not.toContain('WHERE');
  });

  it('缺少資料範圍所需屬性的使用者被拒，而不是看到全部', () => {
    const p = { ...principal('alice'), attributes: {} };
    expect(code(() => resolveQuery(plan({}), ctx('alice', { principal: p })))).toBe('QUERY_POLICY_DENIED');
  });

  it('遮罩欄位只能顯示，不能篩選、排序、分組或計算', () => {
    const policies = [extra({ id: 'masked', principals: { users: ['zoe'], roles: [] }, masked: { name: 'partial' } })];
    const z = { ...principal('zoe'), roles: [] };
    const r = resolveQuery(plan({ select: [{ field: 'name' }, { field: 'id' }] }), ctx('zoe', { policies, principal: z }));
    expect(r.select.map((s) => s.mask)).toEqual(['partial', undefined]);
    expect(code(() => resolveQuery(plan({ filters: [{ field: 'name', op: 'starts_with', value: '官' }] }), ctx('zoe', { policies, principal: z })))).toBe('QUERY_POLICY_DENIED');
    expect(code(() => resolveQuery(plan({ select: [{ field: 'name', agg: 'count_distinct' }] }), ctx('zoe', { policies, principal: z })))).toBe('QUERY_POLICY_DENIED');
  });

  it("columns: ['*'] 不涵蓋 confidential 以上的欄位", () => {
    const policies = [extra({ id: 'star', dataset: 'public.employee_salary', principals: { users: [], roles: ['hr'] }, aggregateOnly: true })];
    expect(code(() => resolveQuery(plan({ dataset: 'employee_salary', select: [{ field: 'salary', agg: 'avg' }] }), ctx('hana', { policies })))).toBe('QUERY_FIELD_NOT_ALLOWED');
  });

  it('沒有政策的人不能藉錯誤訊息探測欄位：存在與不存在的欄位回同一個錯誤', () => {
    for (const field of ['salary', 'employee_name', 'no_such_column']) {
      expect(code(() => resolveQuery(plan({ dataset: 'employee_salary', select: [{ field }] }), ctx('alice')))).toBe('QUERY_POLICY_DENIED');
    }
  });

  it('left join 時被 join 資料集的資料列範圍放在 ON', () => {
    const policies = [
      ...demoConfig.policies.policies.filter((p) => p.dataset !== 'public.departments'),
      extra({ id: 'own-dept', dataset: 'public.departments', rowScope: [{ column: 'id', attribute: 'departmentId' }] }),
    ];
    const q = compile(
      { joins: [{ dataset: 'departments', type: 'left' }], select: [{ field: 'name' }, { field: 'name', dataset: 'departments', alias: 'dept' }] },
      'alice',
      { policies },
    );
    expect(q.sql).toContain('LEFT JOIN "public"."departments" AS t1 ON t0."department_id" = t1."id" AND t1."id" = $1');
    expect(q.sql).toContain('WHERE (t0."department_id" = $2)');
  });
});

describe('結構與型別驗證', () => {
  it.each([
    [{ filters: [{ field: 'start_date', op: 'gte', value: 'abc' }] }, 'QUERY_PLAN_INVALID'],
    [{ filters: [{ field: 'start_date', op: 'gte', value: '2026-02-30' }] }, 'QUERY_PLAN_INVALID'],
    [{ filters: [{ field: 'estimated_hours', op: 'gt', value: '10' }] }, 'QUERY_PLAN_INVALID'],
    [{ filters: [{ field: 'estimated_hours', op: 'contains', value: 1 }] }, 'QUERY_OPERATION_NOT_ALLOWED'],
    [{ filters: [{ field: 'name', op: 'in', value: 'a' }] }, 'QUERY_PLAN_INVALID'],
    [{ filters: [{ field: 'name', op: 'is_null', value: 'a' }] }, 'QUERY_PLAN_INVALID'],
    [{ select: [{ field: 'name', agg: 'sum' }] }, 'QUERY_OPERATION_NOT_ALLOWED'],
    [{ select: [{ field: 'name' }, { agg: 'count' }] }, 'QUERY_PLAN_INVALID'],
    [{ select: [{ field: 'name' }, { field: 'name' }] }, 'QUERY_PLAN_INVALID'],
    [{ select: [{ agg: 'sum' }] }, 'QUERY_PLAN_INVALID'],
    [{ select: [{ agg: 'count' }], order_by: [{ field: 'name' }] }, 'QUERY_PLAN_INVALID'],
    [{ select: [{ field: 'name', dataset: 'departments' }] }, 'QUERY_PLAN_INVALID'],
    [{ joins: [{ dataset: 'projects' }] }, 'QUERY_JOIN_NOT_ALLOWED'],
  ] as [Partial<QueryPlanInput>, string][])('%j → %s', (p, expected) => {
    expect(code(() => resolveQuery(plan(p), ctx('bob')))).toBe(expected);
  });

  it('in 走 = ANY 陣列參數', () => {
    const q = compile({ filters: [{ field: 'department_id', op: 'not_in', value: [1, 2] }] });
    expect(q.sql).toContain('NOT (t0."department_id" = ANY($1))');
    expect(q.params[0]).toEqual([1, 2]);
  });
});

describe('敏感度：「限制」欄位只能統計或遮罩後顯示', () => {
  // salary 改為「限制」；另給 HR 一條沒有 aggregateOnly、沒有 minGroupSize 的寬鬆政策，驗證規則不靠政策寫對
  const restricted = applyCatalogReview(catalog, {
    datasets: [
      {
        id: 'public.employee_salary',
        columns: { salary: { sensitivity: 'restricted' }, employee_name: { isQueryable: true, sensitivity: 'internal' } },
        metrics: [{ key: 'salary_k', description: '月薪（千元）', expression: { op: 'div', args: [{ column: 'salary' }, { number: 1000 }] } }],
      },
    ],
  });
  const loose: AccessPolicy = {
    id: 'hr-loose',
    tenantId: 'demo',
    dataSourceId: 'ds_project_01',
    dataset: 'public.employee_salary',
    principals: { users: [], roles: ['hr'] },
    columns: ['*', 'salary'],
    masked: {},
    rowScope: [],
    aggregateOnly: false,
  };
  const c = (policies: AccessPolicy[] = [loose]) => ctx('hana', { catalog: restricted, policies });
  const p = (x: Partial<QueryPlanInput>) => plan({ dataset: 'employee_salary', ...x });

  it('平均、加總可以，且強制每組至少 3 筆；最大／最小值不行', () => {
    const r = resolveQuery(p({ select: [{ field: 'department_id' }, { field: 'salary', agg: 'avg' }], group_by: [{ field: 'department_id' }] }), c());
    expect(r.minGroupSize).toBe(3);
    expect(compileQuery(r).sql).toContain('HAVING count(*) >= $1');
    expect(r.sensitiveColumns).toEqual(['employee_salary.salary']);
    for (const agg of ['max', 'min'] as const) {
      expect(code(() => resolveQuery(p({ select: [{ field: 'salary', agg }] }), c()))).toBe('QUERY_POLICY_DENIED');
    }
  });

  it('政策的 minGroupSize 較大時以政策為準', () => {
    const r = resolveQuery(p({ select: [{ field: 'salary', agg: 'sum' }] }), c([{ ...loose, minGroupSize: 5 }]));
    expect(r.minGroupSize).toBe(5);
  });

  it('不能直接顯示、篩選或分組；遮罩後可以顯示', () => {
    expect(code(() => resolveQuery(p({ select: [{ field: 'employee_name' }, { field: 'salary' }] }), c()))).toBe('QUERY_POLICY_DENIED');
    expect(code(() => resolveQuery(p({ select: [{ agg: 'count' }], filters: [{ field: 'salary', op: 'gt', value: 80000 }] }), c()))).toBe('QUERY_POLICY_DENIED');
    expect(code(() => resolveQuery(p({ select: [{ field: 'salary' }, { agg: 'count' }], group_by: [{ field: 'salary' }] }), c()))).toBe('QUERY_POLICY_DENIED');
    const masked = resolveQuery(p({ select: [{ field: 'employee_name' }, { field: 'salary' }] }), c([{ ...loose, masked: { salary: 'redact' } }]));
    expect(masked.select.map((s) => s.mask)).toEqual([undefined, 'redact']);
  });

  it('計算指標不能用來繞過：直接顯示引用限制或遮罩欄位的指標一律拒絕', () => {
    expect(code(() => resolveQuery(p({ select: [{ field: 'salary_k' }] }), c([{ ...loose, masked: { salary: 'redact' } }])))).toBe('QUERY_POLICY_DENIED');
    // 一般（非限制）欄位設了遮罩，同樣不能經由指標輸出原值
    const internal = applyCatalogReview(restricted, { datasets: [{ id: 'public.employee_salary', columns: { salary: { sensitivity: 'internal' } } }] });
    expect(code(() => resolveQuery(p({ select: [{ field: 'salary_k' }] }), ctx('hana', { catalog: internal, policies: [{ ...loose, masked: { salary: 'partial' } }] })))).toBe('QUERY_POLICY_DENIED');
    // 統計指標可以
    expect(resolveQuery(p({ select: [{ field: 'salary_k', agg: 'avg' }] }), c()).minGroupSize).toBe(3);
  });

  it('機密欄位照常可查，但列入敏感欄位供稽核標記', () => {
    const r = resolveQuery(plan({ dataset: 'employee_salary', select: [{ field: 'salary', agg: 'avg' }] }), ctx('hana'));
    expect(r.sensitiveColumns).toEqual(['employee_salary.salary']);
    expect(resolveQuery(plan({}), ctx('bob')).sensitiveColumns).toEqual([]);
  });
});
