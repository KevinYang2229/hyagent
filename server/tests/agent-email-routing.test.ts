/** pendingEmail 存在時，路由強制回 agent（讓確認閘收到確認/取消輪）。 */
import { intentRouter } from '@/modules/conversation/intent-router';
import type { Session } from '@/modules/conversation/conversation.types';
import { tenantStore } from '@/modules/tenant/tenant.store';

function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's', tenantId, userId: 'kevin', formId: 'leave-request', values: {},
    status: 'collecting', activeServiceId: 'agent', messages: [],
    createdAt: new Date().toISOString(), ...partial,
  };
}

it('有 pendingEmail → 路由回 agent（0 token）', async () => {
  const t = tenantStore.createTenant('email-route');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
  const session = makeSession(t.id, { pendingEmail: { to: 'a@x.com', subject: 's', html: '<p>x</p>' } });
  const r = await intentRouter.route(session, '確認');
  expect(r.serviceId).toBe('agent');
  expect(r.viaLLM).toBe(false);
});

it('無 pendingEmail → 不強制 agent（一般路由）', async () => {
  const t = tenantStore.createTenant('email-route-none');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:agent'] });
  const session = makeSession(t.id, { activeServiceId: undefined });
  const r = await intentRouter.route(session, '我要請假');
  expect(r.serviceId).not.toBe('agent'); // 應走 form（關鍵字命中）
});

it('agent 蒐集資訊途中（activeServiceId=agent）的無關鍵字回答留在 agent（多輪不被沖回 form）', async () => {
  const t = tenantStore.createTenant('email-route-multiturn');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:agent'] });
  // 模擬：agent 已問「主旨？」，使用者回答主旨（無任何服務關鍵字、無知識語氣詞）。
  // 逐字稿為「對話中」（非首問）——首問輪會交給分類器（見 intent-router 首問邏輯）。
  const session = makeSession(t.id, {
    activeServiceId: 'agent',
    status: 'collecting',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '幫我寄信給主管' }] },
      { role: 'assistant', content: [{ type: 'text', text: '請問主旨與內容？' }] },
      { role: 'user', content: [{ type: 'text', text: '主旨：關於合作提案' }] },
    ],
  });
  const r = await intentRouter.route(session, '主旨：關於合作提案');
  expect(r.serviceId).toBe('agent'); // 留在 agent 繼續擬稿，不被沖回 form
  expect(r.viaLLM).toBe(false);
});

it('明確「寄信給X」→ 關鍵字 0-token 路由到 agent（不 fallback 到 form）', async () => {
  const t = tenantStore.createTenant('email-route-kw');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:agent'] });
  const session = makeSession(t.id, { activeServiceId: undefined });
  const r = await intentRouter.route(session, '我要寄信給王小明');
  expect(r.serviceId).toBe('agent');
  expect(r.viaLLM).toBe(false); // 關鍵字命中，不動用 Haiku
});
