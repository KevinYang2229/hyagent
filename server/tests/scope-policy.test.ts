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
