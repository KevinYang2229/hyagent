import request from 'supertest';
import { createApp } from '@/app';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };
const website = { 'zh-Hant': '網站預設問題？', en: 'Website default?' };
const file = { 'zh-Hant': '檔案預設問題？', en: 'File default?' };
function setup() {
  const tid = tenantStore.createTenant('custom-prompts').id;
  tenantStore.updateTenant(tid, { grantedScopes: ['service:knowledge'] });
  knowledgeStore.saveSource(tid, { ...knowledgeStore.getSource(tid), audience: { mode: 'public' } });
  scopePolicy.setPolicy(tid, { groups: { '—': ['kb:public'] }, accounts: {} });
  knowledgeStore.setMeta(tid, { status: 'ready', chunkCount: 2, chunkCountBySource: { website: 1, file: 1 },
    files: [{ fileId: 'f', name: 'f', chunks: 1, ingestedAt: '', visibilityScopes: ['kb:public'] }],
    suggestedPrompts: { website: { manual: website }, file: { manual: file } } });
  return { tid, url: `/api/admin/tenants/${tid}/knowledge/custom-suggestions`, key: tenantStore.createApiKey(tid, 'publishable').key };
}

it('預設兩筆；新增、修改、刪除額外提示詞同步反映到 widget，且不改預設', async () => {
  const { tid, url, key } = setup();
  const widget = () => request(app).get('/api/widget/config').query({ key }).expect(200);
  expect((await widget()).body.data.suggestedPrompts).toEqual([website, file]);
  const text = { 'zh-Hant': '還有哪些服務？', en: 'Other services?' };
  const added = await request(app).post(url).set(auth).send({ source: 'website', text }).expect(201);
  const id = added.body.data.id;
  const extra = { 'zh-Hant': '如何申請？', en: '' };
  await request(app).post(url).set(auth).send({ source: 'file', text: extra }).expect(201);
  expect((await widget()).body.data.suggestedPrompts).toEqual([website, file, text, extra]);
  const revised = { 'zh-Hant': '服務有哪些限制？', en: 'Service limits?' };
  await request(app).put(`${url}/${id}`).set(auth).send({ source: 'website', text: revised }).expect(200);
  expect((await widget()).body.data.suggestedPrompts).toEqual([website, file, revised, extra]);
  await request(app).delete(`${url}/${id}`).set(auth).expect(200);
  expect((await widget()).body.data.suggestedPrompts).toEqual([website, file, extra]);
  expect(knowledgeStore.getMeta(tid).suggestedPrompts).toEqual({ website: { manual: website }, file: { manual: file } });
});

it('限制來源可見性、無來源內容或關閉服務時，不公開額外提示詞', async () => {
  const { tid, url, key } = setup();
  const text = { 'zh-Hant': '額外網站問題？', en: '' };
  await request(app).post(url).set(auth).send({ source: 'website', text }).expect(201);
  const widget = () => request(app).get('/api/widget/config').query({ key }).expect(200);
  knowledgeStore.saveSource(tid, { ...knowledgeStore.getSource(tid), audience: { mode: 'disabled' } });
  expect((await widget()).body.data.suggestedPrompts).not.toContainEqual(text);
  knowledgeStore.saveSource(tid, { ...knowledgeStore.getSource(tid), audience: { mode: 'public' } });
  knowledgeStore.setMeta(tid, { ...knowledgeStore.getMeta(tid), chunkCountBySource: { website: 0, file: 1 } });
  expect((await widget()).body.data.suggestedPrompts).not.toContainEqual(text);
  tenantStore.updateTenant(tid, { grantedScopes: [] });
  expect((await widget()).body.data.suggestedPrompts).toEqual([]);
});

it('拒絕無管理權限、無效文字與跨租戶修改', async () => {
  const { url } = setup();
  const body = { source: 'file', text: { 'zh-Hant': '問題？', en: '' } };
  await request(app).post(url).send(body).expect(401);
  await request(app).post(url).set(auth).send({ ...body, text: { 'zh-Hant': ' ', en: '' } }).expect(422);
  await request(app).post(url).set(auth).send({ ...body, text: { 'zh-Hant': '長'.repeat(31), en: '' } }).expect(422);
  const added = await request(app).post(url).set(auth).send(body).expect(201);
  const other = setup();
  await request(app).put(`${other.url}/${added.body.data.id}`).set(auth).send(body).expect(404);
  await request(app).delete(`${other.url}/${added.body.data.id}`).set(auth).expect(404);
});
