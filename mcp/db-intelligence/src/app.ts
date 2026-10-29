/**
 * Database Intelligence MCP app：以 kit 的無狀態 HTTP app 為基礎，用低階 Server API 提供原始 JSON Schema，
 * 參數由我們自己驗證（格式錯誤的 query_plan 也要進到 Validator 留下稽核）。
 */
import type { Express } from 'express';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callerFrom, createMcpHttpApp, type HyAgentVerifier } from '@hyagent/mcp-kit';
import { createAdminRouter, type AdminRouterOptions } from './admin';
import type { DbIntelligenceService } from './service';
import { callDbiTool, DBI_TOOLS, toolJsonSchema } from './tools';

export interface DbIntelligenceAppOptions {
  verifier: HyAgentVerifier;
  service: DbIntelligenceService;
  /** 提供時掛上 /admin 管理 API（驗證沿用同一個 verifier） */
  admin?: Omit<AdminRouterOptions, 'verifier'>;
}

export function createDbIntelligenceApp(opts: DbIntelligenceAppOptions): Express {
  const tools = DBI_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: toolJsonSchema(t),
    annotations: { readOnlyHint: true },
  }));
  const app = createMcpHttpApp({
    name: 'db-intelligence',
    version: '0.1.0',
    verifier: opts.verifier,
    register(server) {
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
        const r = await callDbiTool(opts.service, req.params.name, req.params.arguments, callerFrom(extra));
        return {
          ...(r.isError ? { isError: true } : {}),
          content: [{ type: 'text', text: r.text }],
          ...(r.structuredContent && !r.isError ? { structuredContent: r.structuredContent } : {}),
        };
      });
    },
  });
  if (opts.admin) app.use('/admin', createAdminRouter({ ...opts.admin, verifier: opts.verifier }));
  return app;
}
