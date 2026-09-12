import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { credentialVersion, validateIdentity } from '@/modules/auth/credential-version';
import { tenantStore, tenantToRow } from '@/modules/tenant/tenant.store';
import type { JwtPayload } from '@/utils/jwt';

jest.mock('@/lib/db', () => ({
  connectDb: jest.fn(),
  DbWriteQueue: class { enqueue() {} flush() { return Promise.resolve(); } },
}));

afterEach(() => { env.DATA_BACKEND = 'file'; jest.resetAllMocks(); });

it('DB identity validation reads current credentials instead of stale tenant memory', async () => {
  const tenant = tenantStore.createTenant('cached tenant', [], 'old-secret-for-testing');
  const payload: JwtPayload = { sub: 'external', role: 'employee', via: 'sso', tenantId: tenant.id, credentialVersion: credentialVersion(tenant) };
  const findUnique = jest.fn().mockResolvedValue(tenantToRow(tenant));
  jest.mocked(connectDb).mockResolvedValue({ tenantRow: { findUnique } } as never);
  env.DATA_BACKEND = 'db';
  await expect(validateIdentity(payload)).resolves.toBeUndefined();
  findUnique.mockResolvedValue(tenantToRow({ ...tenant, ssoVersion: 'rotated-on-another-instance' }));
  await expect(validateIdentity(payload)).rejects.toThrow(/revoked/);
  expect(tenantStore.getTenant(tenant.id)?.ssoVersion).toBe(tenant.ssoVersion);
  findUnique.mockResolvedValue(null);
  await expect(validateIdentity(payload)).rejects.toThrow(/no longer exists/);
});
