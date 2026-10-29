/**
 * SQL Compiler（PostgreSQL 方言）：只吃 Validator 輸出的 ResolvedQuery。
 * 識別字一律取自 Catalog 並加雙引號跳脫；所有值（含指標常數、資料範圍值）都走 $n 參數，不做字串拼接值。
 * 多取一筆（limit + 1）讓執行端判斷結果是否被截斷。
 */
import type { MetricExpr } from '../contracts/catalog';
import type { ResolvedQuery, ValueExpr } from './validator';

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  /** SELECT 輸出欄位，依序 */
  columns: string[];
  /** 實際允許回傳的筆數（SQL 多取一筆） */
  limit: number;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
const AGG_SQL = { sum: 'sum', avg: 'avg', min: 'min', max: 'max' } as const;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function compileQuery(q: ResolvedQuery): CompiledQuery {
  const params: unknown[] = [];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const col = (alias: string, name: string) => `${alias}.${quoteIdent(name)}`;
  const metric = (alias: string, e: MetricExpr): string => {
    if ('column' in e) return `${col(alias, e.column)}::numeric`;
    if ('number' in e) return `${param(e.number)}::numeric`;
    const [a, b] = e.args.map((x) => metric(alias, x));
    if (e.op === 'div') return `(${a} / NULLIF(${b}, 0))`;
    return `(${a} ${{ add: '+', sub: '-', mul: '*' }[e.op]} ${b})`;
  };
  const expr = (e: ValueExpr) => (e.kind === 'column' ? col(e.alias, e.column) : metric(e.alias, e.expr));
  const eqScope = (alias: string, column: string, value: unknown) =>
    Array.isArray(value) ? `${col(alias, column)} = ANY(${param(value)})` : `${col(alias, column)} = ${param(value)}`;

  const selectSql = q.select.map((s) => {
    let body: string;
    if (!s.agg) body = expr(s.expr!);
    else if (s.agg === 'count') body = s.expr ? `count(${expr(s.expr)})` : 'count(*)';
    else if (s.agg === 'count_distinct') body = `count(DISTINCT ${expr(s.expr!)})`;
    else body = `${AGG_SQL[s.agg]}(${expr(s.expr!)})`;
    return `${body} AS ${quoteIdent(s.output)}`;
  });

  const [base, ...joined] = q.datasets;
  const from = [`FROM ${quoteIdent(base.dataset.schemaName)}.${quoteIdent(base.dataset.objectName)} AS ${base.alias}`];
  for (const d of joined) {
    const on = d.join!.on.map((o) => `${col(o.leftAlias, o.leftColumn)} = ${col(d.alias, o.rightColumn)}`);
    // join 進來的資料集，其資料列範圍放在 ON：left join 時未授權的列只會變成 NULL，不會被帶出
    for (const s of d.scope) on.push(eqScope(d.alias, s.column, s.value));
    from.push(`${d.join!.type === 'left' ? 'LEFT JOIN' : 'JOIN'} ${quoteIdent(d.dataset.schemaName)}.${quoteIdent(d.dataset.objectName)} AS ${d.alias} ON ${on.join(' AND ')}`);
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
        where.push(`${e} = ANY(${param(f.value)})`);
        break;
      case 'not_in':
        where.push(`NOT (${e} = ANY(${param(f.value)}))`);
        break;
      case 'contains':
        where.push(`${e} ILIKE ${param(`%${escapeLike(String(f.value))}%`)} ESCAPE '\\'`);
        break;
      case 'starts_with':
        where.push(`${e} ILIKE ${param(`${escapeLike(String(f.value))}%`)} ESCAPE '\\'`);
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
      `ORDER BY ${q.orderBy.map((o) => `${'output' in o.target ? quoteIdent(o.target.output) : expr(o.target.expr)} ${o.direction.toUpperCase()}`).join(', ')}`,
    );
  }
  parts.push(`LIMIT ${param(q.limit + 1)}`);
  return { sql: parts.join('\n'), params, columns: q.select.map((s) => s.output), limit: q.limit };
}
