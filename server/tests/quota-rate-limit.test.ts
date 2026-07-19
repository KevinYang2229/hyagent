/**
 * 兩層守門：月度 token 配額（tenant-quota）與 usage 月度分桶。
 * rate limit 粒度（租戶+使用者）由 keyGenerator 單元測試覆蓋。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { monthKey, usageStore } from '@/modules/usage/usage.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();

async function loginToken(): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

describe('usage 月度分桶', () => {
  it('recordLLMUsage / recordEmbeddingUsage 記入當月 bucket', () => {
    const tid = `quota-bucket-${Date.now()}`;
    usageStore.recordLLMUsage(tid, {
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
    });
    usageStore.recordEmbeddingUsage(tid, 30, 'text-embedding-3-large', 'platform');
    expect(usageStore.currentMonthLlmTokens(tid)).toBe(180);
    expect(usageStore.get(tid).monthlyLlmTokens[monthKey()]).toBe(180);
    // 終身累計不受分桶影響
    expect(usageStore.get(tid).llmTokens).toBe(150);
    expect(usageStore.get(tid).embeddingTokens).toBe(30);
  });

  it('monthKey 為 YYYY-MM（UTC）', () => {
    expect(monthKey(new Date('2026-07-19T12:00:00Z'))).toBe('2026-07');
    expect(monthKey(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01');
  });
});

describe('月配額守門（/api/conversations）', () => {
  afterEach(() => {
    // 還原預設租戶為不限，避免污染其他測試
    tenantStore.updateTenant('default', { quotaMonthlyLlmTokens: 0 });
  });

  it('當月用量達配額 → 429 + 明確訊息', async () => {
    const token = await loginToken();
    tenantStore.updateTenant('default', { quotaMonthlyLlmTokens: 10 });
    usageStore.recordLLMUsage('default', {
      usage: { inputTokens: 8, outputTokens: 4 },
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
    });
    const res = await request(app)
      .post('/api/conversations')
      .set('authorization', `Bearer ${token}`)
      .send({ message: '我要請假' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.error.message).toContain('本月 AI 用量已達上限');
  });

  it('配額 0（不限）不擋（能通過守門進到後續處理）', async () => {
    const token = await loginToken();
    tenantStore.updateTenant('default', { quotaMonthlyLlmTokens: 0 });
    const res = await request(app)
      .post('/api/conversations')
      .set('authorization', `Bearer ${token}`)
      .send({});
    // 不驗證後續行為，只驗證沒有被配額層擋下
    expect(res.status).not.toBe(429);
  });
});

describe('admin 可設定配額', () => {
  it('PATCH /api/admin/tenants/:id 接受 quotaMonthlyLlmTokens 並回存', async () => {
    const t = tenantStore.createTenant('quota-admin-test');
    const res = await request(app)
      .patch(`/api/admin/tenants/${t.id}`)
      .set('x-admin-key', 'test-admin-key')
      .send({ quotaMonthlyLlmTokens: 123456 });
    expect(res.status).toBe(200);
    expect(res.body.data.quotaMonthlyLlmTokens).toBe(123456);
    expect(tenantStore.getTenant(t.id)?.quotaMonthlyLlmTokens).toBe(123456);
  });
});

describe('rate limit 粒度（租戶+使用者）', () => {
  function miniApp(limit: number) {
    const { makeTenantRateLimit } = jest.requireActual(
      '@/middlewares/tenant-rate-limit',
    ) as typeof import('@/middlewares/tenant-rate-limit');
    const express = jest.requireActual('express') as typeof import('express');
    const app = express();
    // 模擬 resolveTenant + requireAuth：從 header 取租戶/使用者
    app.use((req, _res, next) => {
      req.tenant = { id: String(req.headers['x-t'] ?? 'default') } as never;
      if (req.headers['x-u']) req.user = { sub: String(req.headers['x-u']) } as never;
      next();
    });
    app.use(makeTenantRateLimit({ windowMs: 60_000, limit }));
    app.get('/', (_req, res) => void res.json({ ok: true }));
    return app;
  }

  it('同租戶不同使用者各自一桶：A 打爆不影響 B', async () => {
    const app = miniApp(2);
    await request(app).get('/').set('x-t', 't1').set('x-u', 'userA').expect(200);
    await request(app).get('/').set('x-t', 't1').set('x-u', 'userA').expect(200);
    await request(app).get('/').set('x-t', 't1').set('x-u', 'userA').expect(429);
    await request(app).get('/').set('x-t', 't1').set('x-u', 'userB').expect(200);
  });

  it('未認證流量退回租戶粒度、跨租戶互不影響', async () => {
    const app = miniApp(1);
    await request(app).get('/').set('x-t', 't1').expect(200);
    await request(app).get('/').set('x-t', 't1').expect(429);
    await request(app).get('/').set('x-t', 't2').expect(200);
  });
});
