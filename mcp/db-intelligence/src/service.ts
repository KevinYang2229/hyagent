/**
 * Database Intelligence 協調流程（規格書 4.2）：可信身分 → Validator/Policy → Compiler → Executor → 遮罩／最小化 → 稽核。
 * tenant 與 user 只取自 HyAgent 簽發的 JWT（HyAgentCaller），工具參數裡沒有任何身分欄位。
 */
import { randomUUID } from 'node:crypto';
import type { HyAgentCaller } from '@hyagent/mcp-kit';
import { planHash, redactPlan, type AuditEvent, type AuditSink } from './audit';
import { searchDatasets, visibleDatasets, type VisibleDataset } from './catalog/search';
import type { CatalogStore } from './catalog/store';
import { RESTRICTED_AGGREGATES, RESTRICTED_MIN_GROUP_SIZE, type Catalog, type TypeCategory } from './contracts/catalog';
import { DbiError } from './contracts/errors';
import type { DataSource, PolicySet, Principal, PrincipalDirectory } from './contracts/policy';
import type { Aggregate, FilterOp } from './contracts/queryPlan';
import { compileQuery } from './query/compiler';
import { dialectFor } from './query/dialect';
import type { QueryExecutor } from './query/executor';
import { resolveQuery, type ResolvedQuery, type ResolvedSelect } from './query/validator';
import { metricColumns } from './catalog/sync';

export interface PrincipalResolver {
  resolve(caller: HyAgentCaller): Principal | Promise<Principal>;
}

/**
 * 角色＝使用者目錄的角色 ∪ JWT scope 推導的角色。HyAgent 只把 `mcp:<serverId>` 開頭的 scope 帶進 JWT，
 * `mcp:<serverId>:<role>` 即視為角色 `<role>`，可直接沿用後台的部門／帳號授權。
 * 資料列範圍用的屬性（如 departmentId）只來自目錄；目錄沒有就沒有，帶屬性的政策會拒絕。
 */
export function directoryResolver(dir: PrincipalDirectory | (() => PrincipalDirectory), opts: { serverId?: string } = {}): PrincipalResolver {
  const read = typeof dir === 'function' ? dir : () => dir;
  const prefix = opts.serverId ? `mcp:${opts.serverId}:` : undefined;
  return {
    resolve(caller) {
      const entry = read()[caller.tenantId]?.[caller.userId];
      const scopeRoles = prefix ? caller.scopes.filter((s) => s.startsWith(prefix) && s.length > prefix.length).map((s) => s.slice(prefix.length)) : [];
      return {
        tenantId: caller.tenantId,
        userId: caller.userId,
        roles: [...new Set([...(entry?.roles ?? []), ...scopeRoles])],
        attributes: entry?.attributes ?? {},
      };
    },
  };
}

export interface ServiceLimits {
  timeoutMs: number;
  maxBytes: number;
  /** 每頁回傳給模型的筆數 */
  pageSize: number;
  resultTtlMs: number;
  maxCachedResults: number;
}

const DEFAULT_LIMITS: ServiceLimits = { timeoutMs: 10_000, maxBytes: 512 * 1024, pageSize: 50, resultTtlMs: 10 * 60_000, maxCachedResults: 500 };

export interface ServiceOptions {
  /** 每次請求取最新資料來源（可由管理 API 修改） */
  dataSources: () => DataSource[];
  catalogs: CatalogStore;
  /** 每次請求取最新政策（可熱更新） */
  policies: () => PolicySet;
  principals: PrincipalResolver;
  executor: QueryExecutor;
  audit: AuditSink;
  now?: () => Date;
  limits?: Partial<ServiceLimits>;
}

interface CachedResult {
  tenantId: string;
  userId: string;
  policyVersion: string;
  catalogVersion: number;
  dataSourceId: string;
  expiresAt: number;
  columns: string[];
  columnLabels: string[];
  rows: Record<string, unknown>[];
}

const OPERATORS: Record<TypeCategory, FilterOp[]> = {
  numeric: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'],
  timestamp: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
  text: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null'],
  uuid: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
  boolean: ['eq', 'neq', 'is_null', 'is_not_null'],
  other: [],
};

const AGG_LABELS: Record<Aggregate, (field: string) => string> = {
  count: (f) => `${f}筆數`,
  count_distinct: (f) => `${f}數`,
  sum: (f) => `${f}合計`,
  avg: (f) => `平均${f}`,
  min: (f) => `最小${f}`,
  max: (f) => `最大${f}`,
};

