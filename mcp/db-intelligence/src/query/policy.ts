/**
 * Policy Engine（規格書 7.2）：決定某使用者能看見哪些資料集與欄位，以及一個查詢對某資料集的用法是否被允許。
 * 多條政策符合時，必須有「單一」政策完整允許該資料集的用法；不把多條政策的欄位、範圍拼起來，
 * 否則「部門範圍的明細」＋「全公司的僅聚合」會被拼成「全公司明細」。
 */
import type { CatalogDataset } from '../contracts/catalog';
import type { AccessPolicy, Principal } from '../contracts/policy';

const STAR_SENSITIVITIES = new Set(['public', 'internal']);

export function policyApplies(p: AccessPolicy, principal: Principal, dataSourceId: string, datasetId: string): boolean {
  return (
    p.tenantId === principal.tenantId &&
    p.dataSourceId === dataSourceId &&
    p.dataset === datasetId &&
    (p.principals.users.includes(principal.userId) || p.principals.roles.some((r) => principal.roles.includes(r)))
  );
}

/** 政策允許的欄位（只含 Catalog 標記為可查詢的） */
export function allowedColumns(p: AccessPolicy, ds: CatalogDataset): Set<string> {
  const star = p.columns.includes('*');
  return new Set(
    ds.columns
      .filter((c) => c.isQueryable && (p.columns.includes(c.name) || (star && STAR_SENSITIVITIES.has(c.sensitivity))))
      .map((c) => c.name),
  );
}

export interface DatasetUsage {
  /** 明細查詢中直接輸出的欄位 */
  raw: Set<string>;
  /** 聚合查詢中的分組欄位 */
  grouped: Set<string>;
  /** 出現在聚合函式內的欄位 */
  aggregated: Set<string>;
  filtered: Set<string>;
  ordered: Set<string>;
}

export function emptyUsage(): DatasetUsage {
  return { raw: new Set(), grouped: new Set(), aggregated: new Set(), filtered: new Set(), ordered: new Set() };
}

export interface ScopeCondition {
  column: string;
  value: string | number | (string | number)[];
}

export interface PolicyDecision {
  policy: AccessPolicy;
  masked: Map<string, 'redact' | 'partial'>;
  rowScope: ScopeCondition[];
}

export type PolicyCheck = { ok: true; decision: PolicyDecision } | { ok: false; reason: string };

export function checkPolicy(p: AccessPolicy, ds: CatalogDataset, usage: DatasetUsage, isAggregate: boolean, principal: Principal): PolicyCheck {
  const allowed = allowedColumns(p, ds);
  const all = new Set([...usage.raw, ...usage.grouped, ...usage.aggregated, ...usage.filtered, ...usage.ordered]);
  for (const c of all) if (!allowed.has(c)) return { ok: false, reason: `未授權欄位 ${c}` };
  for (const c of Object.keys(p.masked)) {
    if (usage.grouped.has(c) || usage.aggregated.has(c) || usage.filtered.has(c) || usage.ordered.has(c)) {
      return { ok: false, reason: `遮罩欄位 ${c} 只能直接顯示，不能用於篩選、分組、排序或計算` };
    }
  }
  if (p.aggregateOnly && !isAggregate) return { ok: false, reason: `${ds.key} 只允許統計查詢` };
  const rowScope: ScopeCondition[] = [];
  for (const s of p.rowScope) {
    const value = principal.attributes[s.attribute];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return { ok: false, reason: '缺少資料範圍所需的身分屬性' };
    rowScope.push({ column: s.column, value });
  }
  const masked = new Map(Object.entries(p.masked).filter(([c]) => usage.raw.has(c)));
  return { ok: true, decision: { policy: p, masked, rowScope } };
}

/** 從適用的政策中挑出允許此用法的一條：優先沒有資料列限制、可回傳筆數較多的 */
export function decide(candidates: AccessPolicy[], ds: CatalogDataset, usage: DatasetUsage, isAggregate: boolean, principal: Principal): PolicyCheck {
  let firstFailure: string | undefined;
  const passed: PolicyDecision[] = [];
  for (const p of candidates) {
    const r = checkPolicy(p, ds, usage, isAggregate, principal);
    if (r.ok) passed.push(r.decision);
    else firstFailure ??= r.reason;
  }
  if (passed.length === 0) return { ok: false, reason: firstFailure ?? '沒有適用的存取政策' };
  passed.sort(
    (a, b) =>
      a.rowScope.length - b.rowScope.length ||
      a.masked.size - b.masked.size ||
      (b.policy.maxRows ?? Number.MAX_SAFE_INTEGER) - (a.policy.maxRows ?? Number.MAX_SAFE_INTEGER),
  );
  return { ok: true, decision: passed[0] };
}
