import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '@/config/env';

export interface JwtPayload {
  sub: string;
  role: string;
  /** 簽發來源：password＝內部帳密登入；sso＝租戶 SSO handoff。影響 refresh 時是否查內部名錄 */
  via?: 'password' | 'sso';
  /** SSO 簽發時帶入的所屬租戶 */
  tenantId?: string;
  /** SSO 簽發時帶入的終端使用者顯示名（終端使用者不在內部名錄） */
  name?: string;
  credentialVersion?: string;
  family?: string;
  jti?: string;
  exp?: number;
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, tenantId: payload.tenantId ?? 'default' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256', issuer: 'hyagent', audience: 'hyagent:user',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as SignOptions);
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, tenantId: payload.tenantId ?? 'default', jti: randomUUID() }, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256', issuer: 'hyagent', audience: 'hyagent:refresh',
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as SignOptions);
}

/** 後台管理 token：role=admin，效期較長（8h）。使用獨立 audience，使用者 token 不可通過管理端驗證。 */
export function signAdminToken(): string {
  return jwt.sign({ sub: 'admin', role: 'admin', via: 'password' } satisfies JwtPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: '8h', algorithm: 'HS256', issuer: 'hyagent', audience: 'hyagent:admin',
  } as SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'hyagent', audience: 'hyagent:user' }) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'], issuer: 'hyagent', audience: 'hyagent:refresh' }) as JwtPayload;
}

export function verifyAdminToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'], issuer: 'hyagent', audience: 'hyagent:admin',
  }) as JwtPayload;
}
