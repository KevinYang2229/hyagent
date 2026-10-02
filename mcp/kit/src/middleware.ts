/** Express middleware：驗 Bearer JWT，把呼叫者放進 req.auth，MCP SDK 會轉成工具 handler 的 extra.authInfo。 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { HyAgentAuthError, type HyAgentCaller, type HyAgentVerifier } from './verify';

export function requireHyAgent(verifier: HyAgentVerifier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    try {
      const caller = await verifier.verify(token);
      (req as Request & { auth?: AuthInfo }).auth = { token, clientId: 'hyagent', scopes: caller.scopes, extra: { caller } };
      next();
    } catch (err) {
      res.status(401).json({ error: err instanceof HyAgentAuthError ? err.reason : 'verify_failed' });
    }
  };
}

/** 工具 handler 內取得呼叫者：`const caller = callerFrom(extra)`。 */
export function callerFrom(extra: { authInfo?: AuthInfo }): HyAgentCaller {
  const caller = extra.authInfo?.extra?.caller as HyAgentCaller | undefined;
  if (!caller) throw new HyAgentAuthError('no_caller');
  return caller;
}
