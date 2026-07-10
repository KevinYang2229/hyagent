/** email.send 工具：需 email:write；未授予 → 403；授予 → 走 stub 寄出。不暴露給 Agent。 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

describe('email.send 工具', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });
  afterEach(() => scopePolicy.clear());

  it('已註冊且未暴露給 Agent', () => {
    expect(toolRegistry.has('email.send')).toBe(true);
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    expect(toolRegistry.availableFor(ctx).map((t) => t.name)).not.toContain('email.send');
  });

  it('未授予 email:write → 403', async () => {
    const t = tenantStore.createTenant('email-tool-noscope');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    await expect(
      toolRegistry.invoke('email.send', { to: 'a@x.com', subject: 's', html: '<p>h</p>' }, ctx),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('授予 email:write → 寄出（stub）', async () => {
    const t = tenantStore.createTenant('email-tool-scope');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const res = (await toolRegistry.invoke(
      'email.send',
      { to: 'a@x.com', subject: 's', html: '<p>h</p>' },
      ctx,
    )) as { messageId: string };
    expect(res.messageId).toMatch(/^STUB-/);
    expect(stubSentEmails).toHaveLength(1);
  });
});
