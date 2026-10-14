/** 後台 MCP 服務管理（平台管理員）。工具清單只讀快取；「重新整理」才實際連線。 */
import { mcpToolFingerprint } from './mcp.fingerprint';
import type { Request, Response } from 'express';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';
import type { CreateMcpServerInput, PatchMcpServerInput } from './mcp.admin.schema';
import { mcpConnections, type McpServerStatus } from './mcp.connection';
import { isMcpSigningEnabled } from './mcp.identity';
import { mcpStore } from './mcp.store';
import { describeServerTools, type McpToolRow } from './mcp.tool-source';
import type { McpServerConfig } from './mcp.types';

export interface McpServerView {
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolRow[];
}

function view(config: McpServerConfig): McpServerView {
  const conn = mcpConnections.peek(config.id);
  return {
    config,
    status: conn?.status() ?? { state: 'idle' },
    tools: describeServerTools(config, conn?.cachedTools() ?? []),
  };
}

function assertOwnerExists(ownerTenantId: string | null | undefined): void {
  if (ownerTenantId && !tenantStore.getTenant(ownerTenantId)) {
    throw AppError.badRequest(`擁有租戶不存在：${ownerTenantId}`);
  }
}

function serverOr404(id: string): McpServerConfig {
  const config = mcpStore.get(id);
  if (!config) throw AppError.notFound(`MCP server 不存在：${id}`);
  return config;
}

export const mcpAdminController = {
  async list(_req: Request, res: Response): Promise<void> {
    res.json({ data: { signingEnabled: isMcpSigningEnabled(), servers: mcpStore.list().map(view) } });
  },

  async create(req: Request, res: Response): Promise<void> {
    const input = req.body as CreateMcpServerInput;
    assertOwnerExists(input.ownerTenantId);
    if (Object.values(input.toolOverrides ?? {}).some((o) => o.approvedReadOnly)) {
      throw AppError.conflict('請先建立服務並重新整理工具清單，再核准唯讀工具。');
    }
    res.status(201).json({ data: view(mcpStore.create(input)) });
  },

  async update(req: Request, res: Response): Promise<void> {
    const id = String(req.params.serverId);
    const before = serverOr404(id);
    const patch = req.body as PatchMcpServerInput;
    assertOwnerExists(patch.ownerTenantId);
    // Bind every new approval to the currently cached definition. Verify the client fingerprint against the server snapshot.
    if (patch.toolOverrides) {
      const remotes = mcpConnections.peek(id)?.cachedTools() ?? [];
      for (const [name, override] of Object.entries(patch.toolOverrides)) {
        if (override.approvedReadOnly) {
          const remote = remotes.find((t) => t.name === name);
          const previous = before.toolOverrides[name];
          // The UI sends all overrides. Unchanged legacy approvals have no fingerprint;
          // preserve them without granting read access, rather than blocking another tool's approval.
          if (previous?.approvedReadOnly && override.approvedFingerprint === previous.approvedFingerprint) continue;
          if (!remote || (patch.url && patch.url !== before.url) ||
              override.approvedFingerprint !== mcpToolFingerprint(before.url, remote)) {
            throw AppError.conflict('請先重新整理工具清單，再核准唯讀工具。');
          }
          Object.assign(override, { approvedFingerprint: mcpToolFingerprint(before.url, remote) });
        }
      }
    }
    const after = mcpStore.update(id, patch);
    if (after.url !== before.url || after.timeoutMs !== before.timeoutMs) await mcpConnections.drop(id);
    res.json({ data: view(after) });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const id = String(req.params.serverId);
    if (!mcpStore.remove(id)) throw AppError.notFound(`MCP server 不存在：${id}`);
    await mcpConnections.drop(id);
    res.status(204).end();
  },

  /** 測試連線／重新整理工具清單：失敗也回 200，原因在 status。 */
  async refresh(req: Request, res: Response): Promise<void> {
    const config = serverOr404(String(req.params.serverId));
    if (!isMcpSigningEnabled()) throw AppError.badRequest('MCP 簽章金鑰未設定（MCP_SIGNING_KEY），無法連線');
    try {
      await mcpConnections.get(config).listTools({ force: true });
    } catch {
      // 狀態已記在 connection
    }
    res.json({ data: view(config) });
  },
};
