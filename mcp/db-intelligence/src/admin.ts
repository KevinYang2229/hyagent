/**
 * 管理 API（規格書 5.2）：資料來源、連線測試、Schema 掃描、Catalog 審核、存取政策、使用者目錄、查詢預覽、稽核。
 * 只接受 HyAgent 後端簽發、帶 `hyagent:admin` scope 的系統 JWT——由平台管理員在 HyAgent 後台操作、
 * HyAgent 後端驗證管理員並留稽核後代為呼叫。一般使用者 JWT 與列工具用的系統 JWT 都會被拒。
 * 回應格式與 HyAgent server 一致：成功 `{ data }`、失敗 `{ error: { code, message, details? } }`。
 */
import type { PoolClient } from 'pg';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { requireHyAgent, type HyAgentCaller, type HyAgentVerifier } from '@hyagent/mcp-kit';
import type { RingAuditSink } from './audit';
import { discoverPostgresSchema } from './catalog/postgresDiscovery';
import { applyCatalogReview, CatalogReviewError } from './catalog/review';
import type { CatalogStore } from './catalog/store';
import { syncCatalog } from './catalog/sync';
import { SENSITIVE_LEVELS, type Catalog, type Sensitivity } from './contracts/catalog';
import { DbiError } from './contracts/errors';
import { accessPolicySchema, dataSourceSchema, principalDirectorySchema, type AccessPolicy } from './contracts/policy';
import { testConnection, type PoolRegistry } from './pools';
import { compileQuery } from './query/compiler';
import { resolveQuery } from './query/validator';
import { directoryResolver } from './service';
import { DATA_SOURCE_ID_RE, StateError, type DbiState } from './state';

export const ADMIN_SCOPE = 'hyagent:admin';

export interface AdminRouterOptions {
  verifier: HyAgentVerifier;
  state: DbiState;
  catalogs: CatalogStore;
  pools: PoolRegistry;
  audit: RingAuditSink;
  /** 本服務在 HyAgent 登記的 serverId（scope 推導角色用，查詢預覽與正式查詢一致） */
  serverId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

function handle(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).then(
      (data) => {
        if (!res.headersSent) res.json({ data });
      },
      (err: unknown) => next(err),
    );
  };
}

function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  let e: HttpError;
  if (err instanceof HttpError) e = err;
  else if (err instanceof StateError) e = new HttpError({ NOT_FOUND: 404, CONFLICT: 409, BAD_REQUEST: 400 }[err.code], err.code, err.message);
  else if (err instanceof CatalogReviewError) e = new HttpError(400, 'CATALOG_REVIEW_INVALID', err.message);
  else if (err instanceof ZodError) e = new HttpError(422, 'VALIDATION_ERROR', 'Request validation failed', err.flatten());
  else if (err instanceof DbiError) e = new HttpError(400, err.code, err.message);
  else e = new HttpError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
}

function requireAdminCaller(verifier: HyAgentVerifier) {
  const verify = requireHyAgent(verifier);
  return (req: Request, res: Response, next: NextFunction) => {
    verify(req, res, () => {
      const caller = (req as Request & { auth?: { extra?: { caller?: HyAgentCaller } } }).auth?.extra?.caller;
      if (!caller?.system || !caller.scopes.includes(ADMIN_SCOPE)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: '需要 HyAgent 管理身分' } });
        return;
      }
      next();
    });
  };
}

function catalogSummary(c: Catalog | undefined) {
  if (!c) return null;
  const columns = c.datasets.flatMap((d) => d.columns);
  return {
    version: c.version,
    schemaVersion: c.schemaVersion,
    published: c.published,
    updatedAt: c.updatedAt,
    datasets: c.datasets.length,
    approvedDatasets: c.datasets.filter((d) => d.approvalStatus === 'approved').length,
    queryableColumns: columns.filter((x) => x.isQueryable).length,
    /** 新掃到或型別變更、尚未審核的欄位 */
    unreviewedColumns: columns.filter((x) => x.reviewStatus !== 'reviewed').length,
  };
}

/** 政策引用的資料集／欄位不在 Catalog 裡時給警告（不擋：Catalog 可能尚未掃描） */
async function policyWarnings(policies: AccessPolicy[], catalogs: CatalogStore): Promise<string[]> {
  const warnings: string[] = [];
  const cache = new Map<string, Catalog | undefined>();
  for (const p of policies) {
    if (!cache.has(p.dataSourceId)) cache.set(p.dataSourceId, await catalogs.load(p.dataSourceId));
    const ds = cache.get(p.dataSourceId)?.datasets.find((d) => d.id === p.dataset);
    if (!ds) {
      warnings.push(`政策 ${p.id}：Catalog 中沒有資料集 ${p.dataset}`);
      continue;
    }
    const names = new Set(ds.columns.map((c) => c.name));
    for (const c of [...p.columns, ...Object.keys(p.masked), ...p.rowScope.map((r) => r.column)]) {
      if (c !== '*' && !names.has(c)) warnings.push(`政策 ${p.id}：${p.dataset} 沒有欄位 ${c}`);
    }
  }
  return warnings;
}

