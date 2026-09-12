import { scopePolicy } from '@/modules/authz/scope-policy';
/**
 * Phase 5 端到端（service 層）：Designer 自建表單 → 通用送出可完成。
 * 驗證 resolveSubmit 對「無專屬 service 的表單」走 schema 驅動通用送出：
 *  - 有 oa.schema → 經 stub 連接器送出，回 STUB- 單號
 *  - 無 oa.schema → 合成 LOCAL- 本地單號
 *  - workflow.steps → 產生對應簽核關卡
 *  - 驗證未過 → 擲錯
 */
import { resolveSubmit } from '@/modules/conversation/form-submit.registry';
import { formStore } from '@/modules/form/form.store';
import type { Definition } from '@/modules/form/form.types';

const TENANT = 'phase5-tenant';
beforeEach(() => scopePolicy.setPolicy(TENANT, { groups: {}, accounts: { HYW103: ["service:form", "form:designed-oa", "form:designed-local"] } }));


function designedForm(formId: string, withOA: boolean): Definition {
  return {
    formId,
    data: {
      type: 'object',
      title: '設計表單',
      properties: {
        applicant: { type: 'string', description: '申請人' },
        amount: { type: 'number', description: '金額' },
      },
      additionalProperties: false,
    },
    field: {
      applicant: { component: 'Input', label: '申請人' },
      amount: { component: 'Number', label: '金額' },
    },
    layout: { sections: [{ title: '內容', fields: [['applicant'], ['amount']] }] },
    validation: { required: ['applicant', 'amount'] },
    agent: { intent: formId, description: '設計表單' },
    workflow: { steps: [{ type: 'manager', name: '主管審核' }, { type: 'finance', name: '財務審核' }] },
    ...(withOA
      ? {
          oa: {
            endpoint: '/api/designed',
            request: { fieldMap: { applicant: 'applicant', amount: 'amount', userId: 'userId' } },
            response: { idField: 'requestId', statusField: 'status' },
          },
        }
      : {}),
  } as Definition;
}

afterAll(() => {
  formStore.deleteDefinition(TENANT, 'designed-oa');
  formStore.deleteDefinition(TENANT, 'designed-local');
});

describe('Designer 自建表單的通用送出', () => {
  it('有 oa.schema → 經連接器送出，回 STUB 單號 + 依 workflow 算簽核', async () => {
    formStore.saveDefinition(TENANT, designedForm('designed-oa', true));
    const submit = resolveSubmit('designed-oa');
    const result = await submit(TENANT, 'HYW103', { applicant: '張哲瑋(HYW103)', amount: 1200 });
    expect(result.oaRequestId).toMatch(/^STUB-/);
    expect(result.status).toBe('accepted');
    expect(result.approvals).toHaveLength(2);
    expect(result.approvals[0].type).toBe('manager');
  });

  it('無 oa.schema → 回 LOCAL 本地單號，流程仍可完成', async () => {
    formStore.saveDefinition(TENANT, designedForm('designed-local', false));
    const submit = resolveSubmit('designed-local');
    const result = await submit(TENANT, 'HYW103', { applicant: '張哲瑋(HYW103)', amount: 50 });
    expect(result.oaRequestId).toMatch(/^LOCAL-/);
    expect(result.approvals).toHaveLength(2);
  });

  it('必填未填 → 擲錯（不送出）', async () => {
    const submit = resolveSubmit('designed-oa');
    await expect(submit(TENANT, 'HYW103', { applicant: '張哲瑋(HYW103)' })).rejects.toThrow();
  });
});
