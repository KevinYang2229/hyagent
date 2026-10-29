/**
 * 把掃描結果合併進 Catalog 並產生差異（規格書 4.1 步驟 8、6.2）。
 * 授權不會因重掃而擴大：新資料集待審、新欄位不可查、型別變更的欄位退回不可查，
 * 指標引用的欄位被移除或變更時，指標退回待審。管理員已審過的描述、敏感度、核准狀態都保留。
 */
import type {
  Catalog,
  CatalogColumn,
  CatalogDataset,
  CatalogDiff,
  CatalogMetric,
  CatalogRelationship,
  DiscoveredObject,
  DiscoveredSchema,
  MetricExpr,
} from '../contracts/catalog';
import { typeCategoryOf } from '../contracts/catalog';

export interface SyncOptions {
  dataSourceId: string;
  tenantId: string;
  now?: () => Date;
}

function newColumn(c: DiscoveredObject['columns'][number]): CatalogColumn {
  return {
    name: c.name,
    dataType: c.dataType,
    typeCategory: typeCategoryOf(c.dataType),
    nullable: c.nullable,
    comment: c.comment,
    description: null,
    descriptionStatus: 'none',
    synonyms: [],
    sensitivity: 'internal',
    isQueryable: false,
    reviewStatus: 'new',
  };
}

export function metricColumns(expr: MetricExpr): string[] {
  if ('column' in expr) return [expr.column];
  if ('number' in expr) return [];
  return [...metricColumns(expr.args[0]), ...metricColumns(expr.args[1])];
}

function fkRelationshipId(o: DiscoveredSchema['foreignKeys'][number]): string {
  return `fk:${o.from.schemaName}.${o.from.objectName}(${o.from.columns.join(',')})->${o.to.schemaName}.${o.to.objectName}(${o.to.columns.join(',')})`;
}

export function syncCatalog(prev: Catalog | undefined, discovered: DiscoveredSchema, opts: SyncOptions): { catalog: Catalog; diff: CatalogDiff } {
  if (prev && (prev.dataSourceId !== opts.dataSourceId || prev.tenantId !== opts.tenantId)) {
    throw new Error('Catalog 與資料來源／租戶不符');
  }
  const now = (opts.now ?? (() => new Date()))();
  const fromVersion = prev?.version ?? 0;
  const diff: CatalogDiff = {
    fromVersion,
    toVersion: fromVersion,
    changed: false,
    addedDatasets: [],
    removedDatasets: [],
    addedColumns: [],
    removedColumns: [],
    changedColumns: [],
    addedRelationships: [],
    removedRelationships: [],
    invalidatedMetrics: [],
  };
  const prevDatasets = new Map((prev?.datasets ?? []).map((d) => [d.id, d]));
  const nameCount = new Map<string, number>();
  for (const o of discovered.objects) nameCount.set(o.objectName, (nameCount.get(o.objectName) ?? 0) + 1);

  const datasets: CatalogDataset[] = discovered.objects.map((o) => {
    const id = `${o.schemaName}.${o.objectName}`;
    const key = nameCount.get(o.objectName) === 1 ? o.objectName : id;
    const old = prevDatasets.get(id);
    if (!old) {
      diff.addedDatasets.push(id);
      for (const c of o.columns) diff.addedColumns.push({ dataset: id, column: c.name });
      return {
        id,
        key,
        schemaName: o.schemaName,
        objectName: o.objectName,
        kind: o.kind,
        comment: o.comment,
        description: null,
        descriptionStatus: 'none',
        synonyms: [],
        approvalStatus: 'pending',
        primaryKey: o.primaryKey,
        columns: o.columns.map(newColumn),
        metrics: [],
      };
    }
    const oldCols = new Map(old.columns.map((c) => [c.name, c]));
    const touched = new Set<string>();
    const columns = o.columns.map((c): CatalogColumn => {
      const prevCol = oldCols.get(c.name);
      if (!prevCol) {
        diff.addedColumns.push({ dataset: id, column: c.name });
        return newColumn(c);
      }
      if (prevCol.dataType !== c.dataType) {
        diff.changedColumns.push({ dataset: id, column: c.name, from: prevCol.dataType, to: c.dataType });
        touched.add(c.name);
        return { ...prevCol, dataType: c.dataType, typeCategory: typeCategoryOf(c.dataType), nullable: c.nullable, comment: c.comment, isQueryable: false, reviewStatus: 'changed' };
      }
      return { ...prevCol, nullable: c.nullable, comment: c.comment };
    });
    const present = new Set(o.columns.map((c) => c.name));
    for (const c of old.columns) {
      if (!present.has(c.name)) {
        diff.removedColumns.push({ dataset: id, column: c.name });
        touched.add(c.name);
      }
    }
    const metrics = old.metrics.map((m): CatalogMetric => {
      if (m.approvalStatus === 'approved' && metricColumns(m.expression).some((c) => touched.has(c))) {
        diff.invalidatedMetrics.push({ dataset: id, metric: m.key });
        return { ...m, approvalStatus: 'pending' };
      }
      return m;
    });
    return { ...old, key, kind: o.kind, comment: o.comment, primaryKey: o.primaryKey, columns, metrics };
  });
  const present = new Set(datasets.map((d) => d.id));
  for (const id of prevDatasets.keys()) if (!present.has(id)) diff.removedDatasets.push(id);

  // 外鍵關聯：每次以掃描結果為準；人工／推論關聯保留到其兩端仍存在為止
  const prevRels = new Map((prev?.relationships ?? []).map((r) => [r.id, r]));
  const relationships: CatalogRelationship[] = discovered.foreignKeys.map((fk) => {
    const id = fkRelationshipId(fk);
    if (!prevRels.has(id)) diff.addedRelationships.push(id);
    return {
      id,
      from: { dataset: `${fk.from.schemaName}.${fk.from.objectName}`, columns: fk.from.columns },
      to: { dataset: `${fk.to.schemaName}.${fk.to.objectName}`, columns: fk.to.columns },
      origin: 'foreign_key',
      approvalStatus: prevRels.get(id)?.approvalStatus ?? 'approved',
    };
  });
  const fkIds = new Set(relationships.map((r) => r.id));
  const colExists = (ds: string, cols: string[]) => {
    const d = datasets.find((x) => x.id === ds);
    return !!d && cols.every((c) => d.columns.some((x) => x.name === c));
  };
  for (const r of prevRels.values()) {
    if (fkIds.has(r.id)) continue;
    if (r.origin !== 'foreign_key' && colExists(r.from.dataset, r.from.columns) && colExists(r.to.dataset, r.to.columns)) {
      relationships.push(r);
    } else {
      diff.removedRelationships.push(r.id);
    }
  }

  diff.changed =
    !prev ||
    prev.schemaVersion !== discovered.schemaVersion ||
    diff.addedDatasets.length + diff.removedDatasets.length + diff.addedColumns.length + diff.removedColumns.length +
      diff.changedColumns.length + diff.addedRelationships.length + diff.removedRelationships.length > 0;
  diff.toVersion = diff.changed ? fromVersion + 1 : fromVersion;

  const catalog: Catalog = {
    dataSourceId: opts.dataSourceId,
    tenantId: opts.tenantId,
    version: diff.toVersion,
    schemaVersion: discovered.schemaVersion,
    // 重掃只會收緊授權（見檔頭），已發布的 Catalog 維持發布
    published: prev?.published ?? false,
    updatedAt: diff.changed ? now.toISOString() : (prev?.updatedAt ?? now.toISOString()),
    datasets,
    relationships,
  };
  return { catalog, diff };
}
