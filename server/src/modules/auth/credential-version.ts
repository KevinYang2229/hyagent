import { createHmac } from 'node:crypto';
import { env } from '@/config/env';
import { tenantStore, tenantFromRow, unsealTenant } from '@/modules/tenant/tenant.store';
import { connectDb } from '@/lib/db';
import { securityClaims } from '@/lib/security-claims';
import type { Tenant } from '@/modules/tenant/tenant.types';
import type { JwtPayload } from '@/utils/jwt';
import { AppError } from '@/utils/app-error';

export function credentialVersion(tenant: Tenant): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET)
    .update(JSON.stringify([tenant.id, tenant.createdAt, tenant.ssoVersion, tenant.ssoSecret])).digest('hex');
}
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
  if (payload.via === 'sso') {
    if (!tenant.ssoSecret || payload.credentialVersion !== credentialVersion(tenant)) {
      throw AppError.unauthorized('SSO credentials revoked');
    }
  } else if (payload.via !== 'password' || payload.tenantId !== 'default' || env.NODE_ENV === 'production') {
    throw AppError.unauthorized('Invalid login source');
  }
}
