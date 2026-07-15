/**
 * 知識庫檔案上傳/刪除 admin API 整合測試（supertest）。
 * 比照 knowledge-admin.test.ts 的 app/x-admin-key 建立模式；mock embedding 同 knowledge-file.test.ts。
 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [0.1, 0.2, 0.3]), tokens: texts.length * 10 }),
  }),
}));
// 上傳流程會產全文摘要 chunk：mock LLM 避免測試打真實 API
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({
    name: 'mock',
    createMessage: async () => ({
      text: '本文件為公司規章摘要，說明特休與請假申請流程。',
      toolCalls: [],
      stopReason: 'end_turn',
    }),
  }),
}));

import request from 'supertest';
import { startIngestJob } from '@/modules/knowledge/knowledge.job';
import { createApp } from '@/app';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };
const tenantId = 'kfile-admin-tenant';

describe('admin knowledge file API', () => {
  it('上傳 txt → 201 且 GET 知識庫可見 files；刪除後消失', async () => {
    const text = '請假規定：特休依年資計算。'.repeat(80); // 足量文字，可切出多個 chunk

    const uploadRes = await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/files`)
      .set(auth)
      .attach('file', Buffer.from(text), '規章.txt')
      .expect(201);

    expect(uploadRes.body.data.fileId).toBeDefined();
    expect(uploadRes.body.data.chunks).toBeGreaterThan(0);
    expect(uploadRes.body.data.name).toBe('規章.txt');

    const getRes = await request(app)
      .get(`/api/admin/tenants/${tenantId}/knowledge`)
      .set(auth)
      .expect(200);
    expect(
      getRes.body.data.meta.files?.some((f: { fileId: string }) => f.fileId === uploadRes.body.data.fileId),
    ).toBe(true);

    await request(app)
      .delete(`/api/admin/tenants/${tenantId}/knowledge/files/${uploadRes.body.data.fileId}`)
      .set(auth)
      .expect(200)
      .then((res) => {
        expect(res.body.data.fileId).toBe(uploadRes.body.data.fileId);
      });

    const getAfterRes = await request(app)
      .get(`/api/admin/tenants/${tenantId}/knowledge`)
      .set(auth)
      .expect(200);
    expect(
      getAfterRes.body.data.meta.files?.some((f: { fileId: string }) => f.fileId === uploadRes.body.data.fileId),
    ).toBe(false);
  });

  it('上傳不支援格式（.exe）→ 400', async () => {
    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/files`)
      .set(auth)
      .attach('file', Buffer.from('x'), 'virus.exe')
      .expect(400);
  });

  it('未帶檔案 → 400', async () => {
    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/files`)
      .set(auth)
      .expect(400);
  });

  it('刪除不存在的 fileId → 404', async () => {
    await request(app)
      .delete(`/api/admin/tenants/${tenantId}/knowledge/files/not-exist-id`)
      .set(auth)
      .expect(404);
  });
});

describe('索引競態守門：爬網 job 進行中', () => {
  it('上傳/刪除檔案回 409（避免與 runIngest 的 read-modify-write 互蓋）', async () => {
    const raceTenant = 'kfile-race-tenant';
    // 注入永不完成的 run，製造「進行中」job（getRunningJobForTenant 命中）
    const never = () => new Promise<never>(() => {});
    startIngestJob(
      { tenantId: raceTenant, startUrl: 'https://x.com', maxPages: 1, chunkChars: 800, embeddingModel: 'm' },
      never as never,
    );

    await request(app)
      .post(`/api/admin/tenants/${raceTenant}/knowledge/files`)
      .set(auth)
      .attach('file', Buffer.from('內容'.repeat(50)), 'race.txt')
      .expect(409);

    await request(app)
      .delete(`/api/admin/tenants/${raceTenant}/knowledge/files/whatever`)
      .set(auth)
      .expect(409);
  });
});
