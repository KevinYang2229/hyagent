/**
 * db 模式下的身分重驗必須讀當前資料，不能相信行程內的租戶快取。
 *
 * 改造前這裡驗的是 SSO token 的 credentialVersion；SSO 已改走 HyAgent Session
 * （撤銷語意由公鑰的 kid 狀態承接），因此本檔改驗**帳密登入**路徑——
 * 它現在是 validateIdentity() 唯一的服務對象，而「讀 primary 而非記憶體 Map」
 * 這個性質是規格 §2.6 第 2 條要的，不能因為換了路徑就不見。
 */
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { validateIdentity } from '@/modules/auth/credential-version';
import { tenantStore, tenantToRow } from '@/modules/tenant/tenant.store';
import type { JwtPayload } from '@/utils/jwt';

jest.mock('@/lib/db', () => ({
  connectDb: jest.fn(),
  DbWriteQueue: class { enqueue() {} flush() { return Promise.resolve(); } },
}));

afterEach(() => { env.DATA_BACKEND = 'file'; jest.resetAllMocks(); });

it('DB identity validation reads the live tenant instead of stale in-process memory', async () => {
  const tenant = tenantStore.createTenant('cached tenant', []);
  // 帳密登入的 token 綁 default 租戶的目錄；這裡只驗「租戶還在不在」這條路徑
  const payload: JwtPayload = { sub: 'kevin', role: 'employee', via: 'password', tenantId: 'default' };
  const findUnique = jest.fn().mockResolvedValue(tenantToRow(tenantStore.getTenant('default')!));
  jest.mocked(connectDb).mockResolvedValue({ tenantRow: { findUnique } } as never);
  env.DATA_BACKEND = 'db';

  await expect(validateIdentity(payload)).resolves.toBeUndefined();

  // 租戶在另一個副本被刪掉 → 本副本的記憶體 Map 還留著，但驗證必須依 DB 的結果失敗
  findUnique.mockResolvedValue(null);
  await expect(validateIdentity(payload)).rejects.toThrow(/no longer exists/);
  expect(tenantStore.getTenant('default')).toBeDefined();
  expect(tenant.id).not.toBe('default');
});

it('via=sso 的舊 JWT 一律拒絕——該路徑已改為 HyAgent Session，不再簽發此類 token', async () => {
  const payload: JwtPayload = { sub: 'external', role: 'employee', via: 'sso', tenantId: 'default' };
  await expect(validateIdentity(payload)).rejects.toThrow(/Invalid login source/);
});