export interface SensitiveExposure {
  policyId: string;
  dataset: string;
  column: string;
  sensitivity: Sensitivity;
}

/** 政策明確開放的機密／限制欄位（'*' 本來就不涵蓋它們，只看逐欄列出的） */
async function sensitiveExposures(policies: AccessPolicy[], catalogs: CatalogStore): Promise<SensitiveExposure[]> {
  const out: SensitiveExposure[] = [];
  const cache = new Map<string, Catalog | undefined>();
  for (const p of policies) {
    if (!cache.has(p.dataSourceId)) cache.set(p.dataSourceId, await catalogs.load(p.dataSourceId));
    const ds = cache.get(p.dataSourceId)?.datasets.find((d) => d.id === p.dataset);
    for (const col of ds?.columns ?? []) {
      if (p.columns.includes(col.name) && SENSITIVE_LEVELS.has(col.sensitivity)) {
        out.push({ policyId: p.id, dataset: p.dataset, column: col.name, sensitivity: col.sensitivity });
      }
    }
  }
  return out;
}

const exposureKey = (e: SensitiveExposure) => `${e.policyId}|${e.dataset}|${e.column}|${e.sensitivity}`;

const idParam = z.object({ id: z.string().regex(DATA_SOURCE_ID_RE) });
const tenantParam = z.object({ tenantId: z.string().min(1).max(64) });
const dataSourceBody = dataSourceSchema.omit({ id: true });
const previewBody = z
  .object({
    tenant_id: z.string().min(1),
    user_id: z.string().min(1),
    /** 模擬 JWT 會帶的 scope（如 mcp:db-intelligence:manager） */
    scopes: z.array(z.string()).default([]),
    query_plan: z.unknown(),
  })
  .strict();
