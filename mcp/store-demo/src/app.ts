/**
 * 門市 Demo MCP app：以 kit 的無狀態 HTTP app 為基礎，改用低階 Server API 提供原始 JSON Schema
 * （McpServer.registerTool 的 zod 寫法無法表達 readOnly、x-unit 等關鍵字），並公開商品圖片。
 */
import express, { type Express } from 'express';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callerFrom, createMcpHttpApp, type HyAgentVerifier } from '@hyagent/mcp-kit';
import { ASSETS_DIR, scanImages } from './data';
import { callStoreTool, createStoreState, STORE_TOOLS, type StoreState } from './tools';

export interface StoreDemoOptions {
  verifier: HyAgentVerifier;
  /** 對外網址（組商品圖片 URL 用），如 https://store-demo.example.com */
  publicBaseUrl: string;
  now?: () => Date;
}

export function createStoreDemoApp(opts: StoreDemoOptions): { app: Express; store: StoreState } {
  const store = createStoreState();
  const images = scanImages();
  const now = opts.now ?? (() => new Date());
  const app = createMcpHttpApp({
    name: 'store-demo',
    version: '0.1.0',
    verifier: opts.verifier,
    register(server) {
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: STORE_TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, object> },
          annotations: t.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false },
        })),
      }));
      server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
        const caller = callerFrom(extra);
        const r = callStoreTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
          now,
          publicBaseUrl: opts.publicBaseUrl,
          imageIds: images,
          caller,
          state: store,
        });
        if (r.isError) return { isError: true, content: [{ type: 'text', text: r.text ?? '執行失敗' }] };
        return {
          content: [{ type: 'text', text: JSON.stringify(r.structuredContent ?? {}) }],
          structuredContent: r.structuredContent,
          ...(r.display ? { _meta: { 'hyagent/display': r.display } } : {}),
        };
      });
    },
  });
  app.use('/assets', express.static(ASSETS_DIR, { maxAge: '1h' }));
  return { app, store };
}
