/**
 * Metadata Catalog 契約（規格書 6）。Catalog 以 zod 定義，從檔案或 Admin API 載入時一律重新驗證。
 * DB 原始註解（comment）是不可信資料：只供管理員審核，不會交給模型；模型只看得到核准過的 description。
 */
import { z } from 'zod';

/** 掃描結果（Connector 產出）：只有結構，不含任何資料列 */
export interface DiscoveredColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  ordinal: number;
  comment: string | null;
}

export interface DiscoveredObject {
  schemaName: string;
  objectName: string;
  kind: DatasetKind;
  comment: string | null;
  columns: DiscoveredColumn[];
  primaryKey: string[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
}

export interface DiscoveredForeignKey {
  name: string;
  from: { schemaName: string; objectName: string; columns: string[] };
  to: { schemaName: string; objectName: string; columns: string[] };
}

/** 支援的資料庫：mariadb 與 mysql 共用同一套轉接（差異在逾時語法等少數地方） */
export const DB_TYPES = ['postgres', 'mariadb', 'mysql'] as const;
export type DbType = (typeof DB_TYPES)[number];

export interface DiscoveredSchema {
  dbType: DbType;
  schemas: string[];
  objects: DiscoveredObject[];
  foreignKeys: DiscoveredForeignKey[];
  /** 結構內容的 sha256，相同結構相同值 */
  schemaVersion: string;
}

export const DATASET_KINDS = ['table', 'view', 'materialized_view'] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

/** 查詢時的型別分類，決定可用運算子與聚合 */
export const TYPE_CATEGORIES = ['numeric', 'text', 'boolean', 'date', 'timestamp', 'uuid', 'other'] as const;
export type TypeCategory = (typeof TYPE_CATEGORIES)[number];

/** 由寬到嚴；confidential 以上不會被 columns: ['*'] 涵蓋，必須在政策中逐欄列出 */
export const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
/** 敏感欄位：政策明確開放時須確認、查詢稽核會標記 */
export const SENSITIVE_LEVELS: ReadonlySet<Sensitivity> = new Set(['confidential', 'restricted']);
/** 聚合「限制」欄位時每組最少筆數（政策的 minGroupSize 較大時以政策為準） */
export const RESTRICTED_MIN_GROUP_SIZE = 3;
/** 「限制」欄位可用的聚合；最大／最小值會直接得到某一筆的確切數值，不在其中 */
export const RESTRICTED_AGGREGATES: readonly string[] = ['count', 'count_distinct', 'sum', 'avg'];

const approvalStatus = z.enum(['pending', 'approved', 'rejected']);
const descriptionStatus = z.enum(['none', 'suggested', 'approved']);
const identifier = z.string().min(1).max(63);

export const columnSchema = z.object({
  name: identifier,
  dataType: z.string(),
  typeCategory: z.enum(TYPE_CATEGORIES),
  nullable: z.boolean(),
  /** DB 原始註解：不可信，只給管理員看 */
  comment: z.string().nullable(),
  description: z.string().nullable(),
  descriptionStatus,
  synonyms: z.array(z.string()),
  sensitivity: z.enum(SENSITIVITIES),
  isQueryable: z.boolean(),
  /** new：新掃到；changed：型別變更；reviewed：管理員審過 */
  reviewStatus: z.enum(['new', 'changed', 'reviewed']),
});
export type CatalogColumn = z.infer<typeof columnSchema>;

/** 核准指標的運算式：只能引用同資料集欄位、數字與四則運算，由編譯器轉成 SQL */
export type MetricExpr =
  | { column: string }
  | { number: number }
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: [MetricExpr, MetricExpr] };

export const metricExprSchema: z.ZodType<MetricExpr> = z.lazy(() =>
  z.union([
    z.object({ column: identifier }).strict(),
    z.object({ number: z.number().finite() }).strict(),
    z.object({ op: z.enum(['add', 'sub', 'mul', 'div']), args: z.tuple([metricExprSchema, metricExprSchema]) }).strict(),
  ]),
);