/** 描述取第一個標點前的部分當標題，例如「離職日；空值代表仍在職」→「離職日」 */
function shortLabel(description: string | null | undefined): string | undefined {
  const head = description?.split(/[；;，,。：:（(\n]/)[0].trim();
  return head ? head.slice(0, 20) : undefined;
}

/** 表格欄位標題：Query Plan 指定的 label → 核准的欄位／指標描述 → 輸出名稱 */
export function columnLabel(s: ResolvedSelect, resolved: ResolvedQuery): string {
  if (s.label) return s.label;
  const ds = s.expr && resolved.datasets.find((d) => d.alias === s.expr!.alias)?.dataset;
  let field: string | undefined;
  if (s.expr?.kind === 'column') {
    const col = ds?.columns.find((c) => c.name === (s.expr as { column: string }).column);
    field = col?.descriptionStatus === 'approved' ? shortLabel(col.description) : undefined;
  } else if (s.expr?.kind === 'metric') {
    const key = s.expr.key;
    field = shortLabel(ds?.metrics.find((m) => m.key === key)?.description);
  }
  if (s.agg) return s.expr ? (field ? AGG_LABELS[s.agg](field) : s.output) : '筆數';
  return field ?? s.output;
}

/** 「限制」欄位／指標：只能放在聚合函式裡；遮罩後可直接顯示時 aggregate_only 為 false */
function restrictedHint(aggregateOnly: boolean) {
  return { aggregate_only: aggregateOnly, aggregates: RESTRICTED_AGGREGATES, min_group_size: RESTRICTED_MIN_GROUP_SIZE };
}

export function maskValue(v: unknown, mode: 'redact' | 'partial'): unknown {
  if (v === null || v === undefined) return v;
  if (mode === 'redact') return '***';
  const s = String(v);
  return s.length <= 2 ? '*'.repeat(s.length) : `${s[0]}${'*'.repeat(s.length - 2)}${s[s.length - 1]}`;
}

function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class DbIntelligenceService {
  private readonly limits: ServiceLimits;
  private readonly now: () => Date;
  private readonly results = new Map<string, CachedResult>();

  constructor(private readonly opts: ServiceOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.now = opts.now ?? (() => new Date());
  }

  private async principalOf(caller: HyAgentCaller): Promise<Principal> {
    if (caller.system || !caller.tenantId || !caller.userId) throw new DbiError('AUTH_REQUIRED');
    return this.opts.principals.resolve(caller);
  }

  private tenantSources(principal: Principal): DataSource[] {
    return this.opts.dataSources().filter((d) => d.tenantId === principal.tenantId);
  }

  private async catalogFor(ds: DataSource): Promise<Catalog | undefined> {
    const c = await this.opts.catalogs.load(ds.id);
    return c && c.tenantId === ds.tenantId ? c : undefined;
  }

  private summarize(v: VisibleDataset, catalog: Catalog, visible: VisibleDataset[], detailed: boolean) {
    const ds = v.dataset;
    const visibleIds = new Map(visible.map((x) => [x.dataset.id, x.dataset.key]));
    const relationships = catalog.relationships
      .filter((r) => r.approvalStatus === 'approved' && (r.from.dataset === ds.id || r.to.dataset === ds.id))
      .filter((r) => visibleIds.has(r.from.dataset) && visibleIds.has(r.to.dataset))
      .map((r) => {
        const other = r.from.dataset === ds.id ? r.to.dataset : r.from.dataset;
        return { relationship_id: r.id, dataset: visibleIds.get(other)! };
      });
    const notes: string[] = [];
    if (v.rowScoped) notes.push('資料列已依使用者權限限制範圍');
    if (v.aggregateOnly) notes.push('只允許統計（聚合）查詢');
    return {
      data_source_id: catalog.dataSourceId,
      dataset: ds.key,
      kind: ds.kind,
      description: ds.descriptionStatus === 'approved' ? ds.description : null,
      columns: v.columns.map((c) => {
        const restricted = c.sensitivity === 'restricted';
        return {
          name: c.name,
          type: c.typeCategory,
          description: c.descriptionStatus === 'approved' ? c.description : null,
          ...(c.synonyms.length ? { synonyms: c.synonyms } : {}),
          ...(v.masked.has(c.name) ? { masked: true } : {}),
          // 「限制」欄位的用法與查詢時的強制規則一致，讓模型第一次就用對（規則仍由 Validator 強制）
          ...(restricted ? restrictedHint(!v.masked.has(c.name)) : {}),
          ...(detailed ? { nullable: c.nullable, operators: v.masked.has(c.name) || restricted ? [] : OPERATORS[c.typeCategory] } : {}),
        };
      }),
      metrics: v.metrics.map((m) => ({
        name: m.key,
        type: 'numeric',
        description: m.description,
        ...(metricColumns(m.expression).some((c) => ds.columns.find((x) => x.name === c)?.sensitivity === 'restricted') ? restrictedHint(true) : {}),
      })),
      relationships,
      ...(detailed ? { primary_key: ds.primaryKey.filter((k) => v.columns.some((c) => c.name === k)) } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  async searchSchema(caller: HyAgentCaller, args: { question: string; data_source_id?: string; limit?: number }) {
    const principal = await this.principalOf(caller);
    const sources = this.tenantSources(principal).filter((d) => !args.data_source_id || d.id === args.data_source_id);
    if (args.data_source_id && sources.length === 0) throw new DbiError('QUERY_DATA_SOURCE_DENIED');
    const policies = this.opts.policies().policies;
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 20);
    const now = this.now();
    const datasets: ReturnType<DbIntelligenceService['summarize']>[] = [];
    let matched = false;
    const dataSources: { id: string; today: string; timezone: string; catalog_version: number }[] = [];
    for (const ds of sources) {
      const catalog = await this.catalogFor(ds);
      if (!catalog?.published) continue;
      const visible = visibleDatasets(catalog, policies, principal);
      if (visible.length === 0) continue;
      dataSources.push({ id: ds.id, today: todayIn(ds.timezone, now), timezone: ds.timezone, catalog_version: catalog.version });
      const r = searchDatasets(visible, args.question, limit);
      matched ||= r.matched;
      datasets.push(...r.results.map((v) => this.summarize(v, catalog, visible, false)));
    }
    return { matched, data_sources: dataSources, datasets: datasets.slice(0, limit) };
  }

  async getDatasetDetails(caller: HyAgentCaller, args: { data_source_id: string; dataset: string }) {
    const principal = await this.principalOf(caller);
    const ds = this.tenantSources(principal).find((d) => d.id === args.data_source_id);
    if (!ds) throw new DbiError('QUERY_DATA_SOURCE_DENIED');
    const catalog = await this.catalogFor(ds);
    if (!catalog?.published) throw new DbiError('CATALOG_NOT_PUBLISHED');
    const visible = visibleDatasets(catalog, this.opts.policies().policies, principal);
    const v = visible.find((x) => x.dataset.key === args.dataset);
    if (!v) throw new DbiError('QUERY_DATASET_NOT_FOUND', args.dataset);
    return this.summarize(v, catalog, visible, true);
  }

  private async audit(e: Omit<AuditEvent, 'created_at'>): Promise<void> {
    try {
      await this.opts.audit.write({ ...e, created_at: this.now().toISOString() });
    } catch (err) {
      // 稽核寫入失敗不影響回應，但要留下痕跡讓維運告警
      console.error('dbi_audit_write_failed', e.request_id, err instanceof Error ? err.message : err);
    }
  }

  async executeSafeQuery(caller: HyAgentCaller, args: { query_plan: unknown; request_id?: string }) {
    const started = Date.now();
    const requestId = `req_${randomUUID()}`;
    const policySet = this.opts.policies();
    const base = {
      request_id: requestId,
      client_request_id: args.request_id,
      tenant_id: caller.tenantId,
      principal_id: caller.userId,
      tool: 'execute_safe_query',
      plan_hash: planHash(args.query_plan),
      plan_summary: redactPlan(args.query_plan),
      policy_version: policySet.version,
    };
    let resolved: ResolvedQuery | undefined;
    let catalog: Catalog | undefined;
    try {
      const principal = await this.principalOf(caller);
      const dsId = (args.query_plan as { data_source_id?: unknown } | null)?.data_source_id;
      const ds = this.tenantSources(principal).find((d) => d.id === dsId);
      catalog = ds && (await this.catalogFor(ds));
      resolved = resolveQuery(args.query_plan, { catalog, dataSources: this.opts.dataSources(), policies: policySet.policies, principal });
      const compiled = compileQuery(resolved, dialectFor(ds!.dbType));
      const exec = await this.opts.executor.execute(resolved.dataSourceId, compiled, { timeoutMs: this.limits.timeoutMs, maxBytes: this.limits.maxBytes });

      const masks = resolved.select.map((s) => s.mask);
      const rows = exec.rows.map((r) => Object.fromEntries(exec.columns.map((c, i) => [c, masks[i] ? maskValue(r[i], masks[i]!) : r[i]])));
      const resultId = `res_${randomUUID()}`;
      const columnLabels = resolved.select.map((s) => columnLabel(s, resolved!));
      this.cacheResult(resultId, {
        tenantId: principal.tenantId,
        userId: principal.userId,
        policyVersion: policySet.version,
        catalogVersion: catalog!.version,
        dataSourceId: resolved.dataSourceId,
        expiresAt: Date.now() + this.limits.resultTtlMs,
        columns: exec.columns,
        columnLabels,
        rows,
      });

      const warnings: string[] = [];
      if (exec.truncatedBy === 'row_limit') warnings.push(`結果超過 ${resolved.limit} 筆，只回傳前 ${resolved.limit} 筆`);
      if (exec.truncatedBy === 'byte_limit') warnings.push(`結果過大，只回傳前 ${rows.length} 筆`);
      if (resolved.minGroupSize) warnings.push(`為保護個資，筆數少於 ${resolved.minGroupSize} 的統計結果不顯示`);
      const maskedCols = resolved.select.filter((s) => s.mask).map((s) => s.output);
      if (maskedCols.length) warnings.push(`欄位 ${maskedCols.join('、')} 已遮罩`);
      if (rows.length === 0) warnings.push('查無符合條件的資料');

      await this.audit({
        ...base,
        source_id: resolved.dataSourceId,
        catalog_version: catalog!.version,
        policy_ids: resolved.policyIds,
        datasets: resolved.datasets.map((d) => d.dataset.id),
        ...(resolved.sensitiveColumns.length ? { sensitive_columns: resolved.sensitiveColumns } : {}),
        status: 'success',
        row_count: rows.length,
        truncated: exec.truncated,
        duration_ms: Date.now() - started,
        db_time_ms: exec.dbTimeMs,
      });
      const page = this.page(resultId, rows, 0);
      return {
        request_id: requestId,
        result_id: resultId,
        columns: exec.columns,
        column_labels: columnLabels,
        ...page,
        row_count: rows.length,
        truncated: exec.truncated,
        warnings,
        basis: {
          data_source_id: resolved.dataSourceId,
          datasets: resolved.datasets.map((d) => d.dataset.key),
          filters: (args.query_plan as { filters?: unknown }).filters ?? [],
          row_scope_applied: resolved.datasets.some((d) => d.scope.length > 0),
          catalog_version: catalog!.version,
          policy_version: policySet.version,
        },
      };
    } catch (err) {
      const e = err instanceof DbiError ? err : new DbiError('QUERY_EXECUTION_FAILED');
      const status: AuditEvent['status'] =
        e.code === 'QUERY_POLICY_DENIED' || e.code === 'QUERY_DATA_SOURCE_DENIED' || e.code === 'AUTH_REQUIRED'
          ? 'denied'
          : e.code === 'QUERY_TIMEOUT' || e.code === 'QUERY_EXECUTION_FAILED'
            ? 'error'
            : 'invalid';
      await this.audit({
        ...base,
        source_id: resolved?.dataSourceId,
        catalog_version: catalog?.version,
        status,
        reason_code: e.code,
        ...(e.detail ? { reason_detail: e.detail.slice(0, 300) } : {}),
        duration_ms: Date.now() - started,
      });
      throw Object.assign(e, { requestId });
    }
  }

  private cacheResult(id: string, entry: CachedResult): void {
    const now = Date.now();
    for (const [k, v] of this.results) if (v.expiresAt <= now) this.results.delete(k);
    while (this.results.size >= this.limits.maxCachedResults) this.results.delete(this.results.keys().next().value!);
    this.results.set(id, entry);
  }

  private page(resultId: string, rows: Record<string, unknown>[], offset: number) {
    const end = offset + this.limits.pageSize;
    return { rows: rows.slice(offset, end), ...(end < rows.length ? { next_cursor: `${resultId}:${end}` } : {}) };
  }

  async getQueryResult(caller: HyAgentCaller, args: { result_id: string; cursor?: string }) {
    const principal = await this.principalOf(caller);
    const entry = this.results.get(args.result_id);
    const policyVersion = this.opts.policies().version;
    // 快取綁定 tenant／user／政策版本／Catalog 版本／TTL，任一不符都當作不存在
    const ds = entry && this.tenantSources(principal).find((d) => d.id === entry.dataSourceId);
    const catalog = ds && (await this.catalogFor(ds));
    if (
      !entry ||
      entry.expiresAt <= Date.now() ||
      entry.tenantId !== principal.tenantId ||
      entry.userId !== principal.userId ||
      entry.policyVersion !== policyVersion ||
      catalog?.version !== entry.catalogVersion
    ) {
      await this.audit({
        request_id: `req_${randomUUID()}`,
        tenant_id: principal.tenantId,
        principal_id: principal.userId,
        tool: 'get_query_result',
        policy_version: policyVersion,
        status: 'denied',
        reason_code: 'QUERY_RESULT_NOT_FOUND',
        duration_ms: 0,
      });
      throw new DbiError('QUERY_RESULT_NOT_FOUND');
    }
    let offset = 0;
    if (args.cursor) {
      const m = /^(.+):(\d+)$/.exec(args.cursor);
      if (!m || m[1] !== args.result_id || Number(m[2]) >= entry.rows.length) throw new DbiError('QUERY_PLAN_INVALID', 'cursor 不正確');
      offset = Number(m[2]);
    }
    return { result_id: args.result_id, columns: entry.columns, column_labels: entry.columnLabels, ...this.page(args.result_id, entry.rows, offset), row_count: entry.rows.length };
  }
}
