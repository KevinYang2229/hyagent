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
});
