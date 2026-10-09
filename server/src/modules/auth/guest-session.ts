/**
 * 免登入訪客 Session（POST /api/auth/guest）。
 *
 * 給沒有登入機制的公開 App：帶租戶的 pk_ 換一個 HyAgent Session，之後與 SSO Session 走同一條
 * requireAuth 路徑。與 Assertion 換發的差別只在身分來源——這裡沒有客戶端簽章，所以：
 *
 * - **租戶必須明確開啟**（tenant.guestAccess）。預設關閉；未帶 API Key 落到預設租戶時同樣要看開關。
 * - **sub 由伺服器隨機產生**（guest_ + 128 bits），呼叫端無法指定，也就無從冒用既有帳號；
 *   目錄查無此 id → 部門落到 '—'，權限即訪客部門那一份（resolveScopes 與 widget 訪客同一套）。
 * - **kid 記為 GUEST_SESSION_KID**。Session 表的 kid 欄位本來綁簽章公鑰；訪客沒有公鑰，
 *   requireAuth 遇到這個 kid 改為重驗 guestAccess 開關，關掉即全部失效。
 */
import { randomBytes } from 'node:crypto';
import { authSessionStore } from '@/lib/auth-session.store';
import { resolveAssertionSettings } from '@/modules/tenant/tenant-keys';
import type { Tenant } from '@/modules/tenant/tenant.types';
import { AppError } from '@/utils/app-error';

/** 訪客 Session 的 kid。不是 RFC 7638 Thumbprint 的格式（那是 43 字元 base64url），不會與真公鑰撞名。 */
export const GUEST_SESSION_KID = 'guest';

/** 訪客的顯示名 */
export const GUEST_NAME = '訪客';

export function isGuestAccessEnabled(tenant: Pick<Tenant, 'guestAccess'> | undefined): boolean {
  return tenant?.guestAccess === true;
}

export async function issueGuestSession(tenant: Tenant | undefined): Promise<{
  sessionToken: string;
  expiresIn: number;
  user: { sub: string; name: string };
}> {
  if (!tenant || !isGuestAccessEnabled(tenant)) {
    throw new AppError(403, 'GUEST_ACCESS_DISABLED', '此租戶未開放訪客使用');
  }
  const sub = `guest_${randomBytes(16).toString('hex')}`;
  const created = await authSessionStore.create({
    tenantId: tenant.id,
    sub,
    kid: GUEST_SESSION_KID,
    name: GUEST_NAME,
    expiresInSeconds: resolveAssertionSettings(tenant).sessionExpiresIn,
  });
  return { sessionToken: created.sessionToken, expiresIn: created.expiresIn, user: { sub, name: GUEST_NAME } };
}
