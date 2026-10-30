/**
 * 存取政策與可信身分（規格書 6.1 access_policies、7.2）。
 * 預設拒絕：沒有政策涵蓋的資料集、欄位一律不可查；多條政策符合時取聯集（任一政策允許即可）。
 */
import { z } from 'zod';
import { DB_TYPES } from './catalog';

const attrValue = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]);

/** 可信身分：tenantId/userId 來自 HyAgent 簽發的 JWT，角色與屬性由 PrincipalResolver 從可信來源補齊 */
export interface Principal {
  tenantId: string;
  userId: string;
  roles: string[];
  /** 資料列範圍用的屬性，如 departmentId */
  attributes: Record<string, z.infer<typeof attrValue>>;
}

export const accessPolicySchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    dataSourceId: z.string(),
    /** Catalog dataset id（schema.object） */
    dataset: z.string(),
    /** 符合任一 user 或 role 即適用 */
    principals: z.object({ users: z.array(z.string()).default([]), roles: z.array(z.string()).default([]) }).strict(),
    /** 允許的欄位；'*' 只涵蓋 public／internal 欄位，confidential 以上必須逐欄列出 */
    columns: z.array(z.string()).min(1),
    /** 只能出現在 select、且輸出時遮罩的欄位（不可用於篩選、分組、排序，避免推論） */
    masked: z.record(z.enum(['redact', 'partial'])).default({}),
    /** 資料列範圍：欄位 = 可信身分屬性（陣列則為 IN）；多條為 AND */
    rowScope: z.array(z.object({ column: z.string(), attribute: z.string() }).strict()).default([]),
    /** 只允許聚合查詢（不回傳明細列） */
    aggregateOnly: z.boolean().default(false),
    /** 聚合結果每組至少幾筆才輸出（推論攻擊防護） */
    minGroupSize: z.number().int().min(1).optional(),
    maxRows: z.number().int().min(1).optional(),
  })
  .strict();
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export const policySetSchema = z.object({ version: z.string(), policies: z.array(accessPolicySchema) }).strict();
export type PolicySet = z.infer<typeof policySetSchema>;

export const principalDirectorySchema = z.record(
  z.string(),
  z.record(z.string(), z.object({ roles: z.array(z.string()).default([]), attributes: z.record(attrValue).default({}) }).strict()),
);
export type PrincipalDirectory = z.infer<typeof principalDirectorySchema>;

export const dataSourceSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    dbType: z.enum(DB_TYPES),
    /** 允許掃描的 schema */
    schemas: z.array(z.string()).min(1),
    /** 只掃描這些物件（schema.object）；省略＝schema 內全部有 SELECT 權限的物件 */
    includeObjects: z.array(z.string()).optional(),
    /** 存放連線字串的環境變數名稱；設定檔不放密碼 */
    connectionEnv: z.string(),
    timezone: z.string().default('Asia/Taipei'),
  })
  .strict();
export type DataSource = z.infer<typeof dataSourceSchema>;
