/** email.propose：暴露給 Agent、需 email:write、回草稿但不寄（stub 無寄件）。 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

describe('email.propose 工具', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('已註冊、授予 email:write 時出現在 Agent availableFor', () => {
    expect(toolRegistry.has('email.propose')).toBe(true);
    const t = tenantStore.createTenant('propose-avail');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    expect(toolRegistry.availableFor(ctx).map((x) => x.name)).toContain('email.propose');
  });

  it('invoke 回草稿但不寄出（stubSentEmails 為空）', async () => {
    const t = tenantStore.createTenant('propose-nosend');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const res = (await toolRegistry.invoke(
      'email.propose',
      { to: 'a@x.com', subject: '嗨', html: '<p>hi</p>' },
      ctx,
    )) as { proposed: boolean; draft: { to: string } };
    expect(res.proposed).toBe(true);
    expect(res.draft.to).toBe('a@x.com');
    expect(stubSentEmails).toHaveLength(0); // 沒真的寄
  });
});
