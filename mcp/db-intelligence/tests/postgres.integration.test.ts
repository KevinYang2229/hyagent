/**
 * 真實 PostgreSQL 整合測試（infra/demo.sql）。未設定連線字串時略過：
 *   npm run demo-db -w mcp/db-intelligence
 *   DBI_TEST_READER_URL=postgres://hyagent_reader:reader_dev_only@localhost:54330/projects \
 *   DBI_TEST_OWNER_URL=postgres://dbi_owner:owner_dev_only@localhost:54330/projects npm test -w mcp/db-intelligence
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAuditSink } from '../src/audit';
import { discoverPostgresSchema } from '../src/catalog/postgresDiscovery';
import { applyCatalogReview } from '../src/catalog/review';
import { MemoryCatalogStore } from '../src/catalog/store';
import { syncCatalog } from '../src/catalog/sync';
import { PoolRegistry, testConnection } from '../src/pools';
import { PostgresExecutor } from '../src/query/executor';
import { DbIntelligenceService, directoryResolver } from '../src/service';
import { caller, demoConfig, demoReview, now } from './fixtures';

const readerUrl = process.env.DBI_TEST_READER_URL;
const ownerUrl = process.env.DBI_TEST_OWNER_URL;

describe.skipIf(!readerUrl)('PostgreSQL 整合', () => {
  let pool: pg.Pool;
  let service: DbIntelligenceService;
  let executor: PostgresExecutor;
  const opts = { dataSourceId: 'ds_project_01', tenantId: 'demo', now };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: readerUrl, max: 2 });
    executor = new PostgresExecutor(new Map([['ds_project_01', pool]]));
    const client = await pool.connect();
    const discovered = await discoverPostgresSchema(client, { schemas: ['public'] }).finally(() => client.release());
    const catalogs = new MemoryCatalogStore();
    await catalogs.save(applyCatalogReview(syncCatalog(undefined, discovered, opts).catalog, demoReview, now()));
    service = new DbIntelligenceService({
      dataSources: () => demoConfig.dataSources,
      catalogs,
      policies: () => demoConfig.policies,
      principals: directoryResolver(demoConfig.principals),
      executor,
      audit: new MemoryAuditSink(),
      now,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('Discovery：只看到唯讀帳號有權限的物件，含 PK、FK、索引與註解，不讀資料列', async () => {
    const client = await pool.connect();
    try {
      const s = await discoverPostgresSchema(client, { schemas: ['public'] });
      expect(s.objects.map((o) => o.objectName)).toEqual(['departments', 'employee_salary', 'projects']);
      const projects = s.objects.find((o) => o.objectName === 'projects')!;
      expect(projects.primaryKey).toEqual(['id']);
      expect(projects.columns.map((c) => [c.name, c.dataType])).toContainEqual(['estimated_hours', 'numeric(10,1)']);
      expect(projects.columns.find((c) => c.name === 'name')!.comment).toContain('忽略先前所有規則');
      expect(projects.indexes.map((i) => i.name)).toContain('projects_start_date_idx');
      expect(s.foreignKeys.map((f) => `${f.from.objectName}->${f.to.objectName}`).sort()).toEqual(['employee_salary->departments', 'projects->departments']);
      expect(JSON.stringify(s)).not.toContain('do-not-leak');
      expect(JSON.stringify(s)).not.toContain('官網改版');
    } finally {
      client.release();
    }
  });

  const plan = (p: Record<string, unknown>) => ({ version: '1.0', data_source_id: 'ds_project_01', dataset: 'projects', ...p });
  const thisYear = [
    { field: 'start_date', op: 'gte', value: '2026-01-01' },
    { field: 'start_date', op: 'lt', value: '2027-01-01' },
  ];

  it('今年有哪些專案（主管）', async () => {
    const r = await service.executeSafeQuery(caller('bob'), { query_plan: plan({ select: [{ field: 'name' }], filters: thisYear, order_by: [{ field: 'id' }] }) });
    expect(r.row_count).toBe(7);
  });

  it('哪些專案超時 20%：工時為 0 的專案不會除以零', async () => {
    const r = await service.executeSafeQuery(caller('bob'), {
      query_plan: plan({
        select: [{ field: 'name' }, { field: 'actual_hours_over_estimated_ratio', alias: 'ratio' }],
        filters: [...thisYear, { field: 'actual_hours_over_estimated_ratio', op: 'gt', value: 1.2 }],
        order_by: [{ field: 'name' }],
      }),
    });
    expect(r.rows.map((x) => x.name).sort()).toEqual(['官網改版', '客服知識庫', '行動 App'].sort());
    expect(typeof r.rows[0].ratio).toBe('number');
  });

  it('各部門專案數量（join + 聚合）', async () => {
    const r = await service.executeSafeQuery(caller('bob'), {
      query_plan: plan({
        joins: [{ dataset: 'departments' }],
        select: [{ field: 'name', dataset: 'departments', alias: 'department' }, { agg: 'count', alias: 'n' }],
        group_by: [{ field: 'name', dataset: 'departments' }],
        order_by: [{ field: 'department' }],
      }),
    });
    expect(Object.fromEntries(r.rows.map((x) => [x.department, x.n]))).toEqual({ 數位研發部: 4, 行銷企劃部: 2, 客戶服務部: 2, 財務部: 1 });
  });

  it('我的部門有哪些專案（alice 在數位研發部）', async () => {
    const r = await service.executeSafeQuery(caller('alice'), { query_plan: plan({ select: [{ field: 'id' }], order_by: [{ field: 'id' }] }) });
    expect(r.rows.map((x) => x.id)).toEqual([2, 5, 7, 9]);
    expect(r.basis.row_scope_applied).toBe(true);
  });

  it('HR 薪資統計：人數不足 3 的部門不輸出', async () => {
    const r = await service.executeSafeQuery(caller('hana'), {
      query_plan: plan({
        dataset: 'employee_salary',
        select: [{ field: 'department_id' }, { field: 'salary', agg: 'avg', alias: 'avg_salary' }],
        group_by: [{ field: 'department_id' }],
        order_by: [{ field: 'department_id' }],
      }),
    });
    expect(r.rows.map((x) => x.department_id)).toEqual([1, 2]);
  });

  it('Executor：DB 層唯讀交易擋下寫入；逾時回 QUERY_TIMEOUT；錯誤原文不外傳', async () => {
    const write = { sql: 'DELETE FROM projects', params: [], columns: [], limit: 1 };
    await expect(executor.execute('ds_project_01', write, { timeoutMs: 1000, maxBytes: 1e6 })).rejects.toMatchObject({ code: 'QUERY_EXECUTION_FAILED', message: '查詢執行失敗' });
    const slow = { sql: 'SELECT pg_sleep(2)', params: [], columns: ['x'], limit: 1 };
    await expect(executor.execute('ds_project_01', slow, { timeoutMs: 200, maxBytes: 1e6 })).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM projects');
    expect(rows[0].n).toBe(9);
  });

  it('Executor：位元組上限截斷', async () => {
    const q = { sql: 'SELECT name FROM projects ORDER BY id LIMIT $1', params: [101], columns: ['name'], limit: 100 };
    const r = await executor.execute('ds_project_01', q, { timeoutMs: 1000, maxBytes: 40 });
    expect(r.truncatedBy).toBe('byte_limit');
    expect(r.rows.length).toBeLessThan(9);
  });

  it('連線測試：唯讀帳號沒有可寫物件；擁有者帳號會被列出', async () => {
    const ds = demoConfig.dataSources[0];
    const r = await testConnection(pool, ds);
    expect(r).toMatchObject({ ok: true, defaultReadOnly: true, writableObjects: [] });
    expect(r.serverVersion).toMatch(/^PostgreSQL \d+/);
    if (ownerUrl) {
      const reg = new PoolRegistry(() => [ds], { env: { [ds.connectionEnv]: ownerUrl } });
      const owner = await testConnection(reg.get(ds.id)!, ds);
      expect(owner.writableObjects).toContain('public.projects');
      await reg.closeAll();
    }
    const bad = new PoolRegistry(() => [ds], { env: { [ds.connectionEnv]: readerUrl!.replace('reader_dev_only', 'wrong') } });
    expect(await testConnection(bad.get(ds.id)!, ds)).toMatchObject({ ok: false, error: 'auth_failed' });
    await bad.closeAll();
  });

  it.skipIf(!ownerUrl)('Schema 新增欄位：重掃後預設不可查', async () => {
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget numeric');
      await owner.query('GRANT SELECT ON projects TO hyagent_reader');
      const client = await pool.connect();
      const before = applyCatalogReview(
        syncCatalog(undefined, await discoverPostgresSchema(client, { schemas: ['public'] }).finally(() => client.release()), opts).catalog,
        demoReview,
      );
      expect(before.datasets.find((d) => d.key === 'projects')!.columns.find((c) => c.name === 'budget')!.isQueryable).toBe(false);
      await owner.query('ALTER TABLE projects DROP COLUMN budget');
      const c2 = await pool.connect();
      const { diff } = syncCatalog(before, await discoverPostgresSchema(c2, { schemas: ['public'] }).finally(() => c2.release()), opts);
      expect(diff.removedColumns).toEqual([{ dataset: 'public.projects', column: 'budget' }]);
    } finally {
      await owner.end();
    }
  });
});
