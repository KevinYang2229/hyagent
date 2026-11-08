import { describe, expect, it } from 'vitest';
import type { TenantPolicyView } from '../../api';
import { setupChecks, setupProgress, type OverviewData } from './overview.util';

const policy = (over: Partial<TenantPolicyView> = {}): TenantPolicyView => ({
  version: 'v', capabilities: [], grantedScopes: [], groups: {}, accounts: {}, convertedRoleIds: [],
  bundles: [], groupBundles: {}, accountBundles: {}, tenantBundles: [], memberBundles: [], departments: [], users: [], ...over,
});
const fresh = (): OverviewData => ({
  tenant: { id: 't', name: 'T', allowedOrigins: [], activeKeyCount: 0, createdAt: '' },
  users: [], sync: { ssoAutoProvision: false, directorySyncEnabled: false, keys: [] },
  policy: policy({ bundles: [{ id: 'general-services', name: '通用服務', scopes: ['service:form'] }] }),
  knowledge: { status: 'none', chunkCount: 0 } as never,
  acl: { unlabeled: [], explicitlyEmpty: [], source: { configured: false, unlabeled: false, explicitlyEmpty: false }, guest: { department: '—', scopes: [], source: false, files: 0 } },
  forms: [],
});
const byId = (d: OverviewData) => Object.fromEntries(setupChecks(d).map((c) => [c.id, c]));

describe('租戶總覽設定檢查', () => {
  it('新租戶：必要步驟全部待設定，並提醒通用服務未開啟', () => {
    const c = byId(fresh());
    expect(['origins', 'sso-key', 'directory', 'content', 'roles'].map((id) => c[id].status)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(c.general.status).toBe('warn');
    expect(setupProgress(setupChecks(fresh()))).toEqual({ done: 0, total: 5 });
  });

  it('設定完成：必要步驟全部完成；開啟通用服務後不再提醒', () => {
    const d = fresh();
    d.tenant = { ...d.tenant, allowedOrigins: ['https://a.com'], activeKeyCount: 1 };
    d.users = [{ id: 'k', name: 'K', department: '行銷部' }];
    d.forms = [{ formId: 'leave', title: '請假', description: '', source: 'base', editable: false }];
    d.policy = policy({ bundles: [{ id: 'general-services', name: '通用服務', scopes: ['service:form'] }], memberBundles: ['general-services'] });
    const checks = setupChecks(d);
    expect(setupProgress(checks)).toEqual({ done: 5, total: 5 });
    expect(checks.some((c) => c.id === 'general')).toBe(false);
  });

  it('開啟自動建檔時，目錄為空也算有人員來源；未指定部門與未標記檔案列為提醒', () => {
    const d = fresh();
    d.sync = { ssoAutoProvision: true, directorySyncEnabled: false, keys: [] };
    expect(byId(d).directory.status).toBe('ok');
    d.users = [{ id: 'a', name: 'A', department: '—' }];
    d.acl = { ...d.acl!, unlabeled: [{ fileId: 'f', name: 'x.pdf' } as never] };
    const c = byId(d);
    expect(c['no-dept']).toMatchObject({ status: 'warn', required: false });
    expect(c['kb-unlabeled'].detail).toContain('1 份檔案');
  });

  it('資料載入失敗時顯示無法檢查，不誤報為待設定', () => {
    const d = fresh();
    d.policy = undefined;
    d.knowledge = undefined;
    const c = byId(d);
    expect(c.roles.status).toBe('unknown');
    expect(c.content.status).toBe('unknown');
  });
});
