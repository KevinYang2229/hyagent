/**
 * 認證 service（MVP）：固定 dev 密碼驗證 + 簽發 access/refresh token。
 *
 * 驗證邏輯刻意獨立成一段（verifyCredentials），之後接真實使用者/密碼來源
 * （DB、SSO、LDAP…）只要換掉這段，token 簽發與 refresh 流程不動。
 */
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { securityClaims } from '@/lib/security-claims';
import { credentialVersion, validateIdentity } from './credential-version';
import type { Applicant } from '@hyagent/shared';
import { env } from '@/config/env';
import { getApplicant, isKnownUser } from '@/modules/user/user.directory';
import type { Tenant } from '@/modules/tenant/tenant.types';
import { AppError } from '@/utils/app-error';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type JwtPayload,
} from '@/utils/jwt';

/** 宿主後端簽發的終端使用者 token 內容（以租戶 ssoSecret 簽章） */
interface SsoClaims {
  exp?: number;
  iat?: number;
  sub?: string | number;
  name?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  user: Applicant;
}

function issueTokens(payload: JwtPayload): AuthTokens {
  payload = { ...payload, family: payload.family ?? randomUUID() };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

export const authService = {
  /** 帳密驗證 → 簽發 access/refresh token 與使用者資料 */
  login(userId: string, password: string): LoginResult {
    if (env.NODE_ENV === 'production') throw AppError.forbidden('正式環境請使用 SSO 登入');
    // MVP：已知帳號 + 固定 dev 密碼。錯誤訊息不分帳號/密碼以免帳號列舉。
    if (!isKnownUser(userId) || password !== env.AUTH_DEV_PASSWORD) {
      throw AppError.unauthorized('帳號或密碼錯誤');
    }
    const payload: JwtPayload = { sub: userId, role: 'employee', via: 'password', tenantId: 'default' };
    return { ...issueTokens(payload), user: getApplicant(userId) };
  },

  /**
   * SSO handoff：宿主後端以租戶 ssoSecret 簽發的終端使用者 token → 換發本系統 token。
   * 讓第三方網站的使用者免內部帳密即可使用 widget，身分取自宿主（取代 demo-user）。
   */
  ssoExchange(tenant: Tenant, userToken: string): AuthTokens {
    if (!tenant.ssoSecret) throw AppError.forbidden('此租戶未啟用 SSO');
    let claims: SsoClaims;
    try {
      claims = jwt.verify(userToken, tenant.ssoSecret, { algorithms: ['HS256'], issuer: 'hyagent:handoff', audience: 'hyagent:sso', maxAge: '5m' }) as SsoClaims;
    } catch {
      throw AppError.unauthorized('SSO user token 無效或已過期');
    }
    if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || claims.exp - claims.iat > 300 || claims.iat > Math.floor(Date.now() / 1000)) {
      throw AppError.unauthorized('SSO token 必須有不超過 5 分鐘的有效期限');
    }
    if (typeof claims.sub !== 'string' && typeof claims.sub !== 'number') throw AppError.unauthorized('SSO token 缺少 sub');
    if (claims.name !== undefined && typeof claims.name !== 'string') throw AppError.unauthorized('SSO name 無效');
    const sub = String(claims.sub).trim();
    if (!sub) throw AppError.unauthorized('SSO token 缺少 sub');
    return issueTokens({
      sub,
      role: 'employee',
      credentialVersion: credentialVersion(tenant),
      via: 'sso',
      tenantId: tenant.id,
      name: claims.name,
    });
  },

  /** 用 refresh token 換新的 access/refresh（輪替） */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtPayload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw AppError.unauthorized('Invalid or expired refresh token');
    }
    await validateIdentity(payload);
    if (!payload.jti || !payload.family || await securityClaims.has(`refresh-revoked:${payload.family}`)) {
      throw AppError.unauthorized('Refresh session revoked');
    }
    if (!await securityClaims.claim(`refresh-used:${payload.jti}`)) {
      await securityClaims.claim(`refresh-revoked:${payload.family}`);
      throw AppError.unauthorized('Refresh token reuse detected');
    }
    // Preserve the family so replay revokes all descendants.

    if (payload.via === 'sso') {
      return issueTokens({
        sub: payload.sub,
        role: 'employee',
        family: payload.family,
        credentialVersion: payload.credentialVersion,
        via: 'sso',
        tenantId: payload.tenantId,
        name: payload.name,
      });
    }
    // 內部帳號：重新簽發前確認帳號仍有效
    if (!isKnownUser(payload.sub)) throw AppError.unauthorized('Unknown user');
    return issueTokens({ sub: payload.sub, role: 'employee', via: 'password', tenantId: 'default', family: payload.family });
  },

  /** 取目前登入者資料（requireAuth 後使用） */
  me(userId: string, tenantId = 'default'): Applicant {
    return getApplicant(userId, tenantId);
  },
};