export const metricSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  description: z.string(),
  synonyms: z.array(z.string()),
  expression: metricExprSchema,
  approvalStatus,
});
export type CatalogMetric = z.infer<typeof metricSchema>;

export const datasetSchema = z.object({
  /** `${schemaName}.${objectName}`，Catalog 內唯一 */
  id: z.string(),
  /** Query Plan 使用的名稱：物件名稱在掃描範圍內唯一時為物件名稱，否則為 id */
  key: z.string(),
  schemaName: identifier,
  objectName: identifier,
  kind: z.enum(DATASET_KINDS),
  comment: z.string().nullable(),
  description: z.string().nullable(),
  descriptionStatus,
  synonyms: z.array(z.string()),
  approvalStatus,
  primaryKey: z.array(z.string()),
  columns: z.array(columnSchema),
  metrics: z.array(metricSchema),
});
export type CatalogDataset = z.infer<typeof datasetSchema>;

const relationshipEnd = z.object({ dataset: z.string(), columns: z.array(identifier).min(1) });

export const relationshipSchema = z.object({
  id: z.string(),
  from: relationshipEnd,
  to: relationshipEnd,
  /** foreign_key：DB 外鍵（自動核准）；inferred／manual：需人工核准 */
  origin: z.enum(['foreign_key', 'inferred', 'manual']),
  approvalStatus,
});
export type CatalogRelationship = z.infer<typeof relationshipSchema>;

export const catalogSchema = z.object({
  dataSourceId: z.string(),
  tenantId: z.string(),
  /** 每次結構或審核內容變更 +1 */
  version: z.number().int().nonnegative(),
  schemaVersion: z.string(),
  /** 已發布才可查詢；發布後的修改要重新發布 */
  published: z.boolean(),
  updatedAt: z.string(),
  datasets: z.array(datasetSchema),
  relationships: z.array(relationshipSchema),
});
export type Catalog = z.infer<typeof catalogSchema>;

export interface CatalogDiff {
  fromVersion: number;
  toVersion: number;
  changed: boolean;
  addedDatasets: string[];
  removedDatasets: string[];
  addedColumns: { dataset: string; column: string }[];
  removedColumns: { dataset: string; column: string }[];
  changedColumns: { dataset: string; column: string; from: string; to: string }[];
  addedRelationships: string[];
  removedRelationships: string[];
  /** 引用欄位被移除或變更而退回待審的指標 */
  invalidatedMetrics: { dataset: string; metric: string }[];
}

/** 資料庫型別字串 → 型別分類（依資料庫種類） */
export function typeCategoryOf(dataType: string, dbType: DbType = 'postgres'): TypeCategory {
  return dbType === 'postgres' ? postgresTypeCategory(dataType) : mysqlTypeCategory(dataType);
}

/**
 * MariaDB／MySQL 的 COLUMN_TYPE（如 int(11)、decimal(10,1)、varchar(100)、enum('a','b')）→ 型別分類。
 * tinyint(1) 常被當布林用，但無法確定，一律當數值；JSON 在 MariaDB 是 longtext 別名，會落在 text。
 */
export function mysqlTypeCategory(columnType: string): TypeCategory {
  const t = columnType.toLowerCase().trim();
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|dec|fixed|float|double|real|year)\b/.test(t)) return 'numeric';
  if (/^(char|varchar|tinytext|text|mediumtext|longtext|enum)\b/.test(t)) return 'text';
  if (t === 'date') return 'date';
  if (/^(datetime|timestamp)\b/.test(t)) return 'timestamp';
  if (t === 'uuid') return 'uuid';
  return 'other';
}

/** PostgreSQL format_type() 結果 → 型別分類 */
export function postgresTypeCategory(dataType: string): TypeCategory {
  const t = dataType.toLowerCase();
  if (t.endsWith('[]')) return 'other';
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision)\b/.test(t)) return 'numeric';
  if (/^(text|character varying|character|varchar|char|citext)\b/.test(t)) return 'text';
  if (t === 'boolean') return 'boolean';
  if (t === 'date') return 'date';
  if (/^timestamp\b/.test(t)) return 'timestamp';
  if (t === 'uuid') return 'uuid';
  return 'other';
}
