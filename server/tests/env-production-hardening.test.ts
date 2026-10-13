import { envSchema } from '@/config/env';

/**
 * production 的加密金鑰與 CORS 守門：兩者沿用預設值都能正常啟動、不會報錯，
 * 結果是敏感欄位明文落地、任意來源都被 CORS 放行。所以在 boot 就擋下。
 */
const PROD = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  ANTHROPIC_API_KEY: 'test-key',
  DATA_BACKEND: 'db',
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  DATA_ENCRYPTION_KEY: 'a'.repeat(64),
  CORS_ORIGIN: 'https://app.example.com,https://admin.example.com',
} as const;

function issuesFor(input: Record<string, unknown>, key: string): string[] {
  const r = envSchema.safeParse(input);
  if (r.success) return [];
  return r.error.issues.filter((i) => i.path[0] === key).map((i) => i.message);
}

describe('env：production 的加密金鑰與 CORS 守門', () => {
  it('兩者都設好 → 放行', () => {
    expect(envSchema.safeParse(PROD).success).toBe(true);
  });

  it('未設 DATA_ENCRYPTION_KEY → 失敗', () => {
    const { DATA_ENCRYPTION_KEY: _k, ...rest } = PROD;
    expect(issuesFor(rest, 'DATA_ENCRYPTION_KEY')[0]).toMatch(/required in production/);
  });

  it("DATA_ENCRYPTION_KEY='' 視同未設 → 失敗", () => {
    expect(issuesFor({ ...PROD, DATA_ENCRYPTION_KEY: '' }, 'DATA_ENCRYPTION_KEY')).toHaveLength(1);
  });

  it('CORS_ORIGIN 未設（預設 *）→ 失敗', () => {
    const { CORS_ORIGIN: _c, ...rest } = PROD;
    expect(issuesFor(rest, 'CORS_ORIGIN')[0]).toMatch(/explicit origins/);
  });

  it('CORS_ORIGIN 清單中夾帶 * → 失敗', () => {
    expect(issuesFor({ ...PROD, CORS_ORIGIN: 'https://app.example.com, *' }, 'CORS_ORIGIN')).toHaveLength(1);
  });

  it('非 production 不受影響', () => {
    expect(issuesFor({ ANTHROPIC_API_KEY: 'test-key' }, 'DATA_ENCRYPTION_KEY')).toEqual([]);
    expect(issuesFor({ ANTHROPIC_API_KEY: 'test-key' }, 'CORS_ORIGIN')).toEqual([]);
  });
});
