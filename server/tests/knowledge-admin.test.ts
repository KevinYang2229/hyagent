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
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '@/config/env';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { createApp } from '@/app';
import { startIngestJob } from '@/modules/knowledge/knowledge.job';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

describe('admin knowledge API', () => {
  it('批次程序寫入的檔案不需重啟即可出現在清單與權限盤點', async () => {
    const tenantId = `external-batch-${Date.now()}`;
    knowledgeStore.setMeta(tenantId, { status: 'none', chunkCount: 0 });
    const path = resolve(process.cwd(), env.KNOWLEDGE_INDEX_DIR, 'knowledge-config.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const file = { fileId: 'external-file', name: 'batch.txt', chunks: 2, ingestedAt: '2026-09-17' };
    raw.metas = raw.metas.map(([id, meta]: [string, unknown]) => [id, id === tenantId
      ? { status: 'ready', chunkCount: 2, files: [file] } : meta]);
    writeFileSync(path, JSON.stringify(raw));
    expect(knowledgeStore.getMeta(tenantId).files).toBeUndefined();

    // 盤點可獨立刷新，不依賴清單 API 先執行。
    const report = await request(app).get(`/api/admin/tenants/${tenantId}/knowledge/acl-report`).set(auth).expect(200);
    expect(report.body.data.unlabeled).toEqual([file]);
    const res = await request(app).get(`/api/admin/tenants/${tenantId}/knowledge`).set(auth).expect(200);
    expect(res.body.data.meta.files).toEqual([file]);
  });

  it('PUT source 後 GET 讀回', async () => {
    await request(app)
      .put('/api/admin/tenants/default/knowledge/source')
      .set(auth)
      .send({
        startUrl: 'https://x.com',
        renderJavaScript: true,
        renderWaitMs: 2200,
        maxPages: 30,
        chunkChars: 600,
        embeddingModel: 'text-embedding-3-large',
        rerank: true,
      })
      .expect(200);

    const res = await request(app).get('/api/admin/tenants/default/knowledge').set(auth).expect(200);
    expect(res.body.data.source.startUrl).toBe('https://x.com');
    expect(res.body.data.source.renderJavaScript).toBe(true);
    expect(res.body.data.source.renderWaitMs).toBe(2200);
    expect(res.body.data.meta.status).toBeDefined();
  });

  it.each([-1, 10001, 1.5])('拒絕不合法的瀏覽器等待時間 %s', async (renderWaitMs) => {
    await request(app).put('/api/admin/tenants/default/knowledge/source').set(auth)
      .send({ startUrl: 'https://example.com', renderJavaScript: true, renderWaitMs }).expect(422);
  });

  it('檔案 RAG 可在未設定網站時儲存共用解析設定', async () => {
    const tenantId = 'file-only-source-tenant';
    await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/source`)
      .set(auth)
      .send({
        startUrl: '',
        maxPages: 100,
        chunkChars: 600,
        embeddingModel: 'text-embedding-3-large',
        rerank: true,
      })
      .expect(200);

    const res = await request(app)
      .get(`/api/admin/tenants/${tenantId}/knowledge`)
      .set(auth)
      .expect(200);
    expect(res.body.data.source).toMatchObject({ startUrl: '', chunkChars: 600 });
  });

  it('非空的網站來源仍必須是合法 URL', async () => {
    await request(app)
      .put('/api/admin/tenants/invalid-url-tenant/knowledge/source')
      .set(auth)
      .send({
        startUrl: 'not-a-url',
        maxPages: 100,
        chunkChars: 800,
        embeddingModel: 'text-embedding-3-large',
        rerank: true,
      })
      .expect(422);
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
