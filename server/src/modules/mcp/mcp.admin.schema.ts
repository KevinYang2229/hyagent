import { z } from 'zod';
import { validateMcpUrl } from './mcp.network';
import { MCP_ROLE_RE, MCP_SERVER_ID_RE } from './mcp.types';

const toolOverride = z
  .object({
    disabled: z.boolean().optional(),
    requireConfirm: z.boolean().optional(),
    approvedReadOnly: z.boolean().optional(),
    approvedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    cardTitle: z.string().trim().max(60).optional(),
  })
  .strict();

const fields = {
  name: z.string().trim().min(1).max(60).describe('顯示名稱，最多 60 字'),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => { try { validateMcpUrl(u); return true; } catch { return false; } }, 'MCP URL 不符合連線安全政策')
    .describe('MCP 服務的 Streamable HTTP 端點，須符合連線安全政策'),
  ownerTenantId: z.string().trim().min(1).nullable().describe('專屬租戶 id；null＝所有租戶共用，有值則只有該租戶看得到、能被授權'),
  description: z.string().trim().max(500).describe('能力描述，AI 依此判斷何時使用這個服務，最多 500 字'),
  keywords: z.array(z.string().trim().min(1).max(20)).max(20).describe('路由關鍵字：使用者訊息命中時直接交給此服務，不必先問 AI；最多 20 個'),
  roles: z.array(z.string().trim().regex(MCP_ROLE_RE, '角色只允許小寫英數、底線與連字號（1–32 字）')).max(20)
    .describe('此服務定義的角色，每個角色會成為可授予的 scope mcp:<serverId>:<role>，由 MCP 服務決定角色能做什麼；開放工具仍需 mcp:<serverId>'),
  timeoutMs: z.number().int().min(1000).max(120_000).describe('單次呼叫逾時（毫秒），1000–120000，預設 20000'),
  enabled: z.boolean().describe('是否啟用；停用後 AI 不會再呼叫此服務'),
  toolOverrides: z.record(z.string(), toolOverride)
    .describe('個別工具的覆寫設定，key 為 MCP 工具名：可停用工具、強制需確認、核准為唯讀、自訂確認卡片標題'),
};

export const createMcpServerSchema = z
  .object({
    id: z.string().regex(MCP_SERVER_ID_RE, 'serverId 只允許小寫英數與連字號、1–32 字').describe('服務代碼（serverId），1–32 個小寫英數字或連字號；建立後不可改，會出現在 scope 名稱中'),
    name: fields.name,
    url: fields.url,
    ownerTenantId: fields.ownerTenantId.optional(),
    description: fields.description.optional(),
    keywords: fields.keywords.optional(),
    roles: fields.roles.optional(),
    timeoutMs: fields.timeoutMs.optional(),
    enabled: fields.enabled.optional(),
    toolOverrides: fields.toolOverrides.optional(),
  })
  .strict();

export const patchMcpServerSchema = z
  .object({
    name: fields.name.optional(),
    url: fields.url.optional(),
    ownerTenantId: fields.ownerTenantId.optional(),
    description: fields.description.optional(),
    keywords: fields.keywords.optional(),
    roles: fields.roles.optional(),
    timeoutMs: fields.timeoutMs.optional(),
    enabled: fields.enabled.optional(),
    toolOverrides: fields.toolOverrides.optional(),
  })
  .strict();

export const mcpServerParamSchema = z.object({ serverId: z.string().regex(MCP_SERVER_ID_RE) });

export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type PatchMcpServerInput = z.infer<typeof patchMcpServerSchema>;
