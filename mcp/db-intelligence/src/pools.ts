/**
 * 每個資料來源一個連線池，用到才建；資料來源設定變更或刪除時關掉舊池。
 * 連線字串只從環境變數讀（設定裡只有變數名稱），永遠不出現在回應、Log 或 Catalog。
 */
import pg from 'pg';
import { connectionString } from './config';
import type { DataSource } from './contracts/policy';

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

  /** 資料來源不存在或連線字串未設定時回 undefined */
  get(id: string): pg.Pool | undefined {
    const ds = this.dataSources().find((d) => d.id === id);
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
      serverVersion: String(v.rows[0].v),
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
