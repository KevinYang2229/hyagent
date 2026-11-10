import { decideTenantAdmin, findRouteRule } from '../src/modules/admin-account/admin-route-policy';
import type { AdminTabPermissions } from '@hyagent/shared';

const perms = { knowledge: 'read', settings: 'write', appearance: 'read' } as const;
const t = (method: string, path: string, body?: unknown) =>
  decideTenantAdmin({ method, path, body, tenantId: 'aaa111', permissions: perms }).allow;

describe('admin-route-policy', () => {
  it('只能存取自己的租戶', () => {
    expect(t('GET', '/tenants/aaa111/knowledge')).toBe(true);
    expect(t('GET', '/tenants/bbb222/knowledge')).toBe(false);
    expect(t('GET', '/TENANTS/aaa111/knowledge/')).toBe(true);
    expect(t('GET', '/tenants/aaa111%2F..%2Fbbb222/knowledge')).toBe(false);
  });
  it('唯讀只能 GET／HEAD', () => {
    expect(t('HEAD', '/tenants/aaa111/knowledge')).toBe(true);
    expect(t('POST', '/tenants/aaa111/knowledge/query-test')).toBe(false);
    expect(t('POST', '/tenants/aaa111/knowledge/suggestion')).toBe(false);
  });
  it('hidden 分頁讀寫都拒絕', () => {
    expect(t('GET', '/tenants/aaa111/webhooks')).toBe(false);
  });
  it('alsoReadableBy：知識庫唯讀可讀 policy，但不能寫', () => {
    expect(t('GET', '/tenants/aaa111/policy')).toBe(true);
    expect(t('PUT', '/tenants/aaa111/policy')).toBe(false);
  });
  it('PATCH /tenants/:id 依欄位判斷', () => {
    expect(t('PATCH', '/tenants/aaa111', { name: 'x', allowedOrigins: [] })).toBe(true);
    expect(t('PATCH', '/tenants/aaa111', { name: 'x', quotaMonthlyLlmTokens: 0 })).toBe(false);
    expect(t('PATCH', '/tenants/aaa111', { appearance: {} })).toBe(false); // appearance 只有 read
    expect(t('PATCH', '/tenants/aaa111', { unknownField: 1 })).toBe(false);
    expect(t('PATCH', '/tenants/aaa111', {})).toBe(false);
    expect(t('PATCH', '/tenants/aaa111', null)).toBe(false);
    expect(t('PATCH', '/tenants/aaa111', [])).toBe(false);
  });
  it('POST /tenants/:id/keys：私密金鑰（sk_）要基本設定與 AI 模型都可編輯；公開金鑰只要基本設定', () => {
    const d = (permissions: AdminTabPermissions, body: unknown) =>
      decideTenantAdmin({ method: 'POST', path: '/tenants/aaa111/keys', body, tenantId: 'aaa111', permissions });
    expect(d({ settings: 'write' }, { type: 'publishable' }).allow).toBe(true);
    const secretDenied = d({ settings: 'write', ai: 'read' }, { type: 'secret' });
    expect(secretDenied.allow).toBe(false);
    expect(secretDenied.allow === false && secretDenied.reason).toContain('AI 模型');
    expect(d({ settings: 'write', ai: 'write' }, { type: 'secret' }).allow).toBe(true);
    expect(d({ ai: 'write' }, { type: 'secret' }).allow).toBe(false);
    expect(d({ settings: 'read', ai: 'write' }, { type: 'publishable' }).allow).toBe(false);
    // 沒帶 type 或格式不對：一律當成私密金鑰從嚴判斷
    expect(d({ settings: 'write' }, {}).allow).toBe(false);
    expect(d({ settings: 'write' }, null).allow).toBe(false);
    expect(d({ settings: 'write', ai: 'write' }, {}).allow).toBe(true);
  });
  it('403 原因使用後台介面上的分頁名稱', () => {
    const reason = (permissions: AdminTabPermissions, method: string, path: string) => {
      const r = decideTenantAdmin({ method, path, body: undefined, tenantId: 'aaa111', permissions });
      return r.allow ? '' : r.reason;
    };
    expect(reason({}, 'GET', '/tenants/aaa111/directory-sync')).toContain('人員同步');
    expect(reason({}, 'GET', '/tenants/aaa111/llm-config')).toContain('AI 模型');
    expect(reason({}, 'GET', '/tenants/aaa111/policy')).toContain('角色與授權');
    expect(reason({}, 'GET', '/tenants/aaa111/users')).toContain('使用者目錄');
    expect(reason({}, 'GET', '/tenants/aaa111/sessions')).toContain('自動登入（SSO）');
    expect(reason({}, 'GET', '/tenants/aaa111/webhooks')).toContain('事件通知（Webhook）');
  });
  it('平台層與兜底一律拒絕', () => {
    for (const [m, p] of [['GET', '/tenants'], ['POST', '/tenants'], ['DELETE', '/tenants/aaa111'],
      ['GET', '/skills'], ['GET', '/mcp-servers'], ['GET', '/db-intelligence/s1/data-sources'],
      ['GET', '/audit'], ['GET', '/tenants/aaa111/admin-accounts'], ['GET', '/tenants/aaa111/brand-new-endpoint']]) {
      expect(t(m, p)).toBe(false);
    }
  });
  it('self 與 tenant 規則', () => {
    expect(t('GET', '/me')).toBe(true);
    expect(t('GET', '/tenants/aaa111')).toBe(true);
    expect(t('GET', '/tenants/bbb222')).toBe(false);
  });
  it('findRouteRule：解出 params、壞的 encoding 不符合', () => {
    expect(findRouteRule('GET', '/tenants/a%20b/knowledge/x')?.params.id).toBe('a b');
    expect(findRouteRule('GET', '/tenants/%E0%A4%A/knowledge')?.rule.access.kind).toBe('super');
  });
});
