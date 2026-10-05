/**
 * 執行：HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
 *       MCP_SERVER_ID=store-demo PUBLIC_BASE_URL=http://localhost:4200 PORT=4200 npm start -w mcp/store-demo
 */
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp } from './app';

const rawPort = process.env.PORT?.trim() || '4200';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必須是 1～65535 的整數；Zeabur 請設定 PORT=4200');
}
const { app } = createStoreDemoApp({
  verifier: createHyAgentVerifier({
    jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
    audience: process.env.MCP_SERVER_ID ?? 'store-demo',
    rejectReplay: true,
  }),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
});
app.listen(port, () => console.log(`store-demo MCP server on http://localhost:${port}/mcp`));
