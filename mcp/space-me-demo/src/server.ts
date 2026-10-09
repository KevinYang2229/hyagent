import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createSpaceMeDemoApp } from './app';

const rawPort = process.env.PORT?.trim() || '4300';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必須是 1～65535 的整數');
const app = createSpaceMeDemoApp({ verifier: createHyAgentVerifier({
  jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
  audience: process.env.MCP_SERVER_ID ?? 'space-me-demo', rejectReplay: true,
}) });
app.listen(port, () => console.log(`SpaceMe 示範 MCP：http://localhost:${port}/mcp（非真實場域資料）`));
