/** submissions store：record/listByUser（新→舊、只回本人）/find/上限捨舊/租戶隔離；送出漏斗會記錄且失敗不影響送出。 */
import { submissionStore, type SubmissionRecord } from '@/modules/workflow/submission.store';
import { resolveSubmit } from '@/modules/conversation/form-submit.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

function rec(partial: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    oaRequestId: `R-${Math.random().toString(36).slice(2, 8)}`,
    formId: 'leave-request', formTitle: '請假申請', userId: 'kevin',
    submittedAt: new Date().toISOString(), ...partial,
  };
}

// outing-registration 走各自 domain service（outingService.submit），必填欄位見
// schemas/outing-registration/validation.schema.json，並有 returnDate >= departDate 商規。
// 與 form-submit-notify.test.ts 的 validOutingValues 相同（已驗證能通過驗證）。
function validOutingValues(): Record<string, unknown> {
  return {
    applicant: 'Kevin Yang(HYW001)',
    subject: '拜訪客戶',
    fromLocation: '台北辦公室',
    toLocation: '客戶現場',
    departDate: '2026-07-10',
    departTime: '09:00',
    returnDate: '2026-07-10',
    returnTime: '18:00',
    needReimbursement: 'no',
  };
}

describe('submissionStore', () => {
  afterEach(() => submissionStore.clear());

  it('listByUser 新→舊、只回本人；find 可查', () => {
    const a = rec({ userId: 'kevin' });
    const b = rec({ userId: 'kevin' });
    const c = rec({ userId: 'hyweb' });
    submissionStore.record('t1', a);
    submissionStore.record('t1', b);
    submissionStore.record('t1', c);
    const list = submissionStore.listByUser('t1', 'kevin');
    expect(list.map((r) => r.oaRequestId)).toEqual([b.oaRequestId, a.oaRequestId]);
    expect(submissionStore.find('t1', c.oaRequestId)?.userId).toBe('hyweb');
    expect(submissionStore.listByUser('t2', 'kevin')).toHaveLength(0); // 租戶隔離
  });

  it('每租戶上限 200 捨最舊', () => {
    for (let i = 0; i < 210; i++) submissionStore.record('t3', rec({ oaRequestId: `R-${i}` }));
    expect(submissionStore.find('t3', 'R-0')).toBeUndefined();
    expect(submissionStore.find('t3', 'R-209')).toBeTruthy();
  });
});

describe('送出漏斗記錄', () => {
  afterEach(() => submissionStore.clear());

  it('通用送出成功後留下紀錄（含 formTitle）', async () => {
    const t = tenantStore.createTenant('sub-record');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'form:outing-registration'] });
    const submit = resolveSubmit('outing-registration');
    const values = validOutingValues();
    const result = await submit(t.id, 'kevin', values);
    const found = submissionStore.find(t.id, result.oaRequestId);
    expect(found).toBeTruthy();
    expect(found?.userId).toBe('kevin');
    expect(found?.formTitle).toBeTruthy();
  });

  it('store 記錄拋錯不影響送出（best-effort）', async () => {
    const t = tenantStore.createTenant('sub-record-fail');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'form:outing-registration'] });
    const spy = jest.spyOn(submissionStore, 'record').mockImplementation(() => { throw new Error('磁碟爆了'); });
    try {
      const submit = resolveSubmit('outing-registration');
      const values = validOutingValues();
      const result = await submit(t.id, 'kevin', values);
      expect(result.oaRequestId).toBeTruthy(); // 送出照常成功
    } finally {
      spy.mockRestore();
    }
  });
});
