/**
 * 每個資料來源一個連線池，用到才建；資料來源設定變更或刪除時關掉舊池。
 * 連線字串只從環境變數讀（設定裡只有變數名稱），永遠不出現在回應、Log 或 Catalog。
 * DataSourceConnections 依資料來源的 dbType 分派到 PostgreSQL 或 MariaDB／MySQL 轉接。
 */
import type mysql from 'mysql2/promise';
import pg from 'pg';
import { createMysqlPool, discoverMysqlSchema, MysqlExecutor, testMysqlConnection, type MysqlFlavor } from './adapters/mysql';
import { discoverPostgresSchema } from './catalog/postgresDiscovery';
import { connectionString } from './config';
import type { DiscoveredSchema } from './contracts/catalog';
import type { DataSource } from './contracts/policy';
import type { CompiledQuery } from './query/compiler';
import { PostgresExecutor, type ExecutionLimits, type ExecutionResult, type QueryExecutor } from './query/executor';

export interface PoolRegistryOptions {
  env?: NodeJS.ProcessEnv;
  max?: number;
}

export class PoolRegistry {
  private readonly pools = new Map<string, { key: string; pool: pg.Pool }>();

  constructor(
    private readonly dataSources: () => DataSource[],
    private readonly opts: PoolRegistryOptions = {},
  ) {}

  /** 連線字串環境變數是否已設定（只回布林，不回值） */
  configured(ds: DataSource): boolean {
    return !!(this.opts.env ?? process.env)[ds.connectionEnv]?.trim();
  }

  /** 資料來源不存在、不是 PostgreSQL 或連線字串未設定時回 undefined */
  get(id: string): pg.Pool | undefined {
    const ds = this.dataSources().find((d) => d.id === id && d.dbType === 'postgres');
    if (!ds) {
      void this.close(id);
      return undefined;
    }
    if (!this.configured(ds)) return undefined;
    const env = this.opts.env ?? process.env;
    const key = `${ds.connectionEnv}|${ds.dbType}`;
    const cur = this.pools.get(id);
    if (cur?.key === key) return cur.pool;
    if (cur) void cur.pool.end().catch(() => undefined);
    const pool = new pg.Pool({
      connectionString: connectionString(env, ds.connectionEnv),
      max: this.opts.max ?? 5,
      application_name: 'hyagent-db-intelligence',
      // 連線層再鎖一次唯讀；DB 帳號本身也必須只有 SELECT 權限
      options: '-c default_transaction_read_only=on',
    });
    // 閒置連線斷線時 pg 會在 pool 上丟 error；不處理會讓程序崩潰
    pool.on('error', () => undefined);
    this.pools.set(id, { key, pool });
    return pool;
  }

  async close(id: string): Promise<void> {
    const cur = this.pools.get(id);
    this.pools.delete(id);
    await cur?.pool.end().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pools.keys()].map((id) => this.close(id)));
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  /** 連線預設唯讀（default_transaction_read_only） */
  defaultReadOnly?: boolean;
  /** 帳號在掃描範圍內仍有寫入權限的物件（應為空） */
  writableObjects?: string[];
  /** 其他需要注意的事（如資料庫類型設定與伺服器不符） */
  warnings?: string[];
  error?: string;
}

const WRITABLE_SQL = `
SELECT n.nspname || '.' || c.relname AS name
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm')
  AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
       OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
ORDER BY 1 LIMIT 50`;

/** 連線測試：只查版本與權限，不讀資料列；失敗只回分類後的原因，不回 DB 錯誤原文 */
export async function testConnection(pool: pg.Pool, ds: DataSource): Promise<ConnectionTestResult> {
  const started = Date.now();
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    const v = await client.query(`SELECT current_setting('server_version') AS v, current_setting('default_transaction_read_only') AS ro`);
    const w = await client.query(WRITABLE_SQL, [ds.schemas]);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: `PostgreSQL ${String(v.rows[0].v)}`,
      defaultReadOnly: v.rows[0].ro === 'on',
      writableObjects: w.rows.map((r) => String(r.name)),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const error =
      code === '28P01' || code === '28000' ? 'auth_failed' : code === '3D000' ? 'database_not_found' : code === 'ECONNREFUSED' || code === 'ENOTFOUND' ? 'unreachable' : 'connection_failed';
    return { ok: false, latencyMs: Date.now() - started, error };
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
}

