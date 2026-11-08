import { describe, expect, it } from 'vitest';
import type { ScopeDef, TenantPolicyView } from '../../api';
import {
  applyRoleDraft, capabilityGaps, effectiveCapabilities, everyoneBlockedScopes, peopleOf, removeRole, roleDraftOf, rolesOf,
  toggleCapability,
} from './permissions.util';

const caps: ScopeDef[] = [
  { id: 'service:form', label: '填表申請', description: '', base: false },
  { id: 'service:knowledge', label: '知識庫問答', description: '', base: false },
  { id: 'service:report', label: '報告', description: '', base: false },
  { id: 'form:leave', label: '請假單', description: '', base: false },
  { id: 'kb:hr', label: '人資文件', description: '', base: false },
  { id: 'mcp:db', label: '智慧資料庫', description: '', base: false },
  { id: 'mcp:db:manager', label: '智慧資料庫：manager', description: '', base: false },
];

describe('相依規則', () => {
  it('勾表單自動開啟填表申請，並說明原因', () => {
    const r = toggleCapability([], 'form:leave', caps);
    expect(r.scopes).toEqual(['form:leave', 'service:form']);
    expect(r.notice).toContain('填表申請');
  });
  it('勾知識庫標籤自動開啟知識庫問答；已有報告時不重複開', () => {
    expect(toggleCapability([], 'kb:hr', caps).scopes).toEqual(['kb:hr', 'service:knowledge']);
    expect(toggleCapability(['service:report'], 'kb:hr', caps)).toEqual({ scopes: ['service:report', 'kb:hr'] });
  });
  it('勾服務內角色自動開啟該服務', () => {
    expect(toggleCapability([], 'mcp:db:manager', caps).scopes).toEqual(['mcp:db:manager', 'mcp:db']);
  });
  it('取消前置服務會一併取消依賴項目，並列出被取消的項目', () => {
    const form = toggleCapability(['service:form', 'form:leave'], 'service:form', caps);
    expect(form.scopes).toEqual([]);
    expect(form.notice).toContain('請假單');
    expect(toggleCapability(['mcp:db', 'mcp:db:manager'], 'mcp:db', caps).scopes).toEqual([]);
    // 還有報告時，取消知識庫問答不影響標籤
    expect(toggleCapability(['service:knowledge', 'service:report', 'kb:hr'], 'service:knowledge', caps).scopes)
      .toEqual(['service:report', 'kb:hr']);
    expect(toggleCapability(['service:knowledge', 'kb:hr'], 'service:knowledge', caps).scopes).toEqual([]);
  });
});

describe('缺漏檢查', () => {
  it('開了服務沒有內容、或有內容沒有服務都會提醒', () => {
    expect(capabilityGaps(['service:form'], caps)[0]).toContain('沒有選任何表單');
    expect(capabilityGaps(['service:knowledge'], caps)[0]).toContain('沒有任何知識庫標籤');
    expect(capabilityGaps(['kb:hr'], caps)[0]).toContain('標籤用不到');
    expect(capabilityGaps(['form:leave'], caps)[0]).toContain('表單無法使用');
    expect(capabilityGaps(['service:form', 'form:leave', 'service:knowledge', 'kb:hr'], caps)).toEqual([]);
  });
  it('套用給所有人時擋下知識庫標籤與外部服務', () => {
    expect(everyoneBlockedScopes(['service:form', 'kb:hr', 'mcp:db'])).toEqual(['kb:hr', 'mcp:db']);
  });
});

function policy(): TenantPolicyView {
  return {
    version: "v1", memberBundles: [], grantedScopes: [], groups: {}, accounts: {}, capabilities: caps, convertedRoleIds: [],
    departments: ['—', '行銷部'],
    users: [{ id: 'kevin', label: 'Kevin', department: '行銷部' }],
    bundles: [
      { id: 'all', name: '全體人員', scopes: ['service:knowledge'] },
      { id: 'emp', name: '一般員工', scopes: ['service:form', 'form:leave'] },
      { id: 'rep', name: '報告分析員', scopes: ['service:report', 'kb:hr'] },
    ],
    tenantBundles: ['all'],
    groupBundles: { 行銷部: ['emp'] },
    accountBundles: { kevin: ['rep'], 'sso-amy': ['emp'] },
  };
}

describe('角色編輯與個人權限', () => {
  it('讀出與寫回角色時，三種套用對象一起更新', () => {
    const p = policy();
    const draft = roleDraftOf(p, p.bundles[1]);
    expect(draft).toMatchObject({ everyone: false, departments: ['行銷部'], accounts: ['sso-amy'] });
    const next = applyRoleDraft(p, { ...draft, departments: [], accounts: ['kevin'], everyone: true });
    expect(next.tenantBundles).toEqual(['all', 'emp']);
    expect(next.groupBundles['行銷部']).toEqual([]);
    expect(next.accountBundles.kevin).toEqual(['rep', 'emp']);
    expect(next.accountBundles['sso-amy']).toEqual([]);
  });
  it('刪除角色時移除所有套用', () => {
    const next = removeRole(policy(), 'emp');
    expect(next.bundles.map((b) => b.id)).toEqual(['all', 'rep']);
    expect(next.groupBundles['行銷部']).toEqual([]);
  });
  it('個人權限列出每項能力來自哪些角色與途徑', () => {
    const p = policy();
    const kevin = peopleOf(p).find((x) => x.id === 'kevin')!;
    expect(rolesOf(p, kevin).map((r) => [r.role.id, r.sources.map((s) => s.via)])).toEqual([
      ['all', ['everyone']], ['emp', ['department']], ['rep', ['direct']],
    ]);
    const caps = effectiveCapabilities(p, kevin);
    expect(caps.find((c) => c.scope === 'form:leave')?.roles).toEqual(['一般員工']);
    // 目錄外但有直接指派的帳號與訪客也能檢視
    expect(peopleOf(p).map((x) => x.label)).toEqual(['Kevin', 'sso-amy', '網站訪客']);
    const guest = peopleOf(p).find((x) => x.kind === 'guest')!;
    expect(effectiveCapabilities(p, guest).map((c) => c.scope)).toEqual(['service:knowledge']);
  });
  it('套用給所有人的角色裡的知識庫標籤不計入（後端不會生效）', () => {
    const p = { ...policy(), bundles: [{ id: 'all', name: '全體人員', scopes: ['service:knowledge', 'kb:hr'] }], groupBundles: {}, accountBundles: {} };
    const guest = peopleOf(p).find((x) => x.kind === 'guest')!;
    expect(effectiveCapabilities(p, guest).map((c) => c.scope)).toEqual(['service:knowledge']);
  });
});
