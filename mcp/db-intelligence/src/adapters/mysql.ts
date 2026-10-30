/**
 * MariaDB／MySQL 轉接：Schema 掃描（information_schema）、查詢執行、連線測試。
 *
 * - 掃描只查 information_schema，不讀資料列；information_schema 本身只列出帳號有權限的物件與欄位。
 * - 執行在唯讀交易內（START TRANSACTION READ ONLY），逾時：MariaDB 用 max_statement_time（秒），
 *   MySQL 用 max_execution_time（毫秒，只作用於 SELECT）。
 * - 沒有 PostgreSQL 的 RLS：資料列範圍只由本服務的政策控管，建議客戶以 View 限縮來源。
 * - SHOW GRANTS 的原文在 MariaDB 會帶密碼雜湊，只解析權限與對象，原文一律不回傳。
 */
import mysql from 'mysql2/promise';
import { buildDiscoveredSchema } from '../catalog/postgresDiscovery';
import type { DbType, DiscoveredSchema } from '../contracts/catalog';
import { DbiError } from '../contracts/errors';
import type { DataSource } from '../contracts/policy';
import type { CompiledQuery } from '../query/compiler';
import { capResult, type ExecutionLimits, type ExecutionResult } from '../query/executor';
import type { ConnectionTestResult } from '../pools';

export type MysqlFlavor = Exclude<DbType, 'postgres'>;
type Row = Record<string, unknown>;
type Conn = mysql.PoolConnection;

/** mariadb:// 視同 mysql://（驅動程式只認 mysql） */
export function normalizeMysqlUrl(url: string): string {
  return url.replace(/^mariadb:\/\//i, 'mysql://');
}

/** DECIMAL 在安全範圍內轉 number；日期一律字串（dateStrings），避免時區位移 */
const typeCast: mysql.TypeCast = (field, next) => {
  if (field.type === 'NEWDECIMAL' || field.type === 'DECIMAL') {
    const v = field.string();
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : v;
  }
  return next();
};

export function createMysqlPool(url: string, max: number): mysql.Pool {
  return mysql.createPool({
    uri: normalizeMysqlUrl(url),
    connectionLimit: max,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    connectTimeout: 10_000,
    typeCast,
  });
}

async function setTimeoutFor(conn: Conn, flavor: MysqlFlavor, timeoutMs: number): Promise<void> {
  const ms = Math.max(1, Math.trunc(timeoutMs));
  if (flavor === 'mariadb') await conn.query(`SET SESSION max_statement_time = ${ms / 1000}`);
  else await conn.query(`SET SESSION max_execution_time = ${ms}`);
}

/** 1969＝MariaDB ER_STATEMENT_TIMEOUT；3024＝MySQL ER_QUERY_TIMEOUT */
const TIMEOUT_ERRNOS = new Set([1969, 3024]);

async function inReadOnly<T>(pool: mysql.Pool, flavor: MysqlFlavor, timeoutMs: number, fn: (c: Conn) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await setTimeoutFor(conn, flavor, timeoutMs);
    await conn.query('START TRANSACTION READ ONLY');
    return await fn(conn);
  } finally {
    await conn.query('ROLLBACK').catch(() => undefined);
    conn.release();
  }
}

const KIND_CODES: Record<string, string> = { 'BASE TABLE': 'r', 'SYSTEM VERSIONED': 'r', VIEW: 'v' };

export interface MysqlDiscoveryOptions {
  schemas: string[];
  includeObjects?: string[];
  statementTimeoutMs?: number;
}

export async function discoverMysqlSchema(pool: mysql.Pool, flavor: MysqlFlavor, opts: MysqlDiscoveryOptions): Promise<DiscoveredSchema> {
  const schemas = [...new Set(opts.schemas)].sort();
  const marks = schemas.map(() => '?').join(', ');
  return inReadOnly(pool, flavor, opts.statementTimeoutMs ?? 15_000, async (conn) => {
    const q = async (sql: string) => (await conn.query(sql, schemas))[0] as Row[];
    const tables = await q(
      `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, TABLE_TYPE AS table_type, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${marks}) ORDER BY 1, 2`,
    );
    const columns = await q(
      `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, COLUMN_NAME AS name, COLUMN_TYPE AS data_type,
              IS_NULLABLE AS is_nullable, ORDINAL_POSITION AS ordinal, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${marks}) ORDER BY 1, 2, ORDINAL_POSITION`,
    );
    // 只查 KEY_COLUMN_USAGE：MariaDB 對只有 SELECT 權限的帳號，TABLE_CONSTRAINTS 一律回空
    // 主鍵的約束名稱固定是 PRIMARY；有 REFERENCED_TABLE_NAME 的是外鍵；其餘（唯一鍵）不需要
    const keys = await q(
      `SELECT CONSTRAINT_NAME AS name, TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, COLUMN_NAME AS column_name,
              REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_object, REFERENCED_COLUMN_NAME AS ref_column
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA IN (${marks}) AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)
       ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    );
    const stats = await q(
      `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${marks}) ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    );
    return buildDiscoveredSchema(
      schemas,
      opts.includeObjects ? new Set(opts.includeObjects) : null,
      tables.map((r) => {
        const relkind = KIND_CODES[String(r.table_type)] ?? 'x';
        const comment = String(r.comment ?? '');
        // MySQL 會把檢視表的註解填成 'VIEW'
        return { ...r, relkind, comment: comment && !(relkind === 'v' && comment === 'VIEW') ? comment : null };
      }),
      columns.map((r) => ({ ...r, nullable: r.is_nullable === 'YES', comment: r.comment ? String(r.comment) : null })),
      groupConstraints(keys),
      groupIndexes(stats),
      flavor,
    );
  });
}

