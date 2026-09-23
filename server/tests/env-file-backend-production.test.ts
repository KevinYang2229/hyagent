import { envSchema } from '@/config/env';

/**
 * production + DATA_BACKEND=file 的 boot fail-fast（評估 §6.2.1 d）。
 *
 * file 模式的每一項機制都假設只有一個副本；多副本下撤銷不會傳播、Session 隨負載平衡飄移，
 * 而且完全不會報錯。這裡釘的是「要用 file 上正式環境就得明示單副本」這個約定。
 */
const PROD = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  ANTHROPIC_API_KEY: 'test-key',
} as const;

/** 只挑本案關心的那條 issue，避免被其他欄位的驗證結果干擾 */
function backendIssues(input: Record<string, unknown>): string[] {
  const r = envSchema.safeParse(input);
  if (r.success) return [];
  return r.error.issues.filter((i) => i.path[0] === 'DATA_BACKEND').map((i) => i.message);
}

describe('env：production 下的 file 後端守門', () => {
  it('production + file 未明示 → 失敗，訊息指出改 db 或明示單副本', () => {
    const messages = backendIssues({ ...PROD, DATA_BACKEND: 'file' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/single replica/);
    expect(messages[0]).toMatch(/ALLOW_FILE_BACKEND_IN_PRODUCTION/);
  });

  it('production + file + 明示單副本 → 放行', () => {
    const r = envSchema.safeParse({
      ...PROD,
      DATA_BACKEND: 'file',
      ALLOW_FILE_BACKEND_IN_PRODUCTION: 'true',
    });
    expect(r.success).toBe(true);
  });

  it('production + db → 放行，不需要那個開關', () => {
    const r = envSchema.safeParse({
      ...PROD,
      DATA_BACKEND: 'db',
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
    });
    expect(r.success).toBe(true);
  });

  it('非 production 不受影響（file 是開發預設）', () => {
    expect(backendIssues({ ANTHROPIC_API_KEY: 'test-key', DATA_BACKEND: 'file' })).toEqual([]);
  });

  it("ALLOW_FILE_BACKEND_IN_PRODUCTION='false' 是關閉，不是「有設值就當 true」", () => {
    // z.coerce.boolean() 會把 'false' 判成 true。安全開關踩到這個陷阱等於整條守門形同虛設。
    expect(backendIssues({ ...PROD, DATA_BACKEND: 'file', ALLOW_FILE_BACKEND_IN_PRODUCTION: 'false' }))
      .toHaveLength(1);
    const parsed = envSchema.safeParse({ ...PROD, DATA_BACKEND: 'db', DATABASE_URL: 'postgresql://u:p@h:5432/d', ALLOW_FILE_BACKEND_IN_PRODUCTION: 'FALSE' });
    expect(parsed.success && parsed.data.ALLOW_FILE_BACKEND_IN_PRODUCTION).toBe(false);
  });

  it('無法辨識的值直接拒絕，不靜默當 false', () => {
    const r = envSchema.safeParse({ ...PROD, DATA_BACKEND: 'file', ALLOW_FILE_BACKEND_IN_PRODUCTION: 'yes' });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues.some((i) => i.path[0] === 'ALLOW_FILE_BACKEND_IN_PRODUCTION')).toBe(true);
  });
});
