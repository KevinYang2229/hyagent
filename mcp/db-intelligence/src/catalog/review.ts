/**
 * 管理員審核 Catalog（規格書 5.2 PATCH /api/catalog/datasets/{id}）：核准資料集、開放欄位、
 * 設定敏感度與業務描述、定義計算指標、核准人工關聯、發布。純函式，Admin API 與 CLI 共用。
 */
import { z } from 'zod';
import { metricExprSchema, SENSITIVITIES, type Catalog, type CatalogDataset } from '../contracts/catalog';
import { PENDING_MARK, pendingDescriptions } from './reviewDraft';
import { metricColumns } from './sync';

const approval = z.enum(['pending', 'approved', 'rejected']);

export const catalogReviewSchema = z
  .object({
    datasets: z
      .array(
        z
          .object({
            id: z.string(),
            approvalStatus: approval.optional(),
            description: z.string().max(1000).nullable().optional(),
            synonyms: z.array(z.string().max(50)).max(20).optional(),
            columns: z
              .record(
                z
                  .object({
                    isQueryable: z.boolean().optional(),
                    sensitivity: z.enum(SENSITIVITIES).optional(),
                    description: z.string().max(500).nullable().optional(),
                    synonyms: z.array(z.string().max(50)).max(20).optional(),
                  })
                  .strict(),
              )
              .optional(),
            /** 依 key 新增或取代 */
            metrics: z
              .array(
                z
                  .object({
                    key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
                    description: z.string().max(500),
                    synonyms: z.array(z.string().max(50)).max(20).default([]),
                    expression: metricExprSchema,
                    approvalStatus: approval.default('approved'),
                  })
                  .strict(),
              )
              .optional(),
            removeMetrics: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .default([]),
    relationships: z.array(z.object({ id: z.string(), approvalStatus: approval }).strict()).default([]),
    /** 人工定義的 JOIN（無外鍵時），核准狀態預設 pending */
    addRelationships: z
      .array(
        z
          .object({
            from: z.object({ dataset: z.string(), columns: z.array(z.string()).min(1) }).strict(),
            to: z.object({ dataset: z.string(), columns: z.array(z.string()).min(1) }).strict(),
            approvalStatus: approval.default('pending'),
          })
          .strict(),
      )
      .default([]),
    publish: z.boolean().optional(),
  })
  .strict();
export type CatalogReview = z.input<typeof catalogReviewSchema>;

export class CatalogReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogReviewError';
  }
}

function requireColumns(ds: CatalogDataset, cols: string[], what: string): void {
  for (const c of cols) {
    if (!ds.columns.some((x) => x.name === c)) throw new CatalogReviewError(`${what}：${ds.id} 沒有欄位 ${c}`);
  }
}

export function applyCatalogReview(catalog: Catalog, input: CatalogReview, now: Date = new Date()): Catalog {
  const review = catalogReviewSchema.parse(input);
  const unconfirmed = pendingDescriptions(review);
  if (unconfirmed.length) {
    throw new CatalogReviewError(`描述仍標記${PENDING_MARK}（DB 原始註解未經確認）：${unconfirmed.slice(0, 5).join('、')}${unconfirmed.length > 5 ? ` 等 ${unconfirmed.length} 處` : ''}`);
  }
  const next: Catalog = structuredClone(catalog);
  const find = (id: string) => {
    const ds = next.datasets.find((d) => d.id === id);
    if (!ds) throw new CatalogReviewError(`找不到資料集 ${id}`);
    return ds;
  };

  for (const r of review.datasets) {
    const ds = find(r.id);
    if (r.approvalStatus) ds.approvalStatus = r.approvalStatus;
    if (r.description !== undefined) {
      ds.description = r.description;
      ds.descriptionStatus = r.description ? 'approved' : 'none';
    }
    if (r.synonyms) ds.synonyms = r.synonyms;
    for (const [name, patch] of Object.entries(r.columns ?? {})) {
      const col = ds.columns.find((c) => c.name === name);
      if (!col) throw new CatalogReviewError(`${ds.id} 沒有欄位 ${name}`);
      if (patch.isQueryable && col.typeCategory === 'other') {
        throw new CatalogReviewError(`${ds.id}.${name} 的型別（${col.dataType}）不支援查詢`);
      }
      if (patch.isQueryable !== undefined) col.isQueryable = patch.isQueryable;
      if (patch.sensitivity) col.sensitivity = patch.sensitivity;
      if (patch.description !== undefined) {
        col.description = patch.description;
        col.descriptionStatus = patch.description ? 'approved' : 'none';
      }
      if (patch.synonyms) col.synonyms = patch.synonyms;
      col.reviewStatus = 'reviewed';
    }
    if (r.removeMetrics) ds.metrics = ds.metrics.filter((m) => !r.removeMetrics!.includes(m.key));
    for (const m of r.metrics ?? []) {
      const cols = metricColumns(m.expression);
      requireColumns(ds, cols, `指標 ${m.key}`);
      for (const c of cols) {
        if (ds.columns.find((x) => x.name === c)!.typeCategory !== 'numeric') {
          throw new CatalogReviewError(`指標 ${m.key}：欄位 ${c} 不是數值型別`);
        }
      }
      if (ds.columns.some((c) => c.name === m.key)) throw new CatalogReviewError(`指標 ${m.key} 與欄位同名`);
      ds.metrics = [...ds.metrics.filter((x) => x.key !== m.key), m];
    }
  }

  for (const r of review.relationships) {
    const rel = next.relationships.find((x) => x.id === r.id);
    if (!rel) throw new CatalogReviewError(`找不到關聯 ${r.id}`);
    rel.approvalStatus = r.approvalStatus;
  }
  for (const r of review.addRelationships) {
    if (r.from.columns.length !== r.to.columns.length) throw new CatalogReviewError('關聯兩端欄位數不同');
    requireColumns(find(r.from.dataset), r.from.columns, '關聯');
    requireColumns(find(r.to.dataset), r.to.columns, '關聯');
    const id = `manual:${r.from.dataset}(${r.from.columns.join(',')})->${r.to.dataset}(${r.to.columns.join(',')})`;
    next.relationships = [...next.relationships.filter((x) => x.id !== id), { id, from: r.from, to: r.to, origin: 'manual', approvalStatus: r.approvalStatus }];
  }

  if (review.publish !== undefined) next.published = review.publish;
  next.version = catalog.version + 1;
  next.updatedAt = now.toISOString();
  return next;
}
