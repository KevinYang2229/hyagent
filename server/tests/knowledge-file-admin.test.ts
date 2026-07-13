/**
 * 知識庫檔案上傳/刪除 admin API 整合測試（supertest）。
 * 比照 knowledge-admin.test.ts 的 app/x-admin-key 建立模式；mock embedding 同 knowledge-file.test.ts。
 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  }),
}));

import request from 'supertest';
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
