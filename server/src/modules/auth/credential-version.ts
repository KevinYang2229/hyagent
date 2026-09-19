/**
 * 帳密登入 token 的每請求重驗。
 *
 * **Widget 的 SSO 路徑已不走這裡**：它改用 HyAgent Session（不透明 token + session store），
 * 撤銷語意由「公鑰的 kid 狀態 + 依 kid 批次作廢」承接，不再需要把租戶密鑰的 HMAC
 * （原 `credentialVersion`）寫進 token。該函式與 `ssoVersion` / `ssoSecret` 一併移除。
 */
import { isPasswordLoginEnabled } from '@/config/env';
import { tenantStore, tenantFromRow, unsealTenant } from '@/modules/tenant/tenant.store';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { securityClaims } from '@/lib/security-claims';
import { isKnownUser } from '@/modules/user/user.directory';
import type { Tenant } from '@/modules/tenant/tenant.types';
import type { JwtPayload } from '@/utils/jwt';
import { AppError } from '@/utils/app-error';
export async function validateIdentity(payload: JwtPayload): Promise<void> {
  if (!payload.tenantId || !payload.sub || payload.role !== 'employee') {
    throw AppError.unauthorized('Invalid user identity');
  }
  let tenant: Tenant | undefined;
  if (env.DATA_BACKEND === 'db') {
    const db = await connectDb();
    const row = await db.tenantRow.findUnique({ where: { id: payload.tenantId } });
    tenant = row ? unsealTenant(tenantFromRow(row)) : undefined;
  } else {
    tenant = tenantStore.getTenant(payload.tenantId);
  }
  if (payload.family && await securityClaims.has(`refresh-revoked:${payload.family}`)) {
    throw AppError.unauthorized('Login session revoked');
  }
  if (!tenant) throw AppError.unauthorized('Tenant no longer exists');
  if (
    // via='sso' 的 JWT 不再簽發，遇到就是舊憑證或偽造，一律拒絕（無既有客戶，不留相容層）。
    // 帳密登入關閉時，連同它先前簽發的 token 一起失效——否則關掉開關後舊 token 還能繼續用。
    // 另外每次都重查租戶目錄：帳號被移出目錄後現有 token 立即失效，不必等它自然過期。
    payload.via !== 'password' ||
    !isPasswordLoginEnabled() ||
    !isKnownUser(payload.sub, payload.tenantId)
  ) {
    throw AppError.unauthorized('Invalid login source');
  }
}
