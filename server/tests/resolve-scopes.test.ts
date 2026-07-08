/**
 * resolveScopes（RBAC seam）：Phase 0 全通過。
 * 之後（Phase 2）改為租戶∩群組∩帳號 union；此測試屆時會更新。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { makeToolContext } from '@/modules/tools/tool.context';

describe('resolveScopes（Phase 0 全通過）', () => {
  it('任何 principal 都回萬用字元 ["*"]', () => {
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' })).toEqual(['*']);
  });
});

describe('makeToolContext', () => {
  it('把 principal 加上解析後的 scopes 組成 ToolContext', () => {
    const ctx = makeToolContext({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW' });
    expect(ctx).toEqual({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW', scopes: ['*'] });
  });
});
