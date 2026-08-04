/**
 * widget config 帶出推薦問句：有生成則回傳，無則欄位不存在（前端回落 i18n）。
 *
 * 已實測 brief 原提供的手工假 res 物件（status: () => res, json: ...）：箭頭函式是
 * lazy closure，呼叫時 res 早已初始化完成，並不會撞到 TDZ、不會拋錯，機制上可運作。
 * 但改用 supertest 打真實路由，理由是行為驗證的完整度而非可運作性：
 * (1) 全庫 server/tests/ 沒有任何一支測試用「直接呼叫 controller + 手造 req/res」的寫法，
 *     一律用 supertest 打 `createApp()`（如 knowledge-admin.test.ts）——supertest 才是本專案
 *     既有慣例；
 * (2) 手造的 `{ tenant } as unknown as Request` 只有 tenant 一個欄位，繞過了
 *     resolveTenant 用 ?key=pk_ 解析租戶、掛 req.tenant 的實際路徑，測不到路由接線是否正確；
 *     supertest 版本會真正驗證 brief 介面契約寫的「GET /api/widget/config 回應」整條路徑。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();

describe('widget config 推薦問句', () => {
  it('meta 有 suggestedPrompts 時一併回傳', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-on');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual({
      'zh-Hant': '補助怎麼申請？',
      en: 'How to apply?',
    });
  });

  it('meta 無 suggestedPrompts 時欄位為 undefined', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-off');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    knowledgeStore.setMeta(tenant.id, { status: 'ready', chunkCount: 3 });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toBeUndefined();
  });

  it('status 為 none（索引已刪）但 suggestedPrompts 殘留時不得回傳', async () => {
    // 重現 B-1：刪索引與爬取失敗都不遞增世代，若 refresh 恰好在此之後才 resolve，
    // 過期的 suggestedPrompts 會殘留在 meta 裡——讀取端必須自行擋，不能只信任世代防護。
    const tenant = tenantStore.createTenant('widget-suggest-deleted');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    knowledgeStore.setMeta(tenant.id, {
      status: 'none',
      chunkCount: 0,
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toBeUndefined();
  });

  it('status 為 failed（爬取失敗）但 suggestedPrompts 殘留時不得回傳', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-failed');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    knowledgeStore.setMeta(tenant.id, {
      status: 'failed',
      chunkCount: 0,
      error: 'crawl timeout',
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toBeUndefined();
  });

  it('status 為 ready 但 chunkCount 為 0 時不得回傳', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-zero-chunk');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 0,
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toBeUndefined();
  });

  it('grantedScopes 未含 service:knowledge 時關閉（後台關掉知識庫要真的生效）', async () => {
    // 回歸：先前這裡只看 disabledServices（舊 opt-out 模型），但 scope-migration 之後
    // 沒人再寫那個欄位，導致後台把知識庫關掉、widget 仍回 knowledgeEnabled: true
    const tenant = tenantStore.createTenant('widget-suggest-scope-off');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:form'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(false);
    expect(res.body.data.suggestedPrompts).toBeUndefined();
  });

  it('grantedScopes 含 service:knowledge 時啟用', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-scope-on');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual({ 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' });
  });

  it('尚未遷移（無 grantedScopes）的租戶仍看 disabledServices（I-1：內部文件問句不得外洩）', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-disabled-service');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { disabledServices: ['knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      suggestedPrompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });

    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toBeUndefined();
    expect(res.body.data.knowledgeEnabled).toBe(false);
  });
});