function groupConstraints(rows: Row[]): Row[] {
  const out = new Map<string, Row & { columns: string[]; ref_columns: string[] }>();
  for (const r of rows) {
    const key = `${r.schema_name}.${r.object_name}.${r.name}`;
    let c = out.get(key);
    if (!c) {
      c = { name: r.name, type: r.name === 'PRIMARY' ? 'p' : 'f', schema_name: r.schema_name, object_name: r.object_name, ref_schema: r.ref_schema, ref_object: r.ref_object, columns: [], ref_columns: [] };
      out.set(key, c);
    }
    c.columns.push(String(r.column_name));
    if (r.ref_column) c.ref_columns.push(String(r.ref_column));
  }
  return [...out.values()];
}

function groupIndexes(rows: Row[]): Row[] {
  const out = new Map<string, Row & { columns: string[] }>();
  for (const r of rows) {
    const key = `${r.schema_name}.${r.object_name}.${r.name}`;
    let i = out.get(key);
    if (!i) {
      i = { schema_name: r.schema_name, object_name: r.object_name, name: r.name, unique: Number(r.non_unique) === 0, columns: [] };
      out.set(key, i);
    }
    i.columns.push(String(r.column_name));
  }
  return [...out.values()];
}

export class MysqlExecutor {
  constructor(private readonly pools: { get(id: string): { pool: mysql.Pool; flavor: MysqlFlavor } | undefined }) {}

  async execute(dataSourceId: string, q: CompiledQuery, limits: ExecutionLimits): Promise<ExecutionResult> {
    const entry = this.pools.get(dataSourceId);
    if (!entry) throw new DbiError('QUERY_DATA_SOURCE_DENIED');
    const started = Date.now();
    let rows: unknown[][];
    try {
      rows = await inReadOnly(entry.pool, entry.flavor, limits.timeoutMs, async (conn) => {
        // execute＝伺服器端 prepared statement，值不經字串拼接
        const [r] = await conn.execute({ sql: q.sql, values: q.params as never[], rowsAsArray: true });
        return r as unknown[][];
      });
    } catch (err) {
      if (TIMEOUT_ERRNOS.has((err as { errno?: number }).errno ?? 0)) throw new DbiError('QUERY_TIMEOUT');
      throw new DbiError('QUERY_EXECUTION_FAILED');
    }
    return capResult(q, rows, limits.maxBytes, Date.now() - started);
  }
}

/** 唯讀帳號可以有的權限；其他權限（含 ALL PRIVILEGES）一律列為風險 */
const READ_ONLY_PRIVILEGES = new Set(['SELECT', 'USAGE', 'SHOW VIEW', 'SHOW DATABASES']);

/**
 * 解析 SHOW GRANTS，列出「範圍內仍可寫入或管理」的授權（對象：權限）。
 * 只回傳解析結果，不回傳原文（MariaDB 的原文含密碼雜湊）。
 */
export function riskyGrants(grantLines: string[], schemas: string[]): { risky: string[]; roles: boolean } {
  const inScope = new Set(schemas.map((s) => s.toLowerCase()));
  const risky: string[] = [];
  let roles = false;
  for (const line of grantLines) {
    const m = /^GRANT\s+(.+?)\s+ON\s+(?:(?:TABLE|PROCEDURE|FUNCTION)\s+)?(\S+)\s+TO\s/i.exec(line);
    if (!m) {
      if (/^GRANT\s/i.test(line)) roles = true;
      continue;
    }
    const target = m[2].replace(/`/g, '');
    const db = target.split('.')[0];
    if (db !== '*' && !inScope.has(db.toLowerCase())) continue;
    // 去掉欄位層級的括號（SELECT (a, b)）再拆權限
    const privileges = m[1]
      .replace(/\([^)]*\)/g, '')
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);
    const bad = privileges.filter((p) => !READ_ONLY_PRIVILEGES.has(p));
    if (/WITH\s+GRANT\s+OPTION/i.test(line)) bad.push('GRANT OPTION');
    if (bad.length) risky.push(`${target}：${[...new Set(bad)].join(', ')}`);
  }
  return { risky, roles };
}

export async function testMysqlConnection(pool: mysql.Pool, ds: DataSource): Promise<ConnectionTestResult> {
  const started = Date.now();
  const flavor = ds.dbType as MysqlFlavor;
  let conn: Conn | undefined;
  try {
    conn = await pool.getConnection();
    const [[v]] = (await conn.query('SELECT VERSION() AS v')) as unknown as [Row[]];
    const [grants] = (await conn.query('SHOW GRANTS')) as unknown as [Row[]];
    const version = String(v.v);
    const isMaria = /mariadb/i.test(version);
    const { risky, roles } = riskyGrants(grants.map((g) => String(Object.values(g)[0])), ds.schemas);
    const warnings: string[] = [];
    if (flavor === 'mariadb' && !isMaria) warnings.push('資料來源設定為 MariaDB，但伺服器是 MySQL，請修正資料庫類型');
    if (flavor === 'mysql' && isMaria) warnings.push('資料來源設定為 MySQL，但伺服器是 MariaDB，請修正資料庫類型');
    if (roles) warnings.push('此帳號被授予了角色，角色內的權限無法在此檢查，請另行確認為唯讀');
    return {
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: isMaria ? `MariaDB ${version.replace(/-MariaDB.*$/i, '')}` : `MySQL ${version}`,
      writableObjects: risky,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    const e = err as { errno?: number; code?: string };
    const error =
      e.errno === 1045 || e.errno === 1044 ? 'auth_failed' : e.errno === 1049 ? 'database_not_found' : ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(e.code ?? '') ? 'unreachable' : 'connection_failed';
    return { ok: false, latencyMs: Date.now() - started, error };
  } finally {
    conn?.release();
  }
}
