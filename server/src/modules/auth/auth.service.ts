/**
 * 認證 service：帳密登入路徑（access / refresh JWT）。
 *
 * **Widget 的 SSO 路徑已不在這裡**——它改走 Identity Assertion → HyAgent Session
 * （`assertion-exchange.ts` + `lib/auth-session.store.ts`），規格 §7.1 明文禁止
 * self-contained JWT。連帶地，SSO 路徑上的 refresh 輪替、`family` 家族撤銷與 reuse
 * detection 整套移除：規格 §7.1 的續期是「到期前 60 秒重走 token provider」，
 * 不存在 refresh token。本檔保留的那套只服務帳密登入（決策 G）。
 */
import { randomUUID } from 'node:crypto';
import { securityClaims } from '@/lib/security-claims';
import { validateIdentity } from './credential-version';
import type { Applicant } from '@hyagent/shared';
import { env, isPasswordLoginEnabled } from '@/config/env';
import { getApplicant, isKnownUser } from '@/modules/user/user.directory';
import { AppError } from '@/utils/app-error';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type JwtPayload,
} from '@/utils/jwt';

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
  /**
   * 帳密驗證 → 簽發 access/refresh token 與使用者資料。
   *
   * tenantId 來自呼叫端帶的 API Key（未帶則 default）。token 必須綁在同一個租戶上：
   * requireAuth 會擋掉「token 租戶 ≠ API Key 租戶」，簽成 default 的話嵌入式 widget
   * 登入會成功、之後每一支 API 卻都 401。
   */
  login(userId: string, password: string, tenantId = 'default'): LoginResult {
    if (!isPasswordLoginEnabled()) throw AppError.forbidden('此環境未開放帳密登入，請使用 SSO 登入');
    // MVP：租戶目錄內的帳號 + 共用密碼。錯誤訊息不分帳號/密碼以免帳號列舉。
    if (!isKnownUser(userId, tenantId) || password !== env.AUTH_DEV_PASSWORD) {
      throw AppError.unauthorized('帳號或密碼錯誤');
    }
    const payload: JwtPayload = { sub: userId, role: 'employee', via: 'password', tenantId };
    return { ...issueTokens(payload), user: getApplicant(userId, tenantId) };
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

    // 只剩帳密登入會走到這裡：SSO 已改為 Session 模型，不簽發 refresh token。
    // 內部帳號：重新簽發前確認帳號仍有效
    if (!isKnownUser(payload.sub, payload.tenantId)) throw AppError.unauthorized('Unknown user');
    return issueTokens({ sub: payload.sub, role: 'employee', via: 'password', tenantId: payload.tenantId, family: payload.family });
  },

  /** 取目前登入者資料（requireAuth 後使用） */
  me(userId: string, tenantId = 'default'): Applicant {
    return getApplicant(userId, tenantId);
  },
};
