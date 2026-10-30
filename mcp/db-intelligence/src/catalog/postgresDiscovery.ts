/**
 * PostgreSQL Schema Discovery：只查系統目錄（pg_catalog），不讀任何資料列。
 * 只回傳允許掃描的 schema 內、且 Connector 唯讀帳號有 SELECT 權限的物件——DB 最小權限是第一道範圍。
 * 外鍵只保留兩端都在掃描範圍內的，避免洩漏範圍外的物件名稱。
 */
import { createHash } from 'node:crypto';
import type { ClientBase } from 'pg';
import type { DatasetKind, DbType, DiscoveredForeignKey, DiscoveredObject, DiscoveredSchema } from '../contracts/catalog';

export interface DiscoveryOptions {
  schemas: string[];
  /** 只掃描這些物件（schema.object） */
  includeObjects?: string[];
  statementTimeoutMs?: number;
}

const KINDS: Record<string, DatasetKind> = { r: 'table', p: 'table', v: 'view', m: 'materialized_view' };

const OBJECTS_SQL = `
SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind::text AS relkind,
       obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition
  AND has_table_privilege(c.oid, 'SELECT')
ORDER BY 1, 2`;

const COLUMNS_SQL = `
SELECT n.nspname AS schema_name, c.relname AS object_name, a.attname::text AS name,
       format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS nullable, a.attnum AS ordinal,
       col_description(c.oid, a.attnum) AS comment
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition
  AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(c.oid, a.attnum, 'SELECT')
ORDER BY 1, 2, a.attnum`;

const CONSTRAINTS_SQL = `
SELECT con.conname::text AS name, con.contype::text AS type, n.nspname AS schema_name, c.relname AS object_name,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
       fn.nspname AS ref_schema, fc.relname AS ref_object,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.contype IN ('p', 'f') AND n.nspname = ANY($1::text[])
ORDER BY 3, 4, 1`;

const INDEXES_SQL = `
SELECT n.nspname AS schema_name, c.relname AS object_name, i.relname AS name, ix.indisunique AS unique,
       ARRAY(SELECT a.attname::text FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[])
ORDER BY 1, 2, 3`;

type Row = Record<string, unknown>;

/** 以呼叫端提供的連線執行；全程在唯讀交易內，結束後 ROLLBACK */
export async function discoverPostgresSchema(client: ClientBase, opts: DiscoveryOptions): Promise<DiscoveredSchema> {
  const schemas = [...new Set(opts.schemas)].sort();
  const include = opts.includeObjects ? new Set(opts.includeObjects) : null;
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(opts.statementTimeoutMs ?? 15_000)}`);
    const [objects, columns, constraints, indexes] = [
      (await client.query(OBJECTS_SQL, [schemas])).rows as Row[],
      (await client.query(COLUMNS_SQL, [schemas])).rows as Row[],
      (await client.query(CONSTRAINTS_SQL, [schemas])).rows as Row[],
      (await client.query(INDEXES_SQL, [schemas])).rows as Row[],
    ];
    return buildDiscoveredSchema(schemas, include, objects, columns, constraints, indexes);
  } finally {
    await client.query('ROLLBACK');
  }
}

const keyOf = (schema: unknown, object: unknown) => `${String(schema)}.${String(object)}`;

/**
 * 純函式：把系統目錄查詢結果組成 DiscoveredSchema（拆出來方便單元測試，MariaDB／MySQL 也共用）。
 * 物件種類用 PostgreSQL 的 relkind 代碼（r／p／v／m），其他資料庫在查詢端先轉成這組代碼。
 */
export function buildDiscoveredSchema(
  schemas: string[],
  include: Set<string> | null,
  objectRows: Row[],
  columnRows: Row[],
  constraintRows: Row[],
  indexRows: Row[],
  dbType: DbType = 'postgres',
): DiscoveredSchema {
  const byKey = new Map<string, DiscoveredObject>();
  for (const r of objectRows) {
    const key = keyOf(r.schema_name, r.object_name);
    const kind = KINDS[String(r.relkind)];
    if (!kind || (include && !include.has(key))) continue;
    byKey.set(key, {
      schemaName: String(r.schema_name),
      objectName: String(r.object_name),
      kind,
      comment: (r.comment as string | null) ?? null,
      columns: [],
      primaryKey: [],
      indexes: [],
    });
  }
  for (const r of columnRows) {
    byKey.get(keyOf(r.schema_name, r.object_name))?.columns.push({
      name: String(r.name),
      dataType: String(r.data_type),
      nullable: Boolean(r.nullable),
      ordinal: Number(r.ordinal),
      comment: (r.comment as string | null) ?? null,
    });
  }
  const foreignKeys: DiscoveredForeignKey[] = [];
  for (const r of constraintRows) {
    const from = byKey.get(keyOf(r.schema_name, r.object_name));
    if (!from) continue;
    const cols = r.columns as string[];
    if (r.type === 'p') {
      from.primaryKey = cols;
    } else {
      const to = byKey.get(keyOf(r.ref_schema, r.ref_object));
      if (!to) continue;
      foreignKeys.push({
        name: String(r.name),
        from: { schemaName: from.schemaName, objectName: from.objectName, columns: cols },
        to: { schemaName: to.schemaName, objectName: to.objectName, columns: r.ref_columns as string[] },
      });
    }
  }
  for (const r of indexRows) {
    byKey.get(keyOf(r.schema_name, r.object_name))?.indexes.push({
      name: String(r.name),
      columns: r.columns as string[],
      unique: Boolean(r.unique),
    });
  }
  const objects = [...byKey.values()];
  const body = { dbType, schemas, objects, foreignKeys };
  return { ...body, schemaVersion: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
