/**
 * SQL Compiler：只吃 Validator 輸出的 ResolvedQuery，語法差異交給方言（dialect.ts）。
 * 識別字一律取自 Catalog 並依方言跳脫；所有來自模型或身分的值都走參數，不做字串拼接值。
 * 多取一筆（limit + 1）讓執行端判斷結果是否被截斷。
 */
import type { MetricExpr } from '../contracts/catalog';
import { escapeLike, postgresDialect, type SqlDialect } from './dialect';
import type { ResolvedQuery, ValueExpr } from './validator';

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  /** SELECT 輸出欄位，依序 */
  columns: string[];
  /** 實際允許回傳的筆數（SQL 多取一筆） */
  limit: number;
}

/** PostgreSQL 識別字跳脫（保留給既有呼叫端） */
export const quoteIdent = postgresDialect.quoteIdent;

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
const AGG_SQL = { sum: 'sum', avg: 'avg', min: 'min', max: 'max' } as const;

export function compileQuery(q: ResolvedQuery, d: SqlDialect = postgresDialect): CompiledQuery {
  const params: unknown[] = [];
  const param = (v: unknown) => {
    params.push(v);
    return d.placeholder(params.length);
  };
  const quote = d.quoteIdent;
  const col = (alias: string, name: string) => `${alias}.${quote(name)}`;
  const table = (schema: string, object: string) => `${quote(schema)}.${quote(object)}`;
  const like = (e: string, pattern: string) => d.ilike(e, param(pattern));
  const metric = (alias: string, e: MetricExpr): string => {
    if ('column' in e) return d.toNumeric(col(alias, e.column));
    if ('number' in e) return d.numberLiteral(e.number, param);
    const [a, b] = e.args.map((x) => metric(alias, x));
    if (e.op === 'div') return `(${a} / NULLIF(${b}, 0))`;
    return `(${a} ${{ add: '+', sub: '-', mul: '*' }[e.op]} ${b})`;
  };
  const expr = (e: ValueExpr) => (e.kind === 'column' ? col(e.alias, e.column) : metric(e.alias, e.expr));
  const eqScope = (alias: string, column: string, value: unknown) =>
    Array.isArray(value) ? d.inList(col(alias, column), value, param) : `${col(alias, column)} = ${param(value)}`;

  const selectSql = q.select.map((s) => {
    let body: string;
    if (!s.agg) body = expr(s.expr!);
    else if (s.agg === 'count') body = s.expr ? `count(${expr(s.expr)})` : 'count(*)';
    else if (s.agg === 'count_distinct') body = `count(DISTINCT ${expr(s.expr!)})`;
    else body = `${AGG_SQL[s.agg]}(${expr(s.expr!)})`;
    return `${body} AS ${quote(s.output)}`;
  });

  const [base, ...joined] = q.datasets;
  const from = [`FROM ${table(base.dataset.schemaName, base.dataset.objectName)} AS ${base.alias}`];
  for (const j of joined) {
    const on = j.join!.on.map((o) => `${col(o.leftAlias, o.leftColumn)} = ${col(j.alias, o.rightColumn)}`);
    // join 進來的資料集，其資料列範圍放在 ON：left join 時未授權的列只會變成 NULL，不會被帶出
    for (const s of j.scope) on.push(eqScope(j.alias, s.column, s.value));
    from.push(`${j.join!.type === 'left' ? 'LEFT JOIN' : 'JOIN'} ${table(j.dataset.schemaName, j.dataset.objectName)} AS ${j.alias} ON ${on.join(' AND ')}`);
  }

  const where: string[] = [];
  for (const f of q.filters) {
    const e = expr(f.expr);
    switch (f.op) {
      case 'is_null':
        where.push(`${e} IS NULL`);
        break;
      case 'is_not_null':
        where.push(`${e} IS NOT NULL`);
        break;
      case 'in':
        where.push(d.inList(e, f.value as unknown[], param));
        break;
      case 'not_in':
        where.push(`NOT (${d.inList(e, f.value as unknown[], param)})`);
        break;
      case 'contains':
        where.push(like(e, `%${escapeLike(String(f.value), d.likeEscape)}%`));
        break;
      case 'starts_with':
        where.push(like(e, `${escapeLike(String(f.value), d.likeEscape)}%`));
        break;
      default:
        where.push(`${e} ${OPS[f.op]} ${param(f.value)}`);
    }
  }
  for (const s of base.scope) where.push(eqScope(base.alias, s.column, s.value));

  const parts = [`SELECT ${selectSql.join(', ')}`, ...from];
  if (where.length) parts.push(`WHERE ${where.map((w) => `(${w})`).join(' AND ')}`);
  if (q.groupBy.length) parts.push(`GROUP BY ${q.groupBy.map(expr).join(', ')}`);
  if (q.minGroupSize) parts.push(`HAVING count(*) >= ${param(q.minGroupSize)}`);
  if (q.orderBy.length) {
    parts.push(
      `ORDER BY ${q.orderBy.map((o) => `${'output' in o.target ? quote(o.target.output) : expr(o.target.expr)} ${o.direction.toUpperCase()}`).join(', ')}`,
    );
  }
  parts.push(d.limit(q.limit + 1, param));
  return { sql: parts.join('\n'), params, columns: q.select.map((s) => s.output), limit: q.limit };
}
