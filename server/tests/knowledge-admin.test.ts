/**
 * 知識庫 admin API 整合測試（supertest）：來源設定存取 + 未設來源時觸發解析被擋。
 * 用 x-admin-key（setup-env 設 ADMIN_API_KEY=test-admin-key）。不觸發真實爬取/embedding。
 */
// fixture 用 chunks: [] 恰好走不到 refreshSuggestedPrompts 裡的 LLM 呼叫（見 knowledge.suggest.ts
// 空 chunks 提早 return），屬巧合式安全；明確 mock 掉，未來任何一支測試改用非空 chunks 也不會
// 打到真實 LLM API（比照 knowledge-job.test.ts 已有的做法）。
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { createApp } from '@/app';
import { startIngestJob } from '@/modules/knowledge/knowledge.job';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

describe('admin knowledge API', () => {
  it('PUT source 後 GET 讀回', async () => {
    await request(app)
      .put('/api/admin/tenants/default/knowledge/source')
      .set(auth)
      .send({
        startUrl: 'https://x.com',
        maxPages: 30,
        chunkChars: 600,
        embeddingModel: 'text-embedding-3-large',
        rerank: true,
      })
      .expect(200);

    const res = await request(app).get('/api/admin/tenants/default/knowledge').set(auth).expect(200);
    expect(res.body.data.source.startUrl).toBe('https://x.com');
    expect(res.body.data.meta.status).toBeDefined();
  });

  it('缺 startUrl 觸發 ingest → 422', async () => {
    await request(app)
      .post('/api/admin/tenants/no-src-tenant-xyz/knowledge/ingest')
      .set(auth)
      .send({})
      .expect(422);
  });

  it('未帶 admin key → 401/403', async () => {
    const res = await request(app).get('/api/admin/tenants/default/knowledge');
    expect([401, 403]).toContain(res.status);
  });

  it('GET job 回傳既有 job（:jobId 不被 param 驗證剝除）', async () => {
    const idx: KnowledgeIndexFile = { generatedAt: 't', model: 'm', source: 's', chunks: [] };
    const fakeRun = async () => {
      await new Promise((r) => setTimeout(r, 80));
      return idx;
    };
    const job = startIngestJob(
      { tenantId: 'job-route-tenant', startUrl: 'https://x.com', maxPages: 1, chunkChars: 800, embeddingModel: 'm' },
      fakeRun as never,
    );
    const res = await request(app)
      .get(`/api/admin/tenants/job-route-tenant/knowledge/jobs/${job.id}`)
      .set(auth)
      .expect(200);
    expect(res.body.data.id).toBe(job.id);
  });
});
