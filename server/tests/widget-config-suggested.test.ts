/**
 * widget config 帶出推薦問句：欄位恆為陣列（0～2 筆，有效句 = manual ?? generated）。
 * i18n 後備句已被刻意移除——沒有推薦句時回空陣列，前端不再回落到 i18n 固定文案，
 * 避免舊索引或索引已刪的租戶顯示過期／不相關內容。
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
import { promptAclFingerprint } from '@/modules/knowledge/prompt-visibility';
import { createApp } from '@/app';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';

const app = createApp();

describe('widget config 推薦問句', () => {
  it('兩種來源都有句子時回兩筆，網站在前', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-two');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 5,
      chunkCountBySource: { website: 3, file: 2 },
      suggestedPrompts: {
        website: { generated: { 'zh-Hant': '網站句？', en: 'Website?' } },
        file: { generated: { 'zh-Hant': '檔案句？', en: 'File?' } },
      },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([
      { 'zh-Hant': '網站句？', en: 'Website?' },
      { 'zh-Hant': '檔案句？', en: 'File?' },
    ]);
  });

  it('manual 蓋過 generated', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-manual');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: {
        website: {
          generated: { 'zh-Hant': '自動句？', en: 'Auto?' },
          manual: { 'zh-Hant': '手動句？', en: 'Manual?' },
        },
      },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '手動句？', en: 'Manual?' }]);
  });

  it('該來源 chunks 為 0 時不輸出該格，即使有 manual', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-zero-source');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: {
        website: { generated: { 'zh-Hant': '網站句？', en: 'Website?' } },
        file: { manual: { 'zh-Hant': '檔案手動句？', en: 'File manual?' } },
      },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '網站句？', en: 'Website?' }]);
  });

  it('meta 無 suggestedPrompts 時回空陣列', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-off');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([]);
  });

  it('status 為 none（索引已刪）但 suggestedPrompts 殘留時回空陣列', async () => {
    // 重現 B-1：刪索引與爬取失敗都不遞增世代，若 refresh 恰好在此之後才 resolve，
    // 過期的 suggestedPrompts 會殘留在 meta 裡——讀取端必須自行擋，不能只信任世代防護。
    const tenant = tenantStore.createTenant('widget-suggest-deleted');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'none',
      chunkCount: 0,
      chunkCountBySource: { website: 0, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([]);
  });

  it('status 為 failed（爬取失敗）但 suggestedPrompts 殘留時回空陣列', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-failed');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'failed',
      chunkCount: 0,
      chunkCountBySource: { website: 0, file: 0 },
      error: 'crawl timeout',
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([]);
  });

  it('status 為 ready 但 chunkCount 為 0 時回空陣列', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-zero-chunk');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 0,
      chunkCountBySource: { website: 0, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([]);
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
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(false);
    expect(res.body.data.suggestedPrompts).toEqual([]);
  });

  it('grantedScopes 含 service:knowledge 時啟用', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-scope-on');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' }]);
  });

  it('尚未遷移（無 grantedScopes）的租戶仍看 disabledServices（I-1：內部文件問句不得外洩）', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-disabled-service');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { disabledServices: ['knowledge'] });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.suggestedPrompts).toEqual([]);
    expect(res.body.data.knowledgeEnabled).toBe(false);
  });
  /*
   * 回歸：knowledgeEnabled 先前只讀租戶層 grantedScopes（權限頁的「全租戶」），
   * 看不到指派給訪客部門的授權。但訪客真正問得到什麼，是由 serviceRegistry.enabledFor
   * → resolveGuestScopes 的聯集模型決定（租戶 ∪ 訪客部門零散 ∪ 訪客部門角色能力）。
   * 兩道判準不一致的症狀：管理者用「角色能力」開通知識庫、權限頁維持「未開通」，
   * 訪客問得到答案，chip 與推薦詞卻整排消失。
   */
  it('角色能力把 service:knowledge 指派給訪客部門時啟用（權限頁維持未開通）', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-bundle-guest');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: [] });
    scopePolicy.setPolicy(tenant.id, {
      groups: {},
      accounts: {},
      bundles: [{ id: 'guest-kb', name: '訪客問答', scopes: ['service:knowledge'] }],
      groupBundles: { '—': ['guest-kb'] },
    });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' }]);
  });

  it('訪客部門的零散授權同樣啟用（權限頁選「指定對象」只勾訪客）', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-group-guest');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: [] });
    scopePolicy.setPolicy(tenant.id, { groups: { '—': ['service:knowledge'] }, accounts: {} });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual([{ 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' }]);
  });

  it('只指派給一般部門、訪客部門沒有時仍關閉（不得越權外洩）', async () => {
    const tenant = tenantStore.createTenant('widget-suggest-bundle-staff-only');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { grantedScopes: [] });
    scopePolicy.setPolicy(tenant.id, {
      groups: { 人資部: ['service:knowledge'] },
      accounts: {},
      bundles: [{ id: 'hr-kb', name: '人資問答', scopes: ['service:knowledge'] }],
      groupBundles: { 人資部: ['hr-kb'] },
    });
    knowledgeStore.setMeta(tenant.id, {
      status: 'ready',
      chunkCount: 3,
      chunkCountBySource: { website: 3, file: 0 },
      suggestedPrompts: { website: { generated: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' } } },
    });

    const fingerprint = promptAclFingerprint(tenant.id);
    knowledgeStore.setMeta(tenant.id, { ...knowledgeStore.getMeta(tenant.id), generatedPromptAcl: { website: fingerprint, file: fingerprint } });
    const res = await request(app).get('/api/widget/config').query({ key: apiKey.key }).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(false);
    expect(res.body.data.suggestedPrompts).toEqual([]);
  });
});
