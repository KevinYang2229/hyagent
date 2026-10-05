/**
 * 執行：HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
 *       MCP_SERVER_ID=store-demo PUBLIC_BASE_URL=http://localhost:4200 PORT=4200 npm start -w mcp/store-demo
 */
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp } from './app';

const port = Number(process.env.PORT ?? 4200);
const { app } = createStoreDemoApp({
  verifier: createHyAgentVerifier({
    jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
    audience: process.env.MCP_SERVER_ID ?? 'store-demo',
    rejectReplay: true,
  }),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
});
app.listen(port, () => console.log(`store-demo MCP server on http://localhost:${port}/mcp`));
