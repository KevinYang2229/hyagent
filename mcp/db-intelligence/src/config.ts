/**
 * 服務設定（資料來源、存取政策、使用者角色／屬性）。MVP 以 JSON 檔提供，之後由 Admin API 管理。
 * 設定檔不放 DB 密碼：每個資料來源指定一個環境變數名稱存連線字串（由客戶 Secret Manager 注入）。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { dataSourceSchema, policySetSchema, principalDirectorySchema } from './contracts/policy';

export const configSchema = z
  .object({
    dataSources: z.array(dataSourceSchema),
    policies: policySetSchema,
    principals: principalDirectorySchema.default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const d of c.dataSources) {
      if (ids.has(d.id)) ctx.addIssue({ code: 'custom', message: `資料來源 ${d.id} 重複` });
      ids.add(d.id);
    }
    for (const p of c.policies.policies) {
      const ds = c.dataSources.find((d) => d.id === p.dataSourceId);
      if (!ds || ds.tenantId !== p.tenantId) ctx.addIssue({ code: 'custom', message: `政策 ${p.id} 的資料來源不存在或租戶不符` });
    }
  });
export type DbiConfig = z.infer<typeof configSchema>;

export function loadConfig(file: string): DbiConfig {
  return configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function connectionString(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`環境變數 ${name} 未設定（資料來源連線字串）`);
  return v;
}
