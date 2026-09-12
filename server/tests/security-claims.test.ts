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
  expect(execute.mock.calls[0][0].join('?')).toContain('ON CONFLICT (key) DO NOTHING');
  expect(execute.mock.calls[0][1]).toBe(key);
  expect(await securityClaims.has(key)).toBe(true);
});

it('DB failure propagates instead of accepting an unrecorded action', async () => {
  env.DATA_BACKEND = 'db';
  jest.mocked(connectDb).mockRejectedValue(new Error('database unavailable'));
  await expect(securityClaims.claim('test')).rejects.toThrow('database unavailable');
  await expect(securityClaims.has('test')).rejects.toThrow('database unavailable');
});