const auditQuery = z.object({
  request_id: z.string().optional(),
  tenant_id: z.string().optional(),
  status: z.enum(['success', 'denied', 'invalid', 'error']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function createAdminRouter(opts: AdminRouterOptions): Router {
  const { state, catalogs, pools } = opts;
  const r = Router();
  r.use(requireAdminCaller(opts.verifier));

  const dataSourceOr404 = (id: string) => {
    const ds = state.dataSources().find((d) => d.id === id);
    if (!ds) throw new HttpError(404, 'NOT_FOUND', `資料來源不存在：${id}`);
    return ds;
  };
  const poolOr400 = (id: string) => {
    const ds = dataSourceOr404(id);
    const pool = pools.get(id);
    if (!pool) throw new HttpError(400, 'CONNECTION_NOT_CONFIGURED', `連線字串環境變數 ${ds.connectionEnv} 未設定`);
    return { ds, pool };
  };

  r.get(
    '/data-sources',
    handle(async (req) => {
      const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : undefined;
      const list = state.dataSources().filter((d) => !tenantId || d.tenantId === tenantId);
      return Promise.all(
        list.map(async (d) => ({
          ...d,
          connectionConfigured: pools.configured(d),
          catalog: catalogSummary(await catalogs.load(d.id)),
        })),
      );
    }),
  );

  r.put(
    '/data-sources/:id',
    handle(async (req) => {
      const { id } = idParam.parse(req.params);
      const body = dataSourceBody.parse(req.body);
      const existing = await catalogs.load(id);
      if (existing && existing.tenantId !== body.tenantId) throw new HttpError(409, 'CONFLICT', '此 ID 已有其他租戶的 Catalog，請換一個 ID');
      const ds = state.upsertDataSource({ ...body, id });
      await pools.close(id);
      return ds;
    }),
  );

  r.delete(
    '/data-sources/:id',
    handle(async (req) => {
      const { id } = idParam.parse(req.params);
      state.removeDataSource(id);
      await pools.close(id);
      return { id, deleted: true };
    }),
  );

  r.post(
    '/data-sources/:id/connection-test',
    handle(async (req) => {
      const { ds, pool } = poolOr400(idParam.parse(req.params).id);
      return testConnection(pool, ds);
    }),
  );

  r.post(
    '/data-sources/:id/schema-sync',
    handle(async (req) => {
      const { ds, pool } = poolOr400(idParam.parse(req.params).id);
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch {
        throw new HttpError(502, 'CONNECTION_FAILED', '無法連線到資料庫，請先執行連線測試');
      }
      try {
        const discovered = await discoverPostgresSchema(client, { schemas: ds.schemas, includeObjects: ds.includeObjects });
        const { catalog, diff } = syncCatalog(await catalogs.load(ds.id), discovered, { dataSourceId: ds.id, tenantId: ds.tenantId });
        if (diff.changed) await catalogs.save(catalog);
        return { diff, catalog: catalogSummary(catalog) };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, 'SCHEMA_SYNC_FAILED', 'Schema 掃描失敗');
      } finally {
        client.release();
      }
    }),
  );

  r.get(
    '/data-sources/:id/catalog',
    handle(async (req) => {
      const { id } = idParam.parse(req.params);
      dataSourceOr404(id);
      const c = await catalogs.load(id);
      if (!c) throw new HttpError(404, 'NOT_FOUND', '尚未掃描此資料來源');
      return c;
    }),
  );

  r.patch(
    '/data-sources/:id/catalog',
    handle(async (req) => {
      const { id } = idParam.parse(req.params);
      dataSourceOr404(id);
      const c = await catalogs.load(id);
      if (!c) throw new HttpError(404, 'NOT_FOUND', '尚未掃描此資料來源');
      const next = applyCatalogReview(c, req.body);
      await catalogs.save(next);
      return next;
    }),
  );

  r.get(
    '/tenants/:tenantId/policies',
    handle(async (req) => state.tenantPolicies(tenantParam.parse(req.params).tenantId)),
  );

  r.put(
    '/tenants/:tenantId/policies',
    handle(async (req) => {
      const { tenantId } = tenantParam.parse(req.params);
      const { policies, confirmSensitiveColumns } = z
        .object({ policies: z.array(accessPolicySchema), confirmSensitiveColumns: z.boolean().optional() })
        .strict()
        .parse(req.body);
      const dryRun = req.query.dry_run === '1';
      // 只有「新開放」的機密／限制欄位需要確認，未變動的既有授權不重複詢問
      const before = new Set((await sensitiveExposures(state.tenantPolicies(tenantId).policies, catalogs)).map(exposureKey));
      const sensitive = (await sensitiveExposures(policies, catalogs)).filter((e) => !before.has(exposureKey(e)));
      if (!dryRun && sensitive.length > 0 && !confirmSensitiveColumns) {
        throw new HttpError(409, 'SENSITIVE_COLUMNS_UNCONFIRMED', '政策新開放了機密或限制欄位，請確認後再儲存', { sensitive });
      }
      const saved = state.setTenantPolicies(tenantId, policies, { dryRun });
      return { ...saved, saved: !dryRun, sensitive, warnings: await policyWarnings(saved.policies, catalogs) };
    }),
  );

  r.get(
    '/tenants/:tenantId/principals',
    handle(async (req) => state.tenantPrincipals(tenantParam.parse(req.params).tenantId)),
  );

  r.put(
    '/tenants/:tenantId/principals',
    handle(async (req) => {
      const { tenantId } = tenantParam.parse(req.params);
      const dir = principalDirectorySchema.parse({ [tenantId]: req.body })[tenantId];
      return state.setTenantPrincipals(tenantId, dir);
    }),
  );

  // 查詢預覽：以指定使用者的身分跑 Validator／Policy／Compiler，不執行
  r.post(
    '/query/preview',
    handle(async (req) => {
      const body = previewBody.parse(req.body);
      const principal = await directoryResolver(() => state.principals(), { serverId: opts.serverId }).resolve({
        tenantId: body.tenant_id,
        userId: body.user_id,
        scopes: body.scopes,
        jti: 'preview',
        system: false,
      });
      const dsId = (body.query_plan as { data_source_id?: unknown } | null)?.data_source_id;
      const ds = state.dataSources().find((d) => d.id === dsId && d.tenantId === principal.tenantId);
      const catalog = ds ? await catalogs.load(ds.id) : undefined;
      const resolved = resolveQuery(body.query_plan, { catalog, dataSources: state.dataSources(), policies: state.policies().policies, principal });
      const compiled = compileQuery(resolved);
      return {
        principal: { roles: principal.roles, attributes: principal.attributes },
        sql: compiled.sql,
        params: compiled.params,
        limit: compiled.limit,
        policy_ids: resolved.policyIds,
        row_scope: resolved.datasets.filter((d) => d.scope.length).map((d) => ({ dataset: d.dataset.key, conditions: d.scope })),
        masked: resolved.select.filter((s) => s.mask).map((s) => ({ output: s.output, mode: s.mask })),
        min_group_size: resolved.minGroupSize ?? null,
      };
    }),
  );

  r.get(
    '/audit',
    handle(async (req) => {
      const q = auditQuery.parse(req.query);
      return opts.audit.query({ requestId: q.request_id, tenantId: q.tenant_id, status: q.status, limit: q.limit });
    }),
  );

  r.use(errorMiddleware);
  return r;
}