/** MariaDB／MySQL 的連線池（與 PoolRegistry 同樣的生命週期規則） */
export class MysqlPoolRegistry {
  private readonly pools = new Map<string, { key: string; pool: mysql.Pool; flavor: MysqlFlavor }>();

  constructor(
    private readonly dataSources: () => DataSource[],
    private readonly opts: PoolRegistryOptions = {},
  ) {}

  get(id: string): { pool: mysql.Pool; flavor: MysqlFlavor } | undefined {
    const ds = this.dataSources().find((d) => d.id === id && d.dbType !== 'postgres');
    const env = this.opts.env ?? process.env;
    if (!ds || !env[ds.connectionEnv]?.trim()) {
      if (!ds) void this.close(id);
      return undefined;
    }
    const key = `${ds.connectionEnv}|${ds.dbType}`;
    const cur = this.pools.get(id);
    if (cur?.key === key) return cur;
    if (cur) void cur.pool.end().catch(() => undefined);
    const next = { key, pool: createMysqlPool(connectionString(env, ds.connectionEnv), this.opts.max ?? 5), flavor: ds.dbType as MysqlFlavor };
    this.pools.set(id, next);
    return next;
  }

  async close(id: string): Promise<void> {
    const cur = this.pools.get(id);
    this.pools.delete(id);
    await cur?.pool.end().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pools.keys()].map((id) => this.close(id)));
  }
}

/** 連線字串未設定 */
export class ConnectionNotConfiguredError extends Error {
  constructor(readonly connectionEnv: string) {
    super(`連線字串環境變數 ${connectionEnv} 未設定`);
    this.name = 'ConnectionNotConfiguredError';
  }
}

/**
 * 依資料來源的 dbType 分派：連線測試、Schema 掃描、查詢執行。管理 API 與查詢服務都透過它，不直接碰驅動程式。
 */
export class DataSourceConnections implements QueryExecutor {
  private readonly pg: PoolRegistry;
  private readonly my: MysqlPoolRegistry;
  private readonly pgExec: PostgresExecutor;
  private readonly myExec: MysqlExecutor;

  constructor(
    private readonly dataSources: () => DataSource[],
    private readonly opts: PoolRegistryOptions = {},
  ) {
    this.pg = new PoolRegistry(dataSources, opts);
    this.my = new MysqlPoolRegistry(dataSources, opts);
    this.pgExec = new PostgresExecutor(this.pg);
    this.myExec = new MysqlExecutor(this.my);
  }

  configured(ds: DataSource): boolean {
    return !!(this.opts.env ?? process.env)[ds.connectionEnv]?.trim();
  }

  private ensureConfigured(ds: DataSource): void {
    if (!this.configured(ds)) throw new ConnectionNotConfiguredError(ds.connectionEnv);
  }

  async testConnection(ds: DataSource): Promise<ConnectionTestResult> {
    this.ensureConfigured(ds);
    if (ds.dbType === 'postgres') return testConnection(this.pg.get(ds.id)!, ds);
    return testMysqlConnection(this.my.get(ds.id)!.pool, ds);
  }

  async discover(ds: DataSource): Promise<DiscoveredSchema> {
    this.ensureConfigured(ds);
    const opts = { schemas: ds.schemas, includeObjects: ds.includeObjects };
    if (ds.dbType !== 'postgres') {
      const entry = this.my.get(ds.id)!;
      return discoverMysqlSchema(entry.pool, entry.flavor, opts);
    }
    const client = await this.pg.get(ds.id)!.connect();
    try {
      return await discoverPostgresSchema(client, opts);
    } finally {
      client.release();
    }
  }

  execute(dataSourceId: string, q: CompiledQuery, limits: ExecutionLimits): Promise<ExecutionResult> {
    const ds = this.dataSources().find((d) => d.id === dataSourceId);
    return ds && ds.dbType !== 'postgres' ? this.myExec.execute(dataSourceId, q, limits) : this.pgExec.execute(dataSourceId, q, limits);
  }

  async close(id: string): Promise<void> {
    await Promise.all([this.pg.close(id), this.my.close(id)]);
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.pg.closeAll(), this.my.closeAll()]);
  }
}
