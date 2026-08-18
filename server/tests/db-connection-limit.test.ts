/**
 * Prisma 的預設連線池是「實體核心數 × 2 + 1」（10 核心 = 21），而 Supabase session
 * pooler 全帳號共用 15 條——單一 process 就能把 pooler 佔滿，其他連線收到
 * EMAXCONNSESSION，而症狀（逾時、連不上）完全不像連線數問題。
 */
import { withConnectionLimit } from '@/lib/db';

const BASE = 'postgresql://u:p@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

describe('withConnectionLimit', () => {
  it('未指定時補上上限', () => {
    expect(withConnectionLimit(BASE, 5)).toContain('connection_limit=5');
  });

  it('已自帶時尊重原值，不覆寫', () => {
    const explicit = `${BASE}?connection_limit=12`;
    expect(withConnectionLimit(explicit, 5)).toContain('connection_limit=12');
    expect(withConnectionLimit(explicit, 5)).not.toContain('connection_limit=5');
  });

  it('保留原有的其他查詢參數（例如 pgbouncer、sslmode）', () => {
    const out = withConnectionLimit(`${BASE}?pgbouncer=true&sslmode=require`, 5);
    expect(out).toContain('pgbouncer=true');
    expect(out).toContain('sslmode=require');
    expect(out).toContain('connection_limit=5');
  });

  it('解析不了的字串原樣回傳，交給 Prisma 自己報錯', () => {
    expect(withConnectionLimit('not-a-url', 5)).toBe('not-a-url');
  });
});
