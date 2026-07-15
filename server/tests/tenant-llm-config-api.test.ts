jest.mock('@/lib/llm/verify-key', () => ({
  verifyLLMKey: jest.fn(async () => true),
}));

import request from 'supertest';
import { createApp } from '@/app';

const app = createApp();

describe('/api/tenant/llm-config（sk_ 自助）', () => {
  it('sk_ 金鑰可 PUT + GET（GET 回遮罩）', async () => {
    const put = await request(app)
      .put('/api/tenant/llm-config')
      .set('x-api-key', 'sk_default')
      .send({ provider: 'anthropic', anthropicApiKey: 'sk-ant-tenant-key-00000000' });
    expect(put.status).toBe(200);
    expect(put.body.data.anthropicApiKey).toContain('…');

    const get = await request(app).get('/api/tenant/llm-config').set('x-api-key', 'sk_default');
    expect(get.status).toBe(200);
    expect(get.body.data.provider).toBe('anthropic');
    expect(JSON.stringify(get.body)).not.toContain('sk-ant-tenant-key-00000000');
  });

  it('pk_ 公開金鑰 → 403（公開金鑰不得讀寫設定）', async () => {
    const res = await request(app).get('/api/tenant/llm-config').set('x-api-key', 'pk_default');
    expect(res.status).toBe(403);
  });

  it('未帶 key（落預設租戶但無金鑰種類）→ 403', async () => {
    const res = await request(app).get('/api/tenant/llm-config');
    expect(res.status).toBe(403);
  });

  it('驗證失敗 → 400', async () => {
    const { verifyLLMKey } = jest.requireMock('@/lib/llm/verify-key') as {
      verifyLLMKey: jest.Mock;
    };
    verifyLLMKey.mockResolvedValueOnce(false);
    const res = await request(app)
      .put('/api/tenant/llm-config')
      .set('x-api-key', 'sk_default')
      .send({ openaiApiKey: 'sk-proj-bad-key-000000000000' });
    expect(res.status).toBe(400);
  });
});

describe('/api/admin/tenants/:id/llm-config 與 usage 成本', () => {
  it('admin 可代設與讀取', async () => {
    const created = await request(app)
      .post('/api/admin/tenants')
      .set('x-admin-key', 'test-admin-key')
      .send({ name: 'byo-admin-api' });
    const id = created.body.data.tenant.id as string;

    const put = await request(app)
      .put(`/api/admin/tenants/${id}/llm-config`)
      .set('x-admin-key', 'test-admin-key')
      .send({ provider: 'anthropic', anthropicApiKey: 'sk-ant-admin-set-000000000' });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get(`/api/admin/tenants/${id}/llm-config`)
      .set('x-admin-key', 'test-admin-key');
    expect(get.body.data.provider).toBe('anthropic');
  });

  it('getUsage 回應含 cost 結構', async () => {
    const res = await request(app)
      .get('/api/admin/tenants/default/usage')
      .set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(200);
    expect(res.body.data.cost).toEqual(
      expect.objectContaining({ totalUsd: expect.any(Number), byModel: expect.any(Array) }),
    );
  });
});
