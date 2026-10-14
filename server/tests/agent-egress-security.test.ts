import { env } from '@/config/env';
import { assertSafeEgress } from '@/lib/egress-policy';
import { getLLMProvider } from '@/lib/llm';
import { getEmbeddingProvider } from '@/lib/embedding';
import { McpConnection } from '@/modules/mcp/mcp.connection';
import { stubSentEmails } from '@/lib/email/stub.connector';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { toolRegistry } from '@/modules/tools';

afterEach(() => { jest.restoreAllMocks(); });

it('blocks nested tool results, private keys, JWTs and configured secrets without leaking matches', () => {
  for (const secret of [env.JWT_ACCESS_SECRET, '-----BEGIN PRIVATE KEY-----', `sk-proj-${'a'.repeat(30)}`, 'eyJabcdefghijk.abcdefghijkl.abcdefghijkl']) {
    try { assertSafeEgress({ messages: [{ content: secret }] }); throw new Error('not blocked'); }
    catch (err) {
      expect(err).toMatchObject({ code: 'EGRESS_BLOCKED' });
      expect((err as Error).message).not.toContain(secret);
    }
  }
});

it('enforces the LLM boundary before contacting the provider and isolates tenant rules', async () => {
  const t = tenantStore.createTenant('egress-llm');
  tenantStore.updateTenant(t.id, { egressPolicy: { sensitiveTerms: ['restricted-plan-2026'] } });
  const params = { system: 'assistant', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'restricted-plan-2026' }] }] };
  await expect(getLLMProvider(undefined, t.id).createMessage(params)).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
  expect(() => assertSafeEgress(params, 'another-tenant')).not.toThrow();
  await expect(getEmbeddingProvider(undefined, t.id).embed(['restricted-plan-2026'])).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
  const conn = new McpConnection({ id: 'blocked', name: 'blocked', url: 'https://unused.invalid/mcp', ownerTenantId: null,
    description: '', keywords: [], timeoutMs: 1000, enabled: true, toolOverrides: {}, auth: { mode: 'hyagent-jwt' }, createdAt: '' });
  await expect(conn.callTool('send', { nested: ['restricted-plan-2026'] }, { tenantId: t.id, userId: 'u', scopes: [] })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
  expect(conn.status().state).toBe('idle');
});

it('email domain restrictions apply at execution and reject multi-recipient bypasses', async () => {
  const t = tenantStore.createTenant('egress-email');
  tenantStore.updateTenant(t.id, { egressPolicy: { allowedEmailDomains: ['example.com'] } });
  const ctx = { tenantId: t.id, userId: 'u', scopes: ['email:write'] };
  const send = (to: string, html = 'hello') => toolRegistry.invoke('email.send', { to, subject: 's', html }, ctx);
  const before = stubSentEmails.length;
  for (const to of ['u@other.com', 'u@example.com,attacker@other.com', 'u@example.com\r\nBcc: a@other.com', 'u@sub.example.com']) {
    await expect(send(to)).rejects.toMatchObject({ statusCode: expect.any(Number) });
  }
  await expect(send('u@example.com', env.JWT_ACCESS_SECRET)).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
  expect(stubSentEmails).toHaveLength(before);
  await expect(send('u@EXAMPLE.com')).resolves.toMatchObject({ status: 'sent' });
  tenantStore.updateTenant(t.id, { egressPolicy: { allowedEmailDomains: [] } });
  await expect(send('u@example.com')).rejects.toMatchObject({ code: 'EMAIL_DOMAIN_BLOCKED' });
});
