/**
 * MCP 工具來源：把「此租戶可見、此使用者有 mcp:<serverId>」的 server 工具轉成 ToolDef。
 * 讀寫判定：覆寫 requireConfirm → write；readOnlyHint=true → read；其餘一律 write（安全預設）。
 * ToolDef 依（server 設定版本, 工具清單抓取時間）快取，避免每次 invoke 重編 Ajv。
 */
import { logger } from '@/lib/logger';
import type { ToolContext, ToolDef, ToolEffect, ToolSource } from '@/modules/tools/tool.types';
import { mcpConnections, type McpConnection, type McpRemoteTool } from './mcp.connection';
import { isMcpSigningEnabled } from './mcp.identity';
import { mcpStore } from './mcp.store';
import type { McpServerConfig, McpToolOverride } from './mcp.types';

/** Anthropic 上限 128、OpenAI 上限 64，取交集。 */
export const LLM_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function mcpScopeId(serverId: string): string {
  return `mcp:${serverId}`;
}

export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`;
}

export function mcpLlmName(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`;
}

export function effectForTool(remote: McpRemoteTool, override?: McpToolOverride): ToolEffect {
  if (override?.requireConfirm) return 'write';
  return remote.annotations?.readOnlyHint === true ? 'read' : 'write';
}

export type McpToolProblem = 'name_invalid';

export function toolProblem(serverId: string, remote: McpRemoteTool): McpToolProblem | undefined {
  return TOOL_NAME_RE.test(remote.name) && LLM_TOOL_NAME_RE.test(mcpLlmName(serverId, remote.name)) ? undefined : 'name_invalid';
}

/** 移除 $schema / $id：避免 Ajv 因 meta-schema 版本或 id 重複而編譯失敗。 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return { type: 'object', ...rest };
}

const warned = new Set<string>();

export function toToolDef(
  config: McpServerConfig,
  remote: McpRemoteTool,
  conn: Pick<McpConnection, 'callTool'>,
): ToolDef | undefined {
  const override = config.toolOverrides[remote.name];
  if (override?.disabled) return undefined;
  if (toolProblem(config.id, remote)) {
    const key = `${config.id}/${remote.name}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn({ serverId: config.id, tool: remote.name }, 'mcp tool name invalid for LLM; not exposed');
    }
    return undefined;
  }
  return {
    id: mcpToolId(config.id, remote.name),
    description: remote.description ?? remote.title ?? remote.name,
    confirmTitle: override?.cardTitle ?? remote.title,
    inputSchema: normalizeSchema(remote.inputSchema),
    scopes: [mcpScopeId(config.id)],
    agentExposed: true,
    effect: effectForTool(remote, override),
    audit: true,
    auditSummary: () => `${config.name}｜${remote.title ?? remote.name}`,
    handler: (input, ctx) =>
      conn.callTool(remote.name, input as Record<string, unknown>, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        scopes: ctx.scopes,
      }),
  };
}

export interface McpToolRow {
  name: string;
  title?: string;
  llmName: string;
  effect: ToolEffect;
  disabled: boolean;
  problem?: McpToolProblem;
}

/** 後台用：列出 server 的工具與判定結果。 */
export function describeServerTools(config: McpServerConfig, remotes: McpRemoteTool[]): McpToolRow[] {
  return remotes.map((r) => {
    const override = config.toolOverrides[r.name];
    const problem = toolProblem(config.id, r);
    return {
      name: r.name,
      title: r.title,
      llmName: mcpLlmName(config.id, r.name),
      effect: effectForTool(r, override),
      disabled: override?.disabled === true,
      ...(problem ? { problem } : {}),
    };
  });
}

/** 此 ctx 可用的 server：簽章已啟用、租戶可見、使用者有 mcp:<id>。 */
function usableServers(ctx: ToolContext): McpServerConfig[] {
  if (!isMcpSigningEnabled()) return [];
  return mcpStore.listVisibleTo(ctx.tenantId).filter((c) => ctx.scopes.includes(mcpScopeId(c.id)));
}

const defCache = new Map<string, { stamp: string; defs: ToolDef[] }>();

export const mcpToolSource: ToolSource = {
  id: 'mcp',

  async prepare(ctx) {
    await Promise.all(
      usableServers(ctx).map(async (config) => {
        try {
          await mcpConnections.get(config).listTools();
        } catch {
          // 狀態已記在 connection（unreachable / auth_failed），工具暫不暴露
        }
      }),
    );
  },

  toolsFor(ctx) {
    const out: ToolDef[] = [];
    for (const config of usableServers(ctx)) {
      const conn = mcpConnections.get(config);
      const remotes = conn.cachedTools();
      if (!remotes) continue;
      const stamp = `${config.updatedAt ?? config.createdAt}|${conn.status().toolsFetchedAt ?? ''}`;
      let cached = defCache.get(config.id);
      if (!cached || cached.stamp !== stamp) {
        const defs = remotes
          .map((r) => toToolDef(config, r, conn))
          .filter((d): d is ToolDef => d !== undefined);
        cached = { stamp, defs };
        defCache.set(config.id, cached);
      }
      out.push(...cached.defs);
    }
    return out;
  },
};
