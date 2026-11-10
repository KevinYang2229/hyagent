/**
 * 知識庫單檔上限由環境變數 KNOWLEDGE_FILE_MAX_MB 控制：上傳把關與 GET 回傳給前端顯示的值要一致。
 * env 在模組載入時解析，所以要在 import app 之前設定。
 */
process.env.KNOWLEDGE_FILE_MAX_MB = '1';

import request from 'supertest';
import { createApp } from '@/app';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };
const tenantId = 'kfile-maxmb-tenant';

describe('KNOWLEDGE_FILE_MAX_MB', () => {
  it('超過設定的上限 → 413，訊息帶設定值', async () => {
    const res = await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/files`)
      .set(auth)
      .attach('file', Buffer.alloc(1.5 * 1024 * 1024, 'a'), 'big.txt');
    expect(res.status).toBe(413);
    expect(res.body.error.message).toContain('1MB');
  });

  it('GET 知識庫回傳 fileMaxMb，供前端提示文字使用', async () => {
    const res = await request(app).get(`/api/admin/tenants/${tenantId}/knowledge`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.fileMaxMb).toBe(1);
  });
});
