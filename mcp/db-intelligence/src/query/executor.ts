/**
 * Query Executor（規格書 7.1）：唯讀交易 + statement_timeout + 筆數／位元組上限。DB 錯誤原文不外傳。
 * 介面讓之後換成 Customer-side Connector 的遠端呼叫；目前為同程序直連（Connector 與 MCP server 同部署於客戶端）。
 */
import pg from 'pg';
import { DbiError } from '../contracts/errors';
import type { CompiledQuery } from './compiler';

export interface ExecutionLimits {
  timeoutMs: number;
  /** 結果 JSON 序列化後的位元組上限 */
  maxBytes: number;
}

export interface ExecutionResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  /** 截斷原因：row_limit＝超過筆數上限、byte_limit＝超過大小上限 */
  truncatedBy?: 'row_limit' | 'byte_limit';
  dbTimeMs: number;
}

export interface QueryExecutor {
  execute(dataSourceId: string, q: CompiledQuery, limits: ExecutionLimits): Promise<ExecutionResult>;
}

const INT8 = 20;
const NUMERIC = 1700;
const DATE_TYPES = new Set([1082, 1083, 1114, 1184, 1266]);

/** 日期／時間維持字串（避免時區位移）；bigint、numeric 在安全範圍內轉 number */
export const resultTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (DATE_TYPES.has(oid)) return (v: string) => v;
    if (oid === INT8 || oid === NUMERIC) {
      return (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER && (oid === NUMERIC || Number.isSafeInteger(n)) ? n : v;
      };
    }
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

export class PostgresExecutor implements QueryExecutor {
  constructor(private readonly pools: Map<string, pg.Pool> | { get(id: string): pg.Pool | undefined }) {}

  async execute(dataSourceId: string, q: CompiledQuery, limits: ExecutionLimits): Promise<ExecutionResult> {
    const pool = this.pools.get(dataSourceId);
    if (!pool) throw new DbiError('QUERY_DATA_SOURCE_DENIED');
    const client = await pool.connect();
    const started = Date.now();
    let rows: unknown[][];
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(limits.timeoutMs))}`);
      const res = await client.query({ text: q.sql, values: q.params, rowMode: 'array', types: resultTypes });
      rows = res.rows as unknown[][];
    } catch (err) {
      // 57014 = query_canceled（statement_timeout）
      if ((err as { code?: string }).code === '57014') throw new DbiError('QUERY_TIMEOUT');
      throw new DbiError('QUERY_EXECUTION_FAILED');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    return capResult(q, rows, limits.maxBytes, Date.now() - started);
  }
}

export function capResult(q: CompiledQuery, rows: unknown[][], maxBytes: number, dbTimeMs: number): ExecutionResult {
  let truncatedBy: ExecutionResult['truncatedBy'];
  if (rows.length > q.limit) {
    rows = rows.slice(0, q.limit);
    truncatedBy = 'row_limit';
  }
  let bytes = 2;
  for (let i = 0; i < rows.length; i++) {
    bytes += Buffer.byteLength(JSON.stringify(rows[i])) + 1;
    if (bytes > maxBytes) {
      rows = rows.slice(0, i);
      truncatedBy = 'byte_limit';
      break;
    }
  }
  return { columns: q.columns, rows, truncated: truncatedBy !== undefined, truncatedBy, dbTimeMs };
}
