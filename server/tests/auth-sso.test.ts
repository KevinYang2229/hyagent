import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { authService } from '@/modules/auth/auth.service';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { verifyAccessToken, verifyRefreshToken } from '@/utils/jwt';
import { validateIdentity } from '@/modules/auth/credential-version';

function fixture() {
  const tenant = tenantStore.createTenant('SSO test', [], 'test-sso-secret-at-least-32-characters');
  const sign = (claims: Record<string, unknown> = {}, options: jwt.SignOptions = {}) => jwt.sign(
    { sub: 'external-user', ...claims }, tenant.ssoSecret!,
    { algorithm: 'HS256', issuer: 'hyagent:handoff', audience: 'hyagent:sso', expiresIn: '5m', ...options },
  );
  return { tenant, sign };
}

it('valid SSO preserves external identity but ignores all external roles', () => {
  const { tenant, sign } = fixture();
  for (const role of ['admin', 'manager', 'employee']) {
    const tokens = authService.ssoExchange(tenant, sign({ role, name: '外部使用者', isAdmin: true }));
    const payload = verifyAccessToken(tokens.accessToken);
    expect(payload).toMatchObject({ sub: 'external-user', role: 'employee', via: 'sso', tenantId: tenant.id, name: '外部使用者' });
    expect(payload).not.toHaveProperty('isAdmin');
  }
});

it('requires enabled SSO, a valid subject, signature, purpose, algorithm and short expiry', () => {
  const { tenant, sign } = fixture();
  const bad = [
    'invalid', sign({}, { expiresIn: -1 }), sign({}, { algorithm: 'HS384' }),
    sign({}, { issuer: 'other' }), sign({}, { audience: 'other' }),
    sign({}, { expiresIn: '1h' }), sign({ sub: ' ' }), sign({ sub: '' }),
    jwt.sign({ sub: 'user', iss: 'hyagent:handoff', aud: 'hyagent:sso' }, tenant.ssoSecret!),
    jwt.sign({ sub: 'user' }, 'wrong-secret', { expiresIn: '5m' }),
  ];
  for (const token of bad) expect(() => authService.ssoExchange(tenant, token)).toThrow();
  expect(() => authService.ssoExchange({ ...tenant, ssoSecret: undefined }, sign())).toThrow(/未啟用/);
});

it('rotates refresh tokens once and revokes descendants when an old token is replayed', async () => {
  const { tenant, sign } = fixture();
  const first = authService.ssoExchange(tenant, sign());
  const second = await authService.refresh(first.refreshToken);
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect(verifyRefreshToken(second.refreshToken).family).toBe(verifyRefreshToken(first.refreshToken).family);
  expect(verifyAccessToken(second.accessToken).sub).toBe('external-user');
  await expect(authService.refresh(first.refreshToken)).rejects.toThrow(/reuse/);
  await expect(authService.refresh(second.refreshToken)).rejects.toThrow(/revoked/);
});

it('concurrent refresh permits at most one rotation', async () => {
  const { tenant, sign } = fixture();
  const tokens = authService.ssoExchange(tenant, sign());
  const results = await Promise.allSettled([authService.refresh(tokens.refreshToken), authService.refresh(tokens.refreshToken)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const success = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<typeof tokens>;
  await expect(authService.refresh(success.value.refreshToken)).rejects.toThrow(/revoked/);
});

it.each(['rotate', 'disable', 'delete'])('revokes access and refresh after tenant credential change: %s', async (change) => {
  const { tenant, sign } = fixture();
  const tokens = authService.ssoExchange(tenant, sign());
  if (change === 'delete') tenantStore.deleteTenant(tenant.id);
  else tenantStore.updateTenant(tenant.id, { ssoSecret: change === 'disable' ? '' : 'new-secret-at-least-32-characters' });
  await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).rejects.toThrow();
  await expect(authService.refresh(tokens.refreshToken)).rejects.toThrow();
});

it('restoring an old SSO secret does not resurrect old credentials', async () => {
  const { tenant, sign } = fixture();
  const tokens = authService.ssoExchange(tenant, sign());
  tenantStore.updateTenant(tenant.id, { ssoSecret: 'another-secret-value' });
  tenantStore.updateTenant(tenant.id, { ssoSecret: tenant.ssoSecret });
  await expect(authService.refresh(tokens.refreshToken)).rejects.toThrow(/revoked/);
});

it('password login remains tenant-bound and uses the same rotation/revocation rules', async () => {
  const first = authService.login('kevin', env.AUTH_DEV_PASSWORD);
  const next = await authService.refresh(first.refreshToken);
  expect(verifyAccessToken(next.accessToken)).toMatchObject({ sub: 'kevin', via: 'password', tenantId: 'default' });
  await expect(authService.refresh(first.refreshToken)).rejects.toThrow(/reuse/);
  await expect(validateIdentity(verifyAccessToken(next.accessToken))).rejects.toThrow(/revoked/);
});
