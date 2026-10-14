import { z } from 'zod';
import { validateMcpUrl } from './mcp.network';
import { MCP_SERVER_ID_RE } from './mcp.types';

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
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => { try { validateMcpUrl(u); return true; } catch { return false; } }, 'MCP URL 不符合連線安全政策'),
  ownerTenantId: z.string().trim().min(1).nullable(),
  description: z.string().trim().max(500),
  keywords: z.array(z.string().trim().min(1).max(20)).max(20),
  timeoutMs: z.number().int().min(1000).max(120_000),
  enabled: z.boolean(),
  toolOverrides: z.record(z.string(), toolOverride),
};

export const createMcpServerSchema = z
  .object({
    id: z.string().regex(MCP_SERVER_ID_RE, 'serverId 只允許小寫英數與連字號、1–32 字'),
    name: fields.name,
    url: fields.url,
    ownerTenantId: fields.ownerTenantId.optional(),
    description: fields.description.optional(),
    keywords: fields.keywords.optional(),
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
    timeoutMs: fields.timeoutMs.optional(),
    enabled: fields.enabled.optional(),
    toolOverrides: fields.toolOverrides.optional(),
  })
  .strict();

export const mcpServerParamSchema = z.object({ serverId: z.string().regex(MCP_SERVER_ID_RE) });

export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type PatchMcpServerInput = z.infer<typeof patchMcpServerSchema>;
