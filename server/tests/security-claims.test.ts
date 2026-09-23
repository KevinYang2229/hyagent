import { randomUUID } from 'node:crypto';
import { securityClaims } from '@/lib/security-claims';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';

jest.mock('@/lib/db', () => ({ connectDb: jest.fn() }));

afterEach(() => { env.DATA_BACKEND = 'file'; jest.resetAllMocks(); });

it('file claims are exclusive and survive module reloads', async () => {
  const key = `test:${randomUUID()}`;
  expect(await securityClaims.has(key)).toBe(false);
  const results = await Promise.all([securityClaims.claim(key), securityClaims.claim(key)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  let reloaded!: typeof securityClaims;
  jest.isolateModules(() => { reloaded = require('@/lib/security-claims').securityClaims; });
  expect(await reloaded.has(key)).toBe(true);
  expect(await reloaded.claim(key)).toBe(false);
});

it('DB claims use atomic conflict handling and parameter binding', async () => {
  env.DATA_BACKEND = 'db';
  const execute = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const query = jest.fn().mockResolvedValue([{ key: 'test' }]);
  jest.mocked(connectDb).mockResolvedValue({ $executeRaw: execute, $queryRaw: query } as never);
  const key = "test:'; DROP TABLE sessions;--";
  expect(await securityClaims.claim(key)).toBe(true);
  expect(await securityClaims.claim(key)).toBe(false);
  const sql = execute.mock.calls[0][0].join('?');
  // 單一語句處理衝突：分成「先查再寫」會讓並行請求同時通過（規格 §8.5 要求原子性）
  expect(sql).toContain('ON CONFLICT (key) DO UPDATE');
  // 衝突時只有既有紀錄已過期才讓新的蓋過去；未過期一律影響 0 列 → claim 回 false
  expect(sql).toContain('WHERE security_claims.expires_at IS NOT NULL');
  expect(sql).not.toContain('DROP TABLE');
  expect(execute.mock.calls[0][1]).toBe(key);
  expect(await securityClaims.has(key)).toBe(true);
});

it('DB claims without a TTL bind NULL, so permanent records never get swept', async () => {
  env.DATA_BACKEND = 'db';
  const execute = jest.fn().mockResolvedValue(1);
  jest.mocked(connectDb).mockResolvedValue({ $executeRaw: execute } as never);

  await securityClaims.claim('refresh-used:abc');
  expect(execute.mock.calls[0][2]).toBeNull();

  await securityClaims.claim('assertion-jti:x', 1_700_000_000);
  expect(execute.mock.calls[1][2]).toEqual(new Date(1_700_000_000 * 1000));
});

it('DB has() ignores expired records, so behaviour does not depend on the sweeper running', async () => {
  env.DATA_BACKEND = 'db';
  const query = jest.fn().mockResolvedValue([]);
  jest.mocked(connectDb).mockResolvedValue({ $queryRaw: query } as never);

  expect(await securityClaims.has('assertion-jti:x')).toBe(false);
  expect(query.mock.calls[0][0].join('?')).toContain('expires_at IS NULL OR expires_at > now()');
});

it('DB sweep only deletes records that carry an expiry', async () => {
  env.DATA_BACKEND = 'db';
  const execute = jest.fn().mockResolvedValue(3);
  jest.mocked(connectDb).mockResolvedValue({ $executeRaw: execute } as never);

  expect(await securityClaims.sweepExpired()).toBe(3);
  const sql = execute.mock.calls[0][0].join('?');
  // 沒有到期時間的是 refresh / 送出防重，清掉它們等於讓用過的 refresh token 重新可用
  expect(sql).toContain('expires_at IS NOT NULL');
});

it('DB failure propagates instead of accepting an unrecorded action', async () => {
  env.DATA_BACKEND = 'db';
  jest.mocked(connectDb).mockRejectedValue(new Error('database unavailable'));
  await expect(securityClaims.claim('test')).rejects.toThrow('database unavailable');
  await expect(securityClaims.has('test')).rejects.toThrow('database unavailable');
});
