/**
 * MCP 呼叫身分：後端每個 HTTP 請求簽一張短效 ES256 JWT，MCP server 以 JWKS 驗章。
 *
 * 與 SSO 的 Identity Assertion 方向相反：這裡是 HyAgent 簽、MCP server 驗，故私鑰在 HyAgent。
 * 簽章重用 lib/assertion 的 JOSE 工具（ES256 需 ieee-p1363 格式）。
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { env } from '@/config/env';
import { ALGORITHMS, encodeJson, keyArg } from '@/lib/assertion/jose';
import { computeKid, detectAlgorithm, exportPublicJwk } from '@/lib/assertion/keygen';

export const MCP_TOKEN_ISSUER = 'hyagent';
export const MCP_TOKEN_LIFETIME_SECONDS = 60;
export const MCP_SYSTEM_SUBJECT = 'hyagent-system';

export interface McpCaller {
  tenantId: string;
  userId: string;
  scopes: string[];
}

interface SigningKey {
  privateKey: KeyObject;
  kid: string;
  jwks: Record<string, unknown>[];
}

/** undefined＝尚未載入；null＝未設定（停用） */
let loaded: SigningKey | null | undefined;

function unescapePem(pem: string): string {
  return pem.replace(/\\n/g, '\n');
}

function publicJwk(key: KeyObject): Record<string, unknown> {
  return { ...exportPublicJwk(key), kid: computeKid(key), alg: 'ES256', use: 'sig' };
}

function load(pem: string, previousPublicPem: string): SigningKey | null {
  if (!pem.trim()) return null;
  const privateKey = createPrivateKey(unescapePem(pem));
  const publicKey = createPublicKey(privateKey);
  if (detectAlgorithm(publicKey) !== 'ES256') throw new Error('MCP_SIGNING_KEY 必須是 EC P-256（ES256）私鑰');
  const jwks = [publicJwk(publicKey)];
  if (previousPublicPem.trim()) jwks.push(publicJwk(createPublicKey(unescapePem(previousPublicPem))));
  return { privateKey, kid: computeKid(publicKey), jwks };
}

function signingKey(): SigningKey | null {
  if (loaded === undefined) loaded = load(env.MCP_SIGNING_KEY, env.MCP_PREVIOUS_PUBLIC_KEY);
  return loaded;
}

/** 測試用：注入私鑰；null 改回讀環境變數。 */
export function configureMcpSigningKey(pem: string | null): void {
  loaded = pem === null ? undefined : load(pem, '');
}

export function isMcpSigningEnabled(): boolean {
  return signingKey() !== null;
}

export function signMcpToken(serverId: string, caller: McpCaller | 'system', nowMs = Date.now()): string {
  const key = signingKey();
  if (!key) throw new Error('MCP 簽章金鑰未設定（MCP_SIGNING_KEY）');
  const iat = Math.floor(nowMs / 1000);
  const base = { iss: MCP_TOKEN_ISSUER, aud: serverId, iat, exp: iat + MCP_TOKEN_LIFETIME_SECONDS, jti: randomUUID() };
  const own = `mcp:${serverId}`;
  const payload =
    caller === 'system'
      ? { ...base, sub: MCP_SYSTEM_SUBJECT, scopes: [] as string[] }
      : {
          ...base,
          sub: caller.userId,
          tenant: caller.tenantId,
          // 只帶與本 server 有關的 scope：其他權限不是 MCP server 該知道的事
          scopes: caller.scopes.filter((s) => s === own || s.startsWith(`${own}:`)),
        };
  const signingInput = `${encodeJson({ alg: 'ES256', typ: 'JWT', kid: key.kid })}.${encodeJson(payload)}`;
  const signature = sign(ALGORITHMS.ES256.hash, Buffer.from(signingInput), keyArg(key.privateKey, ALGORITHMS.ES256));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function mcpJwks(): { keys: Record<string, unknown>[] } {
  return { keys: signingKey()?.jwks ?? [] };
}
