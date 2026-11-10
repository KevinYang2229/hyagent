import { adminAccountStore, toPublicAccount } from '@/modules/admin-account/admin-account.store';
import { hashPassword, verifyPassword } from '@/modules/admin-account/password';

const base = { tenantId: 't1', displayName: '小明', passwordHash: 'h' };

describe('adminAccountStore', () => {
  beforeEach(() => adminAccountStore.clear());

  it('建立後可用 id 與不分大小寫的 username 取回', () => {
    const a = adminAccountStore.create({ ...base, username: 'alice' });
    expect(adminAccountStore.get(a.id)?.username).toBe('alice');
    expect(adminAccountStore.getByUsername('ALICE')?.id).toBe(a.id);
  });

  it('username 重複丟 409（不分大小寫）', () => {
    adminAccountStore.create({ ...base, username: 'alice' });
    expect(() => adminAccountStore.create({ ...base, tenantId: 't2', username: 'ALICE' })).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
  });

  it('新帳號預設 permissions 為 {}、credentialVersion 為 0、狀態 active', () => {
    const a = adminAccountStore.create({ ...base, username: 'alice' });
    expect(a.permissions).toEqual({});
    expect(a.credentialVersion).toBe(0);
    expect(a.status).toBe('active');
  });

  it('update 搭配 bumpCredential 會讓 credentialVersion 加 1', () => {
    const a = adminAccountStore.create({ ...base, username: 'alice' });
    const u = adminAccountStore.update(a.id, { status: 'disabled', bumpCredential: true });
    expect(u?.credentialVersion).toBe(1);
    expect(u?.status).toBe('disabled');
    expect(adminAccountStore.update(a.id, { displayName: 'x' })?.credentialVersion).toBe(1);
    expect(adminAccountStore.update('nope', {})).toBeUndefined();
  });

  it('removeByTenant 只刪該租戶的帳號；remove 回傳是否刪除', () => {
    const a = adminAccountStore.create({ ...base, username: 'alice' });
    adminAccountStore.create({ ...base, username: 'bobby' });
    const c = adminAccountStore.create({ ...base, tenantId: 't2', username: 'carol' });
    expect(adminAccountStore.removeByTenant('t1')).toBe(2);
    expect(adminAccountStore.listByTenant('t1')).toEqual([]);
    expect(adminAccountStore.get(c.id)).toBeDefined();
    expect(adminAccountStore.remove(a.id)).toBe(false);
    expect(adminAccountStore.remove(c.id)).toBe(true);
  });

  it('toPublicAccount 不含 passwordHash 與 credentialVersion', () => {
    const a = adminAccountStore.create({ ...base, username: 'alice' });
    const p = toPublicAccount(a);
    expect(p).not.toHaveProperty('passwordHash');
    expect(p).not.toHaveProperty('credentialVersion');
    expect(p.username).toBe('alice');
  });
});

describe('password', () => {
  it('verifyPassword 正確回 true、錯誤回 false', async () => {
    const h = await hashPassword('correct-horse-1');
    expect(await verifyPassword('correct-horse-1', h)).toBe(true);
    expect(await verifyPassword('wrong-password', h)).toBe(false);
  });
});
