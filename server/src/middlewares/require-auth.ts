/**
 * 使用者身分驗證：兩種憑證形式並存（決策 G）。
 *
 *   hyas_… 開頭 → HyAgent Session（Widget 走的路，規格 §7.1）。不透明字串，查 session store。
 *   其餘       → 帳密登入的 access JWT。規格未涵蓋此路徑，維持現狀。
 *
 * 兩條路都**每次請求重新判定**、沒有任何快取——規格 §2.6 第 4 條的要求，也是改造前
 * `validateIdentity()` 已有的性質。這一點不能因為換了憑證形式而退步。
 */
import type { NextFunction, Request, Response } from 'express';
import { authSessionStore, readSub } from '@/lib/auth-session.store';
import { runWithSsoIdentity, type SsoIdentity } from '@/lib/sso-identity.context';
import { validateIdentity } from '@/modules/auth/credential-version';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { verifyAccessToken } from '@/utils/jwt';
import { AppError } from '@/utils/app-error';

/** 不透明 Session token 的前綴（見 lib/auth-session.store.ts）。 */
const SESSION_TOKEN_PREFIX = 'hyas_';

/**
 * Session 路徑的每請求重驗。
 *
 * 除了「Session 還在不在」，還要確認**建立它的那把公鑰現在仍是 active**。
 * 撤銷公鑰時 `revokeByKid()` 已經把 Session 刪掉了，所以多數情況這裡不會擋到任何人；
 * 它守的是撤銷發生在**另一個副本**、而本副本的請求恰好在傳播完成前進來的那個窗口。
 * 每次都讀 primary，窗口因此收斂到單次請求的長度，遠小於規格 §2.6 給的 60 秒。
 */
async function authenticateSession(sessionToken: string, req: Request): Promise<SsoIdentity> {
  const session = await authSessionStore.get(sessionToken);
  if (!session) throw AppError.unauthorized('Session 不存在或已過期');

  const tenant = await tenantStore.getTenantFromPrimary(session.tenantId);
  if (!tenant) throw AppError.unauthorized('Tenant no longer exists');
  const key = tenant.publicKeys?.find((k) => k.kid === session.kid);
  if (key?.status !== 'active') throw AppError.unauthorized('建立此 Session 的公鑰已失效');

  const sub = readSub(session);
  req.user = {
    sub,
    role: 'employee',
    via: 'sso',
    tenantId: session.tenantId,
    ...(session.name ? { name: session.name } : {}),
  };
  req.authSessionToken = sessionToken;
  return {
    tenantId: session.tenantId,
    sub,
    ...(session.name ? { name: session.name } : {}),
    ...(session.profile ? { profile: session.profile } : {}),
  };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  let identity: SsoIdentity | undefined;
  try {
    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw AppError.unauthorized('Missing Authorization header');

    if (token.startsWith(SESSION_TOKEN_PREFIX)) {
      identity = await authenticateSession(token, req);
    } else {
      req.user = verifyAccessToken(token);
      await validateIdentity(req.user);
    }

    if (req.tenant && req.user?.tenantId !== req.tenant.id) {
      throw AppError.unauthorized('Token tenant mismatch');
    }
  } catch {
    next(AppError.unauthorized('Invalid or expired access token'));
    return;
  }
  // Assertion 帶進來的身分只在這個請求的 continuation 裡看得到（見 sso-identity.context.ts）。
  // 帳密登入沒有這份身分，維持原路。
  if (identity) {
    runWithSsoIdentity(identity, next);
    return;
  }
  next();
}
