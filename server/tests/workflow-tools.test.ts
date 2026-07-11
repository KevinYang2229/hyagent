/** 查簽核工具：身分綁 ctx（只能查自己的）、進度查詢時重算、agentExposed。 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { submissionStore } from '@/modules/workflow/submission.store';

function seed(tenantId: string, userId: string, oaRequestId: string) {
  submissionStore.record(tenantId, {
    oaRequestId, formId: 'leave-request', formTitle: '請假申請',
    userId, submittedAt: new Date().toISOString(),
  });
}

describe('查簽核工具', () => {
  afterEach(() => submissionStore.clear());

  it('兩工具已註冊且 agentExposed（oa:read 為 BASE，全員可見）', () => {
    const t = tenantStore.createTenant('wf-avail');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const names = toolRegistry.availableFor(ctx).map((x) => x.name);
    expect(names).toContain('oa.listMyRequests');
    expect(names).toContain('oa.getApprovalStatus');
  });

  it('listMyRequests 只回呼叫者本人的申請，含目前關卡摘要', async () => {
    const t = tenantStore.createTenant('wf-list');
    seed(t.id, 'kevin', 'R-K1');
    seed(t.id, 'hyweb', 'R-H1');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const out = (await toolRegistry.invoke('oa.listMyRequests', {}, ctx)) as {
      requests: { oaRequestId: string; current: string }[];
    };
    expect(out.requests.map((r) => r.oaRequestId)).toEqual(['R-K1']); // 不含他人的 R-H1
    expect(out.requests[0].current).toBeTruthy();
  });

  it('getApprovalStatus：本人可查（回關卡列表）', async () => {
    const t = tenantStore.createTenant('wf-status');
    seed(t.id, 'kevin', 'R-K2');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const out = (await toolRegistry.invoke('oa.getApprovalStatus', { oaRequestId: 'R-K2' }, ctx)) as {
      found: boolean; approvals: { name: string; status: string }[];
    };
    expect(out.found).toBe(true);
    expect(out.approvals.length).toBeGreaterThan(0);
    expect(['current', 'pending', 'approved']).toContain(out.approvals[0].status);
  });

  it('getApprovalStatus：他人的單號回查無（不洩漏）', async () => {
    const t = tenantStore.createTenant('wf-cross');
    seed(t.id, 'hyweb', 'R-H2');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const out = (await toolRegistry.invoke('oa.getApprovalStatus', { oaRequestId: 'R-H2' }, ctx)) as {
      found: boolean;
    };
    expect(out.found).toBe(false);
  });
});
