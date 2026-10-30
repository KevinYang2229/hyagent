/**
 * Query Plan Validator（規格書 4.2 步驟 4–5）：結構驗證 → 資料來源／租戶 → 資料集與 JOIN → 欄位、運算子、型別 →
 * 聚合規則 → 政策。輸出已解析的 ResolvedQuery，編譯器只吃這個，不會再看到模型給的原始字串。
 */
import { RESTRICTED_AGGREGATES, RESTRICTED_MIN_GROUP_SIZE, SENSITIVE_LEVELS, type Catalog, type CatalogDataset, type MetricExpr, type TypeCategory } from '../contracts/catalog';
import { DbiError } from '../contracts/errors';
import type { AccessPolicy, DataSource, Principal } from '../contracts/policy';
import { HARD_MAX_ROWS, queryPlanSchema, type Aggregate, type FilterOp, type QueryPlan } from '../contracts/queryPlan';
import { allowedColumns, decide, emptyUsage, policyApplies, type DatasetUsage, type ScopeCondition } from './policy';
import { metricColumns } from '../catalog/sync';

export type ValueExpr =
  | { kind: 'column'; alias: string; column: string; category: TypeCategory }
  | { kind: 'metric'; alias: string; key: string; expr: MetricExpr; category: 'numeric' };

export interface ResolvedDataset {
  alias: string;
  dataset: CatalogDataset;
  /** 主資料集沒有 join */
  join?: { type: 'inner' | 'left'; relationshipId: string; on: { leftAlias: string; leftColumn: string; rightColumn: string }[] };
  /** 可信政策帶入的資料列範圍 */
  scope: ScopeCondition[];
}

export interface ResolvedSelect {
  expr?: ValueExpr;
  agg?: Aggregate;
  output: string;
  mask?: 'redact' | 'partial';
}

export type FilterValue = string | number | boolean | (string | number | boolean)[] | undefined;

export interface ResolvedQuery {
  dataSourceId: string;
  datasets: ResolvedDataset[];
  select: ResolvedSelect[];
  filters: { expr: ValueExpr; op: FilterOp; value: FilterValue }[];
  groupBy: ValueExpr[];
  orderBy: { target: { output: string } | { expr: ValueExpr }; direction: 'asc' | 'desc' }[];
  limit: number;
  minGroupSize?: number;
  isAggregate: boolean;
  policyIds: string[];
  /** 查詢用到的機密／限制欄位（dataset.column），供稽核標記 */
  sensitiveColumns: string[];
}

export interface ValidationContext {
  catalog: Catalog | undefined;
  dataSources: DataSource[];
  policies: AccessPolicy[];
  principal: Principal;
}

const COMPARABLE = new Set<TypeCategory>(['numeric', 'text', 'date', 'timestamp']);
const AGG_TYPES: Record<Aggregate, Set<TypeCategory> | null> = {
  count: null,
  count_distinct: new Set(['numeric', 'text', 'boolean', 'date', 'timestamp', 'uuid']),
  sum: new Set(['numeric']),
  avg: new Set(['numeric']),
  min: COMPARABLE,
  max: COMPARABLE,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function validDate(s: string): boolean {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s.slice(0, 10);
}

function checkScalar(category: TypeCategory, v: unknown, field: string): void {
  const ok =
    (category === 'numeric' && typeof v === 'number') ||
    (category === 'text' && typeof v === 'string') ||
    (category === 'boolean' && typeof v === 'boolean') ||
    (category === 'uuid' && typeof v === 'string' && UUID.test(v)) ||
    (category === 'date' && typeof v === 'string' && DATE.test(v) && validDate(v)) ||
    (category === 'timestamp' && typeof v === 'string' && TIMESTAMP.test(v) && validDate(v));
  if (!ok) throw new DbiError('QUERY_PLAN_INVALID', `${field} 的比較值型別不符（欄位型別：${category}）`);
}

function checkFilter(expr: ValueExpr, op: FilterOp, value: unknown, field: string): void {
  const cat = expr.category;
  if (op === 'is_null' || op === 'is_not_null') {
    if (value !== undefined) throw new DbiError('QUERY_PLAN_INVALID', `${op} 不需要比較值`);
    return;
  }
  if (value === undefined) throw new DbiError('QUERY_PLAN_INVALID', `${field} 缺少比較值`);
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(value)) throw new DbiError('QUERY_PLAN_INVALID', `${op} 的比較值必須是陣列`);
    for (const v of value) checkScalar(cat, v, field);
    return;
  }
  if (Array.isArray(value)) throw new DbiError('QUERY_PLAN_INVALID', `${op} 的比較值不能是陣列`);
  if ((op === 'contains' || op === 'starts_with') && cat !== 'text') {
    throw new DbiError('QUERY_OPERATION_NOT_ALLOWED', `${op} 只能用於文字欄位`);
  }
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && !COMPARABLE.has(cat)) {
    throw new DbiError('QUERY_OPERATION_NOT_ALLOWED', `${field} 不支援大小比較`);
  }
  checkScalar(cat, value, field);
}

