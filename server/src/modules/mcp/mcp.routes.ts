/** MCP 公開路由：JWKS（MCP server 驗呼叫 JWT 用），不需登入。 */
import { Router } from 'express';
import { mcpJwks } from './mcp.identity';

export const mcpPublicRouter = Router();

mcpPublicRouter.get('/.well-known/hyagent-mcp-jwks.json', (_req, res) => {
  const jwks = mcpJwks();
  if (jwks.keys.length === 0) {
    res.status(404).json({ error: { code: 'MCP_DISABLED', message: 'MCP 簽章未啟用' } });
    return;
  }
  res.set('Cache-Control', 'public, max-age=300').json(jwks);
});
