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

  it('租戶管理者看不到基本設定時後端不帶 allowedOrigins：檢查不會因此丟錯', () => {
    const d = fresh();
    d.tenant = { id: 't', name: 'T', activeKeyCount: 0, createdAt: '' };
    expect(() => setupChecks(d)).not.toThrow();
    expect(byId(d).origins.status).toBe('todo');
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

  it('有角色開給所有人（含網站訪客）時提醒，並列出訪客可用的能力', () => {
    const d = fresh();
    d.policy = policy({
      capabilities: [{ id: 'service:agent', label: '智慧代理', description: '', base: false }],
      bundles: [{ id: 'all', name: '全體人員', scopes: ['service:agent'] }], tenantBundles: ['all'],
    });
    expect(byId(d)['guest-open']).toMatchObject({ status: 'warn', required: false });
    expect(byId(d)['guest-open'].detail).toContain('智慧代理');
    expect(byId(fresh())['guest-open']).toBeUndefined();
  });

  it('直接給「網站訪客」的角色也算訪客可用的能力；知識庫標籤不列入', () => {
    const d = fresh();
    d.policy = policy({
      capabilities: [{ id: 'email:write', label: '寄送 Email', description: '', base: false }],
      bundles: [{ id: 'emp', name: '一般員工', scopes: ['email:write', 'kb:public'] }],
      groupBundles: { '—': ['emp'] },
    });
    expect(byId(d)['guest-open'].detail).toContain('寄送 Email');
    expect(byId(d)['guest-open'].detail).not.toContain('kb:public');
    // 只有知識庫標籤給訪客：不算開放能力
    d.policy = policy({ bundles: [{ id: 'pub', name: '公開', scopes: ['kb:public'] }], groupBundles: { '—': ['pub'] } });
    expect(byId(d)['guest-open']).toBeUndefined();
  });
});
