import type { DbiCatalog, DbiCatalogDiff, DbiCatalogReview, DbiConnectionTest, DbiDbType, McpServerListView } from '../../../api';

/** db-intelligence 服務的特徵工具；未重新整理過工具清單時改看 serverId */
const DBI_TOOLS = ['search_schema', 'execute_safe_query'];

/** 此租戶可管理的 db-intelligence 服務：共用或此租戶專屬 */
export function dbiServersFor(view: McpServerListView | null, tenantId: string): { id: string; name: string }[] {
  if (!view) return [];
  return view.servers
    .filter((s) => s.config.ownerTenantId === null || s.config.ownerTenantId === tenantId)
    .filter((s) => {
      const names = new Set(s.tools.map((t) => t.name));
      return names.size > 0 ? DBI_TOOLS.every((n) => names.has(n)) : /db-intelligence|dbi/.test(s.config.id);
    })
    .map((s) => ({ id: s.config.id, name: s.config.name }));
}

/** 逗號或換行分隔 → 去空白、去重複 */
export function parseList(text: string): string[] {
  return [...new Set(text.split(/[,\n，]/).map((s) => s.trim()).filter(Boolean))];
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 由「原始 Catalog」與「畫面上編輯後的 Catalog」算出只含變更欄位的審核內容；沒有變更回 null */
export function buildCatalogReview(original: DbiCatalog, edited: DbiCatalog): DbiCatalogReview | null {
  const review: DbiCatalogReview = {};
  const datasets: NonNullable<DbiCatalogReview['datasets']> = [];
  for (const e of edited.datasets) {
    const o = original.datasets.find((d) => d.id === e.id);
    if (!o) continue;
    const patch: NonNullable<DbiCatalogReview['datasets']>[number] = { id: e.id };
    if (e.approvalStatus !== o.approvalStatus) patch.approvalStatus = e.approvalStatus;
    if ((e.description ?? '') !== (o.description ?? '')) patch.description = e.description?.trim() ? e.description.trim() : null;
    if (!sameList(e.synonyms, o.synonyms)) patch.synonyms = e.synonyms;
    const columns: NonNullable<typeof patch.columns> = {};
    for (const c of e.columns) {
      const oc = o.columns.find((x) => x.name === c.name);
      if (!oc) continue;
      const cp: (typeof columns)[string] = {};
      if (c.isQueryable !== oc.isQueryable) cp.isQueryable = c.isQueryable;
      if (c.sensitivity !== oc.sensitivity) cp.sensitivity = c.sensitivity;
      if ((c.description ?? '') !== (oc.description ?? '')) cp.description = c.description?.trim() ? c.description.trim() : null;
      if (!sameList(c.synonyms, oc.synonyms)) cp.synonyms = c.synonyms;
      if (Object.keys(cp).length) columns[c.name] = cp;
    }
    if (Object.keys(columns).length) patch.columns = columns;
    if (Object.keys(patch).length > 1) datasets.push(patch);
  }
  if (datasets.length) review.datasets = datasets;
  const relationships = edited.relationships
    .filter((r) => original.relationships.find((x) => x.id === r.id)?.approvalStatus !== r.approvalStatus)
    .map((r) => ({ id: r.id, approvalStatus: r.approvalStatus }));
  if (relationships.length) review.relationships = relationships;
  return Object.keys(review).length ? review : null;
}

/** 新掃到或型別變更、尚未審核的欄位數 */
export function unreviewedCount(c: DbiCatalog): number {
  return c.datasets.reduce((n, d) => n + d.columns.filter((x) => x.reviewStatus !== 'reviewed').length, 0);
}

export function diffSummary(d: DbiCatalogDiff): string[] {
  if (!d.changed) return ['結構沒有變更'];
  const lines: string[] = [];
  if (d.addedDatasets.length) lines.push(`新增資料集 ${d.addedDatasets.length} 個：${d.addedDatasets.join('、')}`);
  if (d.removedDatasets.length) lines.push(`移除資料集：${d.removedDatasets.join('、')}`);
  if (d.addedColumns.length) lines.push(`新增欄位 ${d.addedColumns.length} 個（預設不可查詢，需審核）`);
  if (d.removedColumns.length) lines.push(`移除欄位：${d.removedColumns.map((c) => `${c.dataset}.${c.column}`).join('、')}`);
  for (const c of d.changedColumns) lines.push(`型別變更：${c.dataset}.${c.column}（${c.from} → ${c.to}），已退回不可查詢`);
  for (const m of d.invalidatedMetrics) lines.push(`指標 ${m.dataset}.${m.metric} 引用的欄位有變動，已退回待審`);
  if (d.addedRelationships.length) lines.push(`新增關聯 ${d.addedRelationships.length} 條`);
  if (d.removedRelationships.length) lines.push(`移除關聯 ${d.removedRelationships.length} 條`);
  lines.push(`Catalog 版本 v${d.fromVersion} → v${d.toVersion}`);
  return lines;
}

const CONNECTION_ERRORS: Record<string, string> = {
  auth_failed: '帳號或密碼錯誤',
  database_not_found: '資料庫不存在',
  unreachable: '連不到資料庫主機',
  connection_failed: '連線失敗',
};

/** 連線測試結果 → 一句結論＋需要注意的地方 */
export function connectionSummary(t: DbiConnectionTest): { ok: boolean; text: string; warnings: string[] } {
  if (!t.ok) return { ok: false, text: CONNECTION_ERRORS[t.error ?? ''] ?? '連線失敗', warnings: [] };
  const warnings: string[] = [];
  if (t.writableObjects?.length) warnings.push(`此帳號仍可寫入：${t.writableObjects.join('、')}——請改用只有 SELECT 權限的帳號`);
  if (t.defaultReadOnly === false) warnings.push('連線未預設唯讀（default_transaction_read_only=off）；查詢仍在唯讀交易中執行');
  warnings.push(...(t.warnings ?? []));
  return { ok: true, text: `連線成功（${t.serverVersion ?? '版本不明'}，${t.latencyMs} ms）`, warnings };
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `JSON 格式錯誤：${e instanceof Error ? e.message : String(e)}` };
  }
}

export function policyTemplate(tenantId: string, dataSourceId: string, dataset: string): Record<string, unknown> {
  return {
    id: `${dataset.split('.').pop()}-employees`,
    tenantId,
    dataSourceId,
    dataset,
    principals: { roles: ['employee'], users: [] },
    columns: ['*'],
    rowScope: [],
    masked: {},
    aggregateOnly: false,
  };
}

export const SAMPLE_PLAN = (dataSourceId: string, dataset: string) =>
  JSON.stringify({ version: '1.0', data_source_id: dataSourceId, dataset, select: [{ agg: 'count', alias: 'n' }] }, null, 2);

export const DB_TYPE_LABELS: Record<DbiDbType, string> = { postgres: 'PostgreSQL', mariadb: 'MariaDB', mysql: 'MySQL' };

/** 連線字串範例（只當提示；實際連線字串放在 db-intelligence 的環境變數） */
export const CONNECTION_EXAMPLES: Record<DbiDbType, string> = {
  postgres: 'postgres://唯讀帳號:密碼@主機:5432/資料庫?sslmode=require',
  mariadb: 'mysql://唯讀帳號:密碼@主機:3306/資料庫',
  mysql: 'mysql://唯讀帳號:密碼@主機:3306/資料庫',
};
