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
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

// 本檔「刪除標籤同時撤銷孤兒授權」案例直接呼叫 scopePolicy.setPolicy 造資料（繞過 HTTP），
// 比照其餘會寫 scopePolicy 的測試檔（resolve-scopes/scope-policy/admin-policy 等）在每案例後清空，
// 不依賴「每個 jest 測試檔各自持有獨立模組實例」這件事本身去保證乾淨——那是目前的實作細節，
// 不是這裡要驗證的東西，顯式清理才是不管未來 test runner／isolation 策略怎麼變都成立的保證。
afterEach(() => scopePolicy.clear());

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
    const tid = tenantStore.createTenant('acl-admin-t1').id;
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

  it('對不存在的租戶建標籤回 404', async () => {
    await request(app)
      .post('/api/admin/tenants/acl-admin-no-such-tenant/knowledge/labels')
      .set(auth)
      .send({ id: 'hr', label: '人資' })
      .expect(404);
  });

  it('標註檔案後讀得回標籤', async () => {
    const tid = tenantStore.createTenant('acl-admin-t3').id;
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
    const tid = tenantStore.createTenant('acl-admin-t5').id;
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

  /**
   * 刪標籤留下孤兒授權，同名重建即靜默復權（見 scope-policy.test.ts 的單元測試）。
   * 這裡驗證端到端：deleteLabel 這個 HTTP 端點真的把授權清掉、且回報筆數，
   * 不是只驗證 scopePolicy.revokeScope 這個函式本身有沒有被寫對。
   */
  it('刪除標籤同時撤銷 scopePolicy 的孤兒授權，並回報 revokedGrants；同名重建不會復權', async () => {
    const tid = tenantStore.createTenant('acl-admin-t6').id;
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資' })
      .expect(201);
    // 指派給兩個部門，比照 findings 的失效情境（人資部 + 稽核部）
    scopePolicy.setPolicy(tid, { groups: { 人資部: ['kb:hr'], 稽核部: ['kb:hr'] }, accounts: {} });

    const res = await request(app)
      .delete(`/api/admin/tenants/${tid}/knowledge/labels/hr`)
      .set(auth)
      .expect(200);

    expect(res.body.data.revokedGrants).toBe(2);
    expect(scopePolicy.getPolicy(tid).groups).toEqual({ 人資部: [], 稽核部: [] });

    // 隔天重建同名標籤：舊授權不該原封不動復活
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資（重建）' })
      .expect(201);
    expect(scopePolicy.groupScopes(tid, '稽核部')).toEqual([]);
  });
});

/**
 * PUT /knowledge/source 的 visibilityScopes 此前不驗證是否為該租戶已知標籤
 * ——同一個 sourceSchema 欄位，PATCH .../files/:fileId/visibility 有驗、
 * PUT .../knowledge/source 沒有，是同一條規則的兩處各寫一份、其中一份漏寫。
 */
describe('PUT /knowledge/source 的 visibilityScopes 驗證已知標籤', () => {
  it('未知標籤回 400', async () => {
    const tid = tenantStore.createTenant('acl-source-scope-unknown').id;
    await request(app)
      .put(`/api/admin/tenants/${tid}/knowledge/source`)
      .set(auth)
      .send({
        startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
        embeddingModel: 'm', rerank: true, visibilityScopes: ['kb:nope'],
      })
      .expect(400);
  });

  it('已知標籤正常儲存', async () => {
    const tid = tenantStore.createTenant('acl-source-scope-known').id;
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'public', label: '公開' })
      .expect(201);

    const res = await request(app)
      .put(`/api/admin/tenants/${tid}/knowledge/source`)
      .set(auth)
      .send({
        startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
        embeddingModel: 'm', rerank: true, visibilityScopes: ['kb:public'],
      })
      .expect(200);

    expect(res.body.data.visibilityScopes).toEqual(['kb:public']);
  });

  it('不帶 visibilityScopes 仍照常儲存（該欄位選填，未涉及驗證路徑）', async () => {
    const tid = tenantStore.createTenant('acl-source-scope-omitted').id;
    await request(app)
      .put(`/api/admin/tenants/${tid}/knowledge/source`)
      .set(auth)
      .send({
        startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
        embeddingModel: 'm', rerank: true,
      })
      .expect(200);
  });
});

/**
 * 三態旗標的控制面：patchTenantSchema 此前沒有 knowledgeAcl 欄位，PATCH tenant
 * 沒有端點可切換，上線程序「切 shadow、切 on」與「回滾＝改一個字，三十秒」都做不到，
 * 實際要人工改持久化 JSON／DB 列再重啟——而白名單（tenant.store.ts 的 updateTenant）
 * 其實已經支援這個欄位，缺的只是 schema 這一道門。這裡驗證 PATCH 端點打通了。
 */
describe('ACL cannot be disabled by the administration API', () => {
  it.each(['off', 'shadow', 'maybe'])('rejects knowledgeAcl=%s', async (mode) => {
    const t = tenantStore.createTenant('acl-enforced');
    await request(app).patch(`/api/admin/tenants/${t.id}`).set(auth).send({ knowledgeAcl: mode }).expect(422);
    expect(tenantStore.getTenant(t.id)?.knowledgeAcl).toBe('on');
  });
  it('accepts explicit on', async () => {
    const t = tenantStore.createTenant('acl-on');
    await request(app).patch(`/api/admin/tenants/${t.id}`).set(auth).send({ knowledgeAcl: 'on' }).expect(200);
  });
});
