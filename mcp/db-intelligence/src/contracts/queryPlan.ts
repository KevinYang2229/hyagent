/**
 * Query Plan JSON Schema v1（規格書 5.1）。模型只能產生這個結構，不能送 SQL 字串：
 * 識別字一律是 Catalog 名稱（再由 Catalog 對應到 DB 物件），值一律走參數綁定。
 */
import { z } from 'zod';

export const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGGREGATES = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const MAX_JOINS = 3;
export const HARD_MAX_ROWS = 1000;

const name = z.string().min(1).max(128);
const alias = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, '別名只能用小寫英數與底線')
  .describe('輸出欄位名稱（小寫英數與底線）');
const datasetRef = name.optional().describe('欄位所屬資料集（join 進來的資料集才需要填；省略＝主資料集）');

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

const fieldRef = z.object({
  field: name.describe('欄位名稱，或資料集已核准的計算欄位（metric）名稱'),
  dataset: datasetRef,
});

export const selectItemSchema = z
  .object({
    field: name.optional().describe('欄位或計算欄位名稱；agg 為 count 時可省略（＝計算筆數）'),
    dataset: datasetRef,
    agg: z.enum(AGGREGATES).optional().describe('聚合函式'),
    alias: alias.optional(),
  })
  .strict()
  .refine((s) => s.field !== undefined || s.agg === 'count', { message: '只有 count 可以不指定欄位' });

export const filterSchema = z
  .object({
    field: name.describe('欄位或計算欄位名稱'),
    dataset: datasetRef,
    op: z.enum(FILTER_OPS).describe('比較運算子'),
    value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional().describe('比較值；in／not_in 用陣列，is_null／is_not_null 不填'),
  })
  .strict();

export const orderBySchema = z
  .object({
    field: name.describe('欄位、計算欄位，或 select 的輸出名稱'),
    dataset: datasetRef,
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();

export const joinSchema = z
  .object({
    dataset: name.describe('要 join 的資料集名稱，必須與已在查詢中的資料集有已核准的關聯'),
    relationship_id: z.string().optional().describe('有多條關聯時指定使用哪一條'),
    type: z.enum(['inner', 'left']).default('inner'),
  })
  .strict();

export const queryPlanSchema = z
  .object({
    version: z.literal('1.0'),
    data_source_id: z.string().min(1).describe('資料來源 ID（search_schema 回傳）'),
    dataset: name.describe('主資料集名稱'),
    joins: z.array(joinSchema).max(MAX_JOINS).default([]),
    select: z.array(selectItemSchema).min(1).max(30),
    filters: z.array(filterSchema).max(20).default([]),
    group_by: z.array(fieldRef.strict()).max(10).default([]),
    order_by: z.array(orderBySchema).max(5).default([]),
    limit: z.number().int().min(1).max(HARD_MAX_ROWS).default(100),
  })
  .strict();

export type QueryPlan = z.infer<typeof queryPlanSchema>;
export type QueryPlanInput = z.input<typeof queryPlanSchema>;
export type SelectItem = z.infer<typeof selectItemSchema>;
export type Filter = z.infer<typeof filterSchema>;
