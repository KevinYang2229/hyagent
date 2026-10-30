/**
 * SQL 方言：編譯器裡所有資料庫專屬的語法都在這裡。識別字跳脫、參數佔位、IN、LIKE、數值轉型、LIMIT。
 *
 * 參數順序：PostgreSQL 的 $n 有編號；MySQL／MariaDB 的 ? 只看出現順序，因此編譯器加入參數的順序
 * 必須與參數在 SQL 文字中出現的順序一致（編譯器依 SELECT → FROM/JOIN → WHERE → GROUP BY → HAVING
 * → ORDER BY 的順序產生，滿足這個條件）。
 */
import type { DbType } from '../contracts/catalog';

export interface SqlDialect {
  name: 'postgres' | 'mysql';
  quoteIdent(name: string): string;
  /** 第 n 個參數（從 1 起算）的佔位符 */
  placeholder(n: number): string;
  /** expr IN (values)；values 至少一個（Query Plan 驗證已保證） */
  inList(expr: string, values: unknown[], param: (v: unknown) => string): string;
  /** 不分大小寫的模式比對；pattern 已用 likeEscape 跳脫 */
  ilike(expr: string, patternParam: string): string;
  likeEscape: string;
  /** 轉成可做小數除法的數值 */
  toNumeric(sql: string): string;
  /** 已核准指標裡的數字常數（來自 Catalog，非模型輸入） */
  numberLiteral(n: number, param: (v: unknown) => string): string;
  limit(n: number, param: (v: unknown) => string): string;
}

export function escapeLike(s: string, escape: string): string {
  const special = new Set(['%', '_', escape]);
  return [...s].map((c) => (special.has(c) ? `${escape}${c}` : c)).join('');
}

export const postgresDialect: SqlDialect = {
  name: 'postgres',
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  placeholder: (n) => `$${n}`,
  inList: (expr, values, param) => `${expr} = ANY(${param(values)})`,
  ilike: (expr, p) => `${expr} ILIKE ${p} ESCAPE '\\'`,
  likeEscape: '\\',
  toNumeric: (sql) => `${sql}::numeric`,
  numberLiteral: (n, param) => `${param(n)}::numeric`,
  limit: (n, param) => `LIMIT ${param(n)}`,
};

/**
 * MySQL 8／MariaDB。
 * - LIKE 的大小寫取決於欄位定序（常見的 *_ci 不分大小寫）；跳脫字元用 !，不受 NO_BACKSLASH_ESCAPES 影響
 * - 指標常數直接寫入：ONLY_FULL_GROUP_BY 下，SELECT 與 GROUP BY 的同一運算式若各帶一個 ? 會被視為不同運算式
 * - LIMIT 直接寫入整數（已驗證範圍）：prepared statement 的 LIMIT ? 在部分版本有型別問題
 */
export const mysqlDialect: SqlDialect = {
  name: 'mysql',
  quoteIdent: (name) => `\`${name.replace(/`/g, '``')}\``,
  placeholder: () => '?',
  inList: (expr, values, param) => `${expr} IN (${values.map((v) => param(v)).join(', ')})`,
  ilike: (expr, p) => `${expr} LIKE ${p} ESCAPE '!'`,
  likeEscape: '!',
  toNumeric: (sql) => `CAST(${sql} AS DECIMAL(65,10))`,
  numberLiteral: (n) => {
    if (!Number.isFinite(n)) throw new Error('指標常數必須是有限數字');
    return `CAST(${String(n)} AS DECIMAL(65,10))`;
  },
  limit: (n) => `LIMIT ${Math.max(0, Math.trunc(n))}`,
};

export function dialectFor(dbType: DbType): SqlDialect {
  return dbType === 'postgres' ? postgresDialect : mysqlDialect;
}