const sameExpr = (a: ValueExpr, b: ValueExpr) =>
  a.alias === b.alias && a.kind === b.kind && (a.kind === 'column' ? a.column === (b as typeof a).column : a.key === (b as typeof a).key);

const exprColumns = (e: ValueExpr): string[] => (e.kind === 'column' ? [e.column] : metricColumns(e.expr));

export function resolveQuery(input: unknown, ctx: ValidationContext): ResolvedQuery {
  const parsed = queryPlanSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DbiError('QUERY_PLAN_INVALID', `${issue.path.join('.') || '(root)'}：${issue.message}`);
  }
  const plan: QueryPlan = parsed.data;
  const { principal } = ctx;

  // 資料來源必須屬於呼叫者的租戶；不存在與不屬於本租戶回同一個錯誤，避免探測
  const ds = ctx.dataSources.find((d) => d.id === plan.data_source_id);
  if (!ds || ds.tenantId !== principal.tenantId) throw new DbiError('QUERY_DATA_SOURCE_DENIED');
  const catalog = ctx.catalog;
  if (!catalog || catalog.dataSourceId !== ds.id || catalog.tenantId !== ds.tenantId || !catalog.published) {
    throw new DbiError('CATALOG_NOT_PUBLISHED');
  }
  const findDataset = (key: string) => {
    const d = catalog.datasets.find((x) => x.key === key && x.approvalStatus === 'approved');
    if (!d) throw new DbiError('QUERY_DATASET_NOT_FOUND', key);
    return d;
  };

  // 資料集與 JOIN：只能沿已核准的關聯 join，每個資料集最多出現一次
  const datasets: ResolvedDataset[] = [{ alias: 't0', dataset: findDataset(plan.dataset), scope: [] }];
  for (const j of plan.joins) {
    const target = findDataset(j.dataset);
    if (datasets.some((d) => d.dataset.id === target.id)) throw new DbiError('QUERY_JOIN_NOT_ALLOWED', `${j.dataset} 已在查詢中`);
    const candidates = catalog.relationships.filter(
      (r) =>
        r.approvalStatus === 'approved' &&
        ((r.to.dataset === target.id && datasets.some((d) => d.dataset.id === r.from.dataset)) ||
          (r.from.dataset === target.id && datasets.some((d) => d.dataset.id === r.to.dataset))),
    );
    const rel = j.relationship_id ? candidates.find((r) => r.id === j.relationship_id) : candidates.length === 1 ? candidates[0] : undefined;
    if (!rel) {
      throw new DbiError('QUERY_JOIN_NOT_ALLOWED', candidates.length > 1 ? `${j.dataset} 有多條關聯，請指定 relationship_id` : j.dataset);
    }
    const targetIsTo = rel.to.dataset === target.id;
    const near = targetIsTo ? rel.from : rel.to;
    const far = targetIsTo ? rel.to : rel.from;
    const left = datasets.find((d) => d.dataset.id === near.dataset)!;
    datasets.push({
      alias: `t${datasets.length}`,
      dataset: target,
      scope: [],
      join: {
        type: j.type,
        relationshipId: rel.id,
        on: near.columns.map((c, i) => ({ leftAlias: left.alias, leftColumn: c, rightColumn: far.columns[i] })),
      },
    });
  }

  // 先確認每個資料集都有適用政策，再看欄位：沒權限的人不能藉錯誤訊息探測欄位名稱
  const candidates = new Map<string, AccessPolicy[]>();
  const visibleCols = new Map<string, Set<string>>();
  for (const d of datasets) {
    const ps = ctx.policies.filter((p) => policyApplies(p, principal, ds.id, d.dataset.id));
    if (ps.length === 0) throw new DbiError('QUERY_POLICY_DENIED');
    candidates.set(d.alias, ps);
    visibleCols.set(d.alias, new Set(ps.flatMap((p) => [...allowedColumns(p, d.dataset)])));
  }

  const byKey = (key: string | undefined) => {
    if (key === undefined) return datasets[0];
    const d = datasets.find((x) => x.dataset.key === key);
    if (!d) throw new DbiError('QUERY_PLAN_INVALID', `資料集 ${key} 不在查詢中（需先 join）`);
    return d;
  };
  const resolveField = (field: string, dataset: string | undefined): ValueExpr => {
    const d = byKey(dataset);
    const visible = visibleCols.get(d.alias)!;
    // 不可查詢與政策看不到的欄位，和不存在的欄位回同一個錯誤
    const col = d.dataset.columns.find((c) => c.name === field && visible.has(c.name));
    if (col) return { kind: 'column', alias: d.alias, column: col.name, category: col.typeCategory };
    const metric = d.dataset.metrics.find((m) => m.key === field);
    if (metric && metricColumns(metric.expression).every((c) => visible.has(c))) {
      if (metric.approvalStatus !== 'approved') throw new DbiError('QUERY_METRIC_UNDEFINED', field);
      return { kind: 'metric', alias: d.alias, key: metric.key, expr: metric.expression, category: 'numeric' };
    }
    throw new DbiError('QUERY_FIELD_NOT_ALLOWED', `${d.dataset.key}.${field}（若是計算指標，需由管理員先定義）`);
  };

  const usage = new Map(datasets.map((d) => [d.alias, emptyUsage()]));
  const sensitivityOf = (alias: string, column: string) =>
    datasets.find((d) => d.alias === alias)!.dataset.columns.find((c) => c.name === column)?.sensitivity;
  const restrictedIn = (e: ValueExpr) => exprColumns(e).filter((c) => sensitivityOf(e.alias, c) === 'restricted');
  const use = (e: ValueExpr, kind: keyof DatasetUsage) => {
    for (const c of exprColumns(e)) usage.get(e.alias)![kind].add(c);
  };

  const groupBy = plan.group_by.map((g) => resolveField(g.field, g.dataset));
  const isAggregate = groupBy.length > 0 || plan.select.some((s) => s.agg);

  const select: ResolvedSelect[] = plan.select.map((s) => {
    const expr = s.field === undefined ? undefined : resolveField(s.field, s.dataset);
    if (s.agg) {
      const allowed = AGG_TYPES[s.agg];
      if (expr && allowed && !allowed.has(expr.category)) throw new DbiError('QUERY_OPERATION_NOT_ALLOWED', `${s.field} 不能使用 ${s.agg}`);
      // 最大／最小值就是某一筆的確切數值，對「限制」欄位等於洩漏明細
      if (expr && !RESTRICTED_AGGREGATES.includes(s.agg) && restrictedIn(expr).length) {
        throw new DbiError('QUERY_POLICY_DENIED', `限制欄位 ${restrictedIn(expr).join('、')} 不能取最大或最小值`);
      }
      if (expr) use(expr, 'aggregated');
    } else if (isAggregate) {
      if (!groupBy.some((g) => sameExpr(g, expr!))) throw new DbiError('QUERY_PLAN_INVALID', `${s.field} 必須列在 group_by，或改用聚合函式`);
    } else {
      // 計算指標的輸出是運算結果，無法遮罩：與直接輸出的欄位分開判斷
      use(expr!, expr!.kind === 'metric' ? 'derived' : 'raw');
    }
    const output = s.alias ?? (s.agg ? (s.field ? `${s.agg}_${s.field}` : 'count') : s.field!);
    return { expr, agg: s.agg, output };
  });
  const outputs = new Set<string>();
  for (const s of select) {
    if (outputs.has(s.output)) throw new DbiError('QUERY_PLAN_INVALID', `輸出欄位 ${s.output} 重複，請用 alias 區分`);
    outputs.add(s.output);
  }
  for (const g of groupBy) use(g, 'grouped');

  const filters = plan.filters.map((f) => {
    const expr = resolveField(f.field, f.dataset);
    checkFilter(expr, f.op, f.value, f.field);
    use(expr, 'filtered');
    return { expr, op: f.op, value: f.value };
  });

  const orderBy = plan.order_by.map((o) => {
    if (o.dataset === undefined && outputs.has(o.field)) return { target: { output: o.field }, direction: o.direction };
    const expr = resolveField(o.field, o.dataset);
    if (isAggregate && !groupBy.some((g) => sameExpr(g, expr))) throw new DbiError('QUERY_PLAN_INVALID', `排序欄位 ${o.field} 必須在 group_by 或 select 輸出中`);
    use(expr, 'ordered');
    return { target: { expr }, direction: o.direction };
  });

  // 政策：每個資料集各自要有一條政策完整允許其用法
  let limit = Math.min(plan.limit, HARD_MAX_ROWS);
  let minGroupSize: number | undefined;
  const policyIds: string[] = [];
  for (const d of datasets) {
    const r = decide(candidates.get(d.alias)!, d.dataset, usage.get(d.alias)!, isAggregate, principal);
    if (!r.ok) throw new DbiError('QUERY_POLICY_DENIED', r.reason);
    d.scope = r.decision.rowScope;
    policyIds.push(r.decision.policy.id);
    if (r.decision.policy.maxRows) limit = Math.min(limit, r.decision.policy.maxRows);
    if (isAggregate && r.decision.policy.minGroupSize) minGroupSize = Math.max(minGroupSize ?? 0, r.decision.policy.minGroupSize);
    for (const s of select) {
      if (s.expr?.kind === 'column' && s.expr.alias === d.alias && !s.agg) {
        const mask = r.decision.masked.get(s.expr.column);
        if (mask) s.mask = mask;
      }
    }
  }

  // 聚合「限制」欄位時強制最少筆數，即使政策沒設 minGroupSize
  const aggregatesRestricted = datasets.some((d) =>
    [...usage.get(d.alias)!.aggregated].some((c) => sensitivityOf(d.alias, c) === 'restricted'),
  );
  if (aggregatesRestricted) minGroupSize = Math.max(minGroupSize ?? 0, RESTRICTED_MIN_GROUP_SIZE);

  const sensitiveColumns = datasets.flatMap((d) => {
    const u = usage.get(d.alias)!;
    const used = new Set([...u.raw, ...u.derived, ...u.grouped, ...u.aggregated, ...u.filtered, ...u.ordered]);
    return [...used].filter((c) => SENSITIVE_LEVELS.has(sensitivityOf(d.alias, c)!)).map((c) => `${d.dataset.key}.${c}`);
  });

  return { dataSourceId: ds.id, datasets, select, filters, groupBy, orderBy, limit, minGroupSize, isAggregate, policyIds, sensitiveColumns };
}
