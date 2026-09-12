import { scopePolicy } from '@/modules/authz/scope-policy';
import { stubSubmissions } from '@/lib/oa/stub.connector';
import { isSubmitConfirmation } from '@/modules/conversation/conversation.agent';
import { resolveSubmit } from '@/modules/conversation/form-submit.registry';
import { getDefinition } from '@/modules/form/form.registry';
import { buildTools } from '@/modules/form/form.tools';

const TENANT = 'tool-submit-tenant';
beforeEach(() => scopePolicy.setPolicy(TENANT, { groups: {}, accounts: { HYW103: ["service:form", "form:leave-request"] } }));


describe('請假申請 AI tool → server-side submit handler', () => {
  beforeEach(() => {
    stubSubmissions.length = 0;
  });

  it('請假單提供語意明確的 submit_leave_application tool 給 AI 選擇', () => {
    const def = getDefinition(TENANT, 'leave-request');
    const tools = buildTools(def);

    expect(tools.map((tool) => tool.name)).toContain('submit_leave_application');
    expect(tools.map((tool) => tool.name)).not.toContain('submit');
    expect(tools.find((tool) => tool.name === 'submit_leave_application')?.description).toContain(
      'submitLeaveApplication',
    );
  });

  it('只有確認或送出類字樣會通過送出語意 guard', () => {
    expect(isSubmitConfirmation('確認')).toBe(true);
    expect(isSubmitConfirmation('送出')).toBe(true);
    expect(isSubmitConfirmation('確認送出')).toBe(true);
    expect(isSubmitConfirmation('幫我送件')).toBe(true);
    expect(isSubmitConfirmation('我想請特休')).toBe(false);
    expect(isSubmitConfirmation('不要送出，我要修改')).toBe(false);
  });

  it('submit_leave_application 對應的請假 submit handler 會呼叫 stub OA API', async () => {
    const submitLeaveApplication = resolveSubmit('leave-request');

    const result = await submitLeaveApplication(TENANT, 'HYW103', {
      applicant: '張哲瑋(HYW103)',
      deputy: '林佩蓉(HYW018)',
      leaveType: 'annual',
      startDate: '2026-07-01',
      startTime: '09:00',
      endDate: '2026-07-01',
      endTime: '18:00',
      reason: '個人事務',
    });

    expect(result.oaRequestId).toMatch(/^STUB-/);
    expect(result.status).toBe('accepted');
    expect(stubSubmissions).toHaveLength(1);
    expect(stubSubmissions[0]).toMatchObject({
      formId: 'leave-request',
      oaRequestId: result.oaRequestId,
      body: {
        userId: 'HYW103',
        applicant: '張哲瑋(HYW103)',
        deputy: '林佩蓉(HYW018)',
        leaveType: 'annual',
        startDate: '2026-07-01',
        startTime: '09:00',
        endDate: '2026-07-01',
        endTime: '18:00',
        reason: '個人事務',
      },
    });
  });
});
