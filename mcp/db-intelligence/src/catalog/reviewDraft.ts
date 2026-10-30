/**
 * 由掃描後的 Catalog 產生審核檔草稿，省去逐表逐欄手寫：
 * - 資料集一律 pending、欄位一律不開放查詢，由管理員決定開放範圍
 * - 敏感度依欄位名稱猜測，只是起點
 * - DB 原始註解不可信，帶入描述時加上 PENDING_MARK；未刪除標記的審核檔會被拒絕套用
 * - 沒有外鍵時依命名推測關聯（xxx_id → xxx.id），全部 pending
 */
import type { Catalog, CatalogDataset, Sensitivity } from '../contracts/catalog';
import type { CatalogReview } from './review';

/** 草稿中待人工確認的描述前綴 */
export const PENDING_MARK = '【待確認】';

const RESTRICTED = /(^|_)(stn_?id|id_?no|identity|national_id|ssn|passport|birthday|birth_?date|birth|salary|wage|bonus|bank|account_no|password|passwd|secret|token|blood|addr|address)(_|$)/;
const CONFIDENTIAL = /(^|_)(e?mail|mobile|phone|tel|fax|contact|sex|gender|married|marital|degree|religion|health)(_|$)/;

export function guessSensitivity(column: string): Sensitivity {
  const n = column.toLowerCase();
  if (RESTRICTED.test(n)) return 'restricted';
  if (CONFIDENTIAL.test(n)) return 'confidential';
  return 'internal';
}

const pending = (comment: string | null) => (comment?.trim() ? `${PENDING_MARK}${comment.trim()}` : undefined);

/** 依命名推測關聯：xxx_id → 資料集 xxx(s) 的單欄主鍵；或欄位名稱是某資料集名稱的結尾（job_post → employee_job_post） */
export function inferRelationships(catalog: Catalog): NonNullable<CatalogReview['addRelationships']> {
  const singlePk = (d: CatalogDataset) => (d.primaryKey.length === 1 ? d.columns.find((c) => c.name === d.primaryKey[0]) : undefined);
  const existing = new Set(catalog.relationships.map((r) => `${r.from.dataset}.${r.from.columns.join()}`));
  const out: NonNullable<CatalogReview['addRelationships']> = [];
  for (const from of catalog.datasets) {
    for (const col of from.columns) {
      if (existing.has(`${from.id}.${col.name}`)) continue;
      const base = col.name.toLowerCase().replace(/_id$/, '');
      const targets = catalog.datasets.filter((to) => {
        if (to.id === from.id) return false;
        const pk = singlePk(to);
        if (!pk || pk.typeCategory !== col.typeCategory) return false;
        const name = to.objectName.toLowerCase();
        if (col.name.toLowerCase().endsWith('_id')) return name === base || name === `${base}s` || name === `${base}es`;
        return name !== base && name.endsWith(`_${base}`);
      });
      // 名稱對到多個資料集時無法判斷，交給管理員手動定義
      if (targets.length !== 1) continue;
      out.push({ from: { dataset: from.id, columns: [col.name] }, to: { dataset: targets[0].id, columns: [singlePk(targets[0])!.name] }, approvalStatus: 'pending' });
    }
  }
  return out;
}

export function buildReviewDraft(catalog: Catalog): CatalogReview {
  return {
    datasets: catalog.datasets.map((d) => ({
      id: d.id,
      approvalStatus: 'pending',
      ...(pending(d.comment) ? { description: pending(d.comment) } : {}),
      synonyms: [],
      columns: Object.fromEntries(
        d.columns.map((c) => [
          c.name,
          {
            isQueryable: false,
            sensitivity: guessSensitivity(c.name),
            ...(pending(c.comment) ? { description: pending(c.comment) } : {}),
          },
        ]),
      ),
    })),
    addRelationships: inferRelationships(catalog),
    publish: false,
  };
}

/** 審核檔內仍有待確認的描述：回傳位置清單 */
export function pendingDescriptions(review: CatalogReview): string[] {
  const hits: string[] = [];
  for (const d of review.datasets ?? []) {
    if (d.description?.startsWith(PENDING_MARK)) hits.push(d.id);
    for (const [name, c] of Object.entries(d.columns ?? {})) if (c.description?.startsWith(PENDING_MARK)) hits.push(`${d.id}.${name}`);
  }
  return hits;
}
