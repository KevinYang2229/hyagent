/**
 * Metadata 檢索（search_schema）：只在呼叫者可見的範圍內搜尋——資料集已核准、有適用政策，
 * 欄位可查詢且被政策允許。比對對象只有名稱與「已核准」描述／同義詞；DB 原始註解不參與也不回傳。
 * 中文以二字詞切分，英文以單字切分；完全沒命中時回傳可見資料集清單（如「列出所有資料表」）。
 */
import type { Catalog, CatalogDataset } from '../contracts/catalog';
import type { AccessPolicy, Principal } from '../contracts/policy';
import { allowedColumns, policyApplies } from '../query/policy';

export interface VisibleDataset {
  dataset: CatalogDataset;
  columns: CatalogDataset['columns'];
  metrics: CatalogDataset['metrics'];
  masked: Set<string>;
  rowScoped: boolean;
  aggregateOnly: boolean;
}

/** 呼叫者可見的資料集與欄位：適用政策的聯集，只用於「看得到什麼」，查詢授權另由 Validator 逐政策判斷 */
export function visibleDatasets(catalog: Catalog, policies: AccessPolicy[], principal: Principal): VisibleDataset[] {
  if (!catalog.published || catalog.tenantId !== principal.tenantId) return [];
  const out: VisibleDataset[] = [];
  for (const ds of catalog.datasets) {
    if (ds.approvalStatus !== 'approved') continue;
    const ps = policies.filter((p) => policyApplies(p, principal, catalog.dataSourceId, ds.id));
    if (ps.length === 0) continue;
    const allowed = new Set(ps.flatMap((p) => [...allowedColumns(p, ds)]));
    // 欄位只要有一條政策不遮罩就視為不遮罩
    const masked = new Set([...allowed].filter((c) => ps.every((p) => !allowedColumns(p, ds).has(c) || p.masked[c])));
    const columns = ds.columns.filter((c) => allowed.has(c.name));
    const colNames = new Set(columns.map((c) => c.name));
    const metrics = ds.metrics.filter((m) => m.approvalStatus === 'approved' && metricColumnsVisible(m.expression, colNames));
    out.push({
      dataset: ds,
      columns,
      metrics,
      masked,
      rowScoped: ps.every((p) => p.rowScope.length > 0),
      aggregateOnly: ps.every((p) => p.aggregateOnly),
    });
  }
  return out;
}

function metricColumnsVisible(e: CatalogDataset['metrics'][number]['expression'], cols: Set<string>): boolean {
  if ('column' in e) return cols.has(e.column);
  if ('number' in e) return true;
  return metricColumnsVisible(e.args[0], cols) && metricColumnsVisible(e.args[1], cols);
}

export function tokenize(text: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9]+/g) ?? []) if (w.length >= 2) out.add(w);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

function textOf(...parts: (string | null | undefined | string[])[]): string {
  return parts.flat().filter(Boolean).join(' ').toLowerCase().replace(/_/g, ' ');
}

export function scoreDataset(v: VisibleDataset, tokens: string[]): number {
  const ds = v.dataset;
  const approvedDesc = ds.descriptionStatus === 'approved' ? ds.description : null;
  const head = textOf(ds.key, ds.objectName, approvedDesc, ds.synonyms);
  const body = textOf(
    v.columns.flatMap((c) => [c.name, c.descriptionStatus === 'approved' ? (c.description ?? '') : '', ...c.synonyms]),
    v.metrics.flatMap((m) => [m.key, m.description, ...m.synonyms]),
  );
  let score = 0;
  for (const t of tokens) {
    if (head.includes(t)) score += 3;
    if (body.includes(t)) score += 1;
  }
  return score;
}

export function searchDatasets(visible: VisibleDataset[], question: string, limit: number): { matched: boolean; results: VisibleDataset[] } {
  const tokens = tokenize(question);
  const scored = visible.map((v) => ({ v, s: scoreDataset(v, tokens) })).filter((x) => x.s > 0);
  if (scored.length === 0) {
    return { matched: false, results: [...visible].sort((a, b) => a.dataset.key.localeCompare(b.dataset.key)).slice(0, limit) };
  }
  scored.sort((a, b) => b.s - a.s || a.v.dataset.key.localeCompare(b.v.dataset.key));
  return { matched: true, results: scored.slice(0, limit).map((x) => x.v) };
}
