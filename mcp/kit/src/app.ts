/** 無狀態 Streamable HTTP MCP app：每個請求新建 server + transport，前面掛 HyAgent 驗證。 */
import express, { type Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireHyAgent } from './middleware';
import type { HyAgentVerifier } from './verify';

export interface McpHttpAppOptions {
  name: string;
  version: string;
  verifier: HyAgentVerifier;
  /** 在這裡 server.registerTool(...)；每個請求都會呼叫一次 */
  register(server: McpServer): void;
}

export function createMcpHttpApp(opts: McpHttpAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/mcp', requireHyAgent(opts.verifier), async (req, res) => {
    try {
      const server = new McpServer({ name: opts.name, version: opts.version });
      opts.register(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      // Express 4 不接 async 拒絕；不外洩錯誤訊息
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });
  return app;
}
