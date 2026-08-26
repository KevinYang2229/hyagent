/**
 * 標籤 CRUD 與檔案標註（supertest，x-admin-key 由 setup-env 設為 test-admin-key）。
 *
 * 刪除標籤時，使用中的文件回到「未標記（鎖住）」，不得變公開
 * ——刪除操作絕不能是提權操作。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { createApp } from '@/app';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantGrantableScopes } from '@/modules/authz/scope-catalog';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

/** 在 meta 中放一筆檔案，供標註與刪除標籤的案例使用 */
function seedFile(tenantId: string, fileId: string, scopes?: string[]): void {
  knowledgeStore.addFileMeta(
    tenantId,
    {
      fileId,
      name: `${fileId}.pdf`,
      chunks: 3,
      ingestedAt: new Date().toISOString(),
      ...(scopes ? { visibilityScopes: scopes } : {}),
    },
    {},
  );
}

describe('知識庫標籤 admin API', () => {
  it('建立標籤後出現在可授予 scope 清單', async () => {
    const tid = 'acl-admin-t1';
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資文件' })
      .expect(201);

    expect(tenantGrantableScopes(tid).map((x) => x.id)).toContain('kb:hr');
  });

  it('labelId 格式不合回 400', async () => {
    await request(app)
      .post('/api/admin/tenants/acl-admin-t2/knowledge/labels')
      .set(auth)
      .send({ id: 'HR', label: '大寫不合法' })
      .expect(400);
  });

  it('標註檔案後讀得回標籤', async () => {
    const tid = 'acl-admin-t3';
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資' })
      .expect(201);
    seedFile(tid, 'f1');

    const res = await request(app)
      .patch(`/api/admin/tenants/${tid}/knowledge/files/f1/visibility`)
      .set(auth)
      .send({ scopes: ['kb:hr'] })
      .expect(200);

    expect(res.body.data.scopes).toEqual(['kb:hr']);
    const file = (knowledgeStore.getMeta(tid).files ?? []).find((f) => f.fileId === 'f1');
    expect(file?.visibilityScopes).toEqual(['kb:hr']);
  });

  it('標註未知標籤回 400', async () => {
    const tid = 'acl-admin-t4';
    seedFile(tid, 'f1');
    await request(app)
      .patch(`/api/admin/tenants/${tid}/knowledge/files/f1/visibility`)
      .set(auth)
      .send({ scopes: ['kb:nope'] })
      .expect(400);
  });

  it('刪除標籤：回報使用中文件數，且該檔變成未標記而非公開', async () => {
    const tid = 'acl-admin-t5';
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資' })
      .expect(201);
    seedFile(tid, 'f1', ['kb:hr']);

    const res = await request(app)
      .delete(`/api/admin/tenants/${tid}/knowledge/labels/hr`)
      .set(auth)
      .expect(200);

    expect(res.body.data.affectedFiles).toBe(1);
    const file = (knowledgeStore.getMeta(tid).files ?? []).find((f) => f.fileId === 'f1');
    // 關鍵：標籤被移除後是空陣列（誰都看不到），不是「沒有限制」
    expect(file?.visibilityScopes).toEqual([]);
    expect(tenantGrantableScopes(tid).map((x) => x.id)).not.toContain('kb:hr');
  });
});
