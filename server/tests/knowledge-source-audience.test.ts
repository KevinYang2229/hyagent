import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { visibilityScopesOf, guestVisibilityScopesOf, currentChunkScopes } from '@/modules/knowledge/knowledge.visibility';
import { WEBSITE_ACCESS_SCOPE } from '@/modules/knowledge/source-access';
import { promptAclFingerprint } from '@/modules/knowledge/prompt-visibility';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };
function setup() {
  const tenantId = tenantStore.createTenant('source-audience').id;
  tenantStore.updateTenant(tenantId, {
    knowledgeLabels: [{ id: 'hr', label: '人資' }],
    userDirectory: [
      { id: 'hr-user', name: 'HR', department: '人資部' },
      { id: 'it-user', name: 'IT', department: '資訊部' },
    ],
  });
  scopePolicy.setPolicy(tenantId, { groups: { '人資部': ['kb:hr'] }, accounts: {} });
  knowledgeStore.addFileMeta(tenantId, { fileId: 'private', name: 'private.pdf', chunks: 1, ingestedAt: '', visibilityScopes: ['kb:hr'] }, {});
  return tenantId;
}
async function save(tenantId: string, audience: unknown, status = 200) {
  return request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(auth)
    .send({ ...knowledgeStore.getSource(tenantId), startUrl: 'https://example.com', audience }).expect(status);
}

it('公開網站授予訪客及所有部門，但不改動檔案或共用授權', async () => {
  const tenantId = setup();
  const policy = scopePolicy.getPolicy(tenantId);
  await save(tenantId, { mode: 'public' });
  expect(guestVisibilityScopesOf(tenantId)).toEqual([WEBSITE_ACCESS_SCOPE]);
  for (const userId of ['', 'unknown', 'hr-user', 'it-user']) {
    expect(visibilityScopesOf({ tenantId, userId })).toContain(WEBSITE_ACCESS_SCOPE);
  }
  expect(visibilityScopesOf({ tenantId, userId: 'it-user' })).not.toContain('kb:hr');
  expect(currentChunkScopes(tenantId, { fileId: 'private' })).toEqual(['kb:hr']);
  expect(scopePolicy.getPolicy(tenantId)).toEqual(policy);
  const report = await request(app).get(`/api/admin/tenants/${tenantId}/knowledge/acl-report`).set(auth).expect(200);
  expect(report.body.data.guest).toMatchObject({ source: true, files: 0 });
});

it('指定部門僅允許該租戶的部門成員，訪客與其他租戶不可查詢', async () => {
  const tenantId = setup();
  await save(tenantId, { mode: 'departments', departments: ['人資部'] });
  expect(visibilityScopesOf({ tenantId, userId: 'hr-user' })).toContain(WEBSITE_ACCESS_SCOPE);
  for (const userId of ['', 'unknown', 'it-user']) {
    expect(visibilityScopesOf({ tenantId, userId })).not.toContain(WEBSITE_ACCESS_SCOPE);
  }
  expect(guestVisibilityScopesOf(tenantId)).not.toContain(WEBSITE_ACCESS_SCOPE);
  expect(visibilityScopesOf({ tenantId: 'other-tenant', userId: 'hr-user' })).not.toContain(WEBSITE_ACCESS_SCOPE);
});

it('公開改為暫不開放後，舊網站快取與推薦詞指紋立即失效，檔案維持原權限', async () => {
  const tenantId = setup();
  await save(tenantId, { mode: 'public' });
  const fingerprint = promptAclFingerprint(tenantId);
  await save(tenantId, { mode: 'disabled' });
  expect(currentChunkScopes(tenantId, { visibilityScopes: [WEBSITE_ACCESS_SCOPE] })).toEqual([]);
  expect(guestVisibilityScopesOf(tenantId)).not.toContain(WEBSITE_ACCESS_SCOPE);
  expect(promptAclFingerprint(tenantId)).not.toBe(fingerprint);
  expect(currentChunkScopes(tenantId, { fileId: 'private' })).toEqual(['kb:hr']);
});

it('進階模式仍驗證標籤，拒絕用保留 scope 授權檔案', async () => {
  const tenantId = setup();
  await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(auth)
    .send({ ...knowledgeStore.getSource(tenantId), visibilityScopes: ['kb:hr'], audience: { mode: 'labels' } }).expect(200);
  expect(currentChunkScopes(tenantId, {})).toEqual(['kb:hr']);
  await request(app).patch(`/api/admin/tenants/${tenantId}/knowledge/files/private/visibility`).set(auth)
    .send({ scopes: [WEBSITE_ACCESS_SCOPE] }).expect(400);
});

it('拒絕空部門、未知部門及訪客部門', async () => {
  const tenantId = setup();
  await save(tenantId, { mode: 'departments', departments: [] }, 422);
  await save(tenantId, { mode: 'departments', departments: ['不存在'] }, 400);
  await save(tenantId, { mode: 'departments', departments: ['—'] }, 400);
});
