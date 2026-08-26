/** scope-policy 隔離：getPolicy/setPolicy 回/存深複本，外部改動不污染 store。 */
import { scopePolicy } from '@/modules/authz/scope-policy';

describe('scopePolicy 深複本隔離', () => {
  afterEach(() => scopePolicy.clear());

  it('改動 getPolicy 回傳的內層陣列不污染 store', () => {
    scopePolicy.setPolicy('t1', { groups: { 業務部: ['erp:read'] }, accounts: {} });
    const p = scopePolicy.getPolicy('t1');
    p.groups['業務部'].push('erp:write');
    expect(scopePolicy.getPolicy('t1').groups['業務部']).toEqual(['erp:read']);
  });

  it('改動傳入 setPolicy 的內層陣列不污染 store', () => {
    const input = { groups: { 業務部: ['erp:read'] }, accounts: {} };
    scopePolicy.setPolicy('t1', input);
    input.groups['業務部'].push('erp:write');
    expect(scopePolicy.getPolicy('t1').groups['業務部']).toEqual(['erp:read']);
  });
});

/**
 * 刪標籤留下孤兒授權，同名重建即靜默復權——不清 groups/accounts/bundles 裡的舊 scope，
 * 這些授權在 getPolicy 的 prune（其他測試已驗證）之下後台看不見，但資料仍在，
 * 隔天重建同名標籤（hr、finance 這類顯而易見的 id 最容易發生）就會讓舊授權
 * 原封不動靜默復活。revokeScope 是這個縫的補丁：deleteLabel 呼叫它並回報筆數。
 */
describe('scopePolicy.revokeScope', () => {
  afterEach(() => scopePolicy.clear());

  it('從 groups 移除該 scope，其餘 scope 不受影響', () => {
    scopePolicy.setPolicy('t1', {
      groups: { 人資部: ['kb:hr', 'erp:read'], 稽核部: ['kb:hr'] },
      accounts: {},
    });
    const removed = scopePolicy.revokeScope('t1', 'kb:hr');
    expect(removed).toBe(2);
    const p = scopePolicy.getPolicy('t1');
    expect(p.groups['人資部']).toEqual(['erp:read']);
    expect(p.groups['稽核部']).toEqual([]);
  });

  it('從 accounts 移除該 scope', () => {
    scopePolicy.setPolicy('t1', { groups: {}, accounts: { u1: ['kb:hr'], u2: ['erp:read'] } });
    const removed = scopePolicy.revokeScope('t1', 'kb:hr');
    expect(removed).toBe(1);
    expect(scopePolicy.getPolicy('t1').accounts).toEqual({ u1: [], u2: ['erp:read'] });
  });

  it('從套餐（bundle）定義本身移除該 scope，指派到該套餐的部門自動失去它', () => {
    scopePolicy.setPolicy('t1', {
      groups: {},
      accounts: {},
      bundles: [{ id: 'b1', name: 'B1', scopes: ['kb:hr', 'erp:read'] }],
      groupBundles: { 人資部: ['b1'] },
    });
    const removed = scopePolicy.revokeScope('t1', 'kb:hr');
    expect(removed).toBe(1);
    expect(scopePolicy.getPolicy('t1').bundles).toEqual([
      { id: 'b1', name: 'B1', scopes: ['erp:read'] },
    ]);
  });

  it('查無該租戶政策：回 0，不拋錯', () => {
    expect(scopePolicy.revokeScope('no-such-tenant', 'kb:hr')).toBe(0);
  });

  it('沒有任何授權命中該 scope：回 0', () => {
    scopePolicy.setPolicy('t1', { groups: { 人資部: ['erp:read'] }, accounts: {} });
    expect(scopePolicy.revokeScope('t1', 'kb:hr')).toBe(0);
  });

  it('同名重建情境：revokeScope 後舊授權不會在未來的解析中復活', () => {
    scopePolicy.setPolicy('t1', { groups: { 稽核部: ['kb:hr'] }, accounts: {} });
    scopePolicy.revokeScope('t1', 'kb:hr');
    // 模擬「刪除後重建同名標籤」：不重新授權的話，稽核部不該再拿得到 kb:hr
    expect(scopePolicy.groupScopes('t1', '稽核部')).toEqual([]);
  });
});
