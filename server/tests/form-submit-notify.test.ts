/** 送出後通知信：租戶授予 email:write → 送出成功且寄出；未授予 → 送出仍成功、不寄。 */
import { resolveSubmit } from '@/modules/conversation/form-submit.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

// outing-registration 走各自 domain service（outingService.submit），必填欄位見
// schemas/outing-registration/validation.schema.json，並有 returnDate >= departDate 商規。
function validOutingValues() {
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
  } as Record<string, unknown>;
}

describe('送出後通知信（best-effort）', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('租戶授予 email:write → 送出成功且寄出通知', async () => {
    const t = tenantStore.createTenant('notify-yes');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const submit = resolveSubmit('outing-registration');
    const result = await submit(t.id, 'kevin', validOutingValues());
    expect(result.oaRequestId).toBeTruthy();
    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('kevin@example.com'); // 依 mock email
  });

  it('未授予 email:write → 送出仍成功、不寄信', async () => {
    const t = tenantStore.createTenant('notify-no');
    const submit = resolveSubmit('outing-registration');
    const result = await submit(t.id, 'kevin', validOutingValues());
    expect(result.oaRequestId).toBeTruthy();
    expect(stubSentEmails).toHaveLength(0);
  });
});
