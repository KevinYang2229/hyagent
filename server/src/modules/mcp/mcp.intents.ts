/** agent 服務的 MCP 段落：路由意圖（關鍵字 + 分類器描述）與系統提示詞。只列使用者有權限的 server。 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import type { IntentDescriptor } from '@/modules/conversation/agent-service.types';
import { isMcpSigningEnabled } from './mcp.identity';
import { mcpStore } from './mcp.store';
import { mcpScopeId } from './mcp.tool-source';
import type { McpServerConfig } from './mcp.types';

function usableFor(tenantId: string, userId: string): McpServerConfig[] {
  if (!isMcpSigningEnabled()) return [];
  const scopes = new Set(resolveScopes({ tenantId, userId }));
  return mcpStore.listVisibleTo(tenantId).filter((c) => scopes.has(mcpScopeId(c.id)));
}

export function mcpIntentsFor(tenantId: string, userId: string): IntentDescriptor[] {
  return usableFor(tenantId, userId).map((c) => ({
    id: `agent.mcp.${c.id}`,
    keywords: c.keywords,
    description: c.description || c.name,
  }));
}

export function mcpPromptLines(tenantId: string, userId: string): string[] {
  const servers = usableFor(tenantId, userId);
  if (servers.length === 0) return [];
  return ['已連接的外部服務（透過工具使用）：', ...servers.map((c) => `- ${c.name}：${c.description || '（未提供描述）'}`)];
}
