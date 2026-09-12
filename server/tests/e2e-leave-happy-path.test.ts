/**
 * E2E happy path（跨 HTTP route stack，零 LLM）：把「登入 → 建對話 → 填欄位 → 送出」
 * 整條線接起來驗一次，補單元測試看不到的「組裝」缺口——auth middleware、resolveTenant、
 * rate-limit/quota、form.engine 驗證、送出硬守門、OA stub 連接器、workflow 簽核關卡。
 *
 * 刻意不經 LLM：以「不帶訊息建對話」＋「PATCH /fields 手動填值」＋「POST /submit 直送」
 * 三個非 LLM 路徑走完流程，因此完全決定性、不需 mock 模型。slot-filling 的 LLM 對話
 * 由 agent-service.test 等單元測試覆蓋，此處專注於 HTTP 端到端的接線是否正確。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';

const app = createApp();
beforeEach(() => tenantStore.updateTenant('default', { grantedScopes: ['service:form', 'form:leave-request'] }));

async function loginToken(): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

/** 請假單除 applicant（建 session 時自動帶入）外的必填欄位，皆為合法值 */
const LEAVE_FIELDS = {
  deputy: '代理人(E999)',
  leaveType: 'annual',
  startDate: '2026-08-01',
  startTime: '09:00',
  endDate: '2026-08-02',
  endTime: '18:00',
  reason: '家中臨時有事',
};

describe('E2E：請假單 happy path（HTTP，零 LLM）', () => {
  it('未帶 token 打對話 API → 401（auth 守門確實掛上）', async () => {
    const res = await request(app).post('/api/conversations').send({});
    expect(res.status).toBe(401);
  });

  it('登入 → 建對話 → 未填先送(422) → 填齊(confirming) → 送出(STUB 單號) → 重送(409)', async () => {
    const token = await loginToken();

    // 1) 不帶訊息建對話：不觸發 LLM，落到預設請假單，狀態 collecting
    const created = await request(app)
      .post('/api/conversations')
      .set('authorization', `Bearer ${token}`)
      .send({});
    expect(created.status).toBe(201);
    expect(created.body.data.formId).toBe('leave-request');
    expect(created.body.data.status).toBe('collecting');
    const id = created.body.data.id as string;
    // applicant 於建立 session 時自動帶入登入者
    expect(created.body.data.values.applicant).toMatch(/\(/);

    // 2) 欄位未齊就送出 → 伺服器端硬守門擋下（422），LLM/前端都繞不過
    const early = await request(app)
      .post(`/api/conversations/${id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .send();
    expect(early.status).toBe(422);
    expect(early.body.error.message).toContain('未完成');

    // 3) PATCH 填齊必填欄位（不經 LLM，走 form.engine coerce + 驗證）→ 轉 confirming
    const patched = await request(app)
      .patch(`/api/conversations/${id}/fields`)
      .set('authorization', `Bearer ${token}`)
      .send({ fields: LEAVE_FIELDS });
    expect(patched.status).toBe(200);
    expect(patched.body.data.rejected).toEqual([]);
    expect(patched.body.data.status).toBe('confirming');

    // 4) 確認送出 → OA stub 回 STUB- 單號、狀態 submitted、帶簽核關卡
    const submitted = await request(app)
      .post(`/api/conversations/${id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .send();
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('submitted');
    expect(submitted.body.data.submission.oaRequestId).toMatch(/^STUB-/);
    expect(submitted.body.data.submission.approvals.length).toBeGreaterThan(0);

    // 5) GET 狀態一致、送出結果可讀回
    const got = await request(app)
      .get(`/api/conversations/${id}`)
      .set('authorization', `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(got.body.data.status).toBe('submitted');
    expect(got.body.data.submission.oaRequestId).toBe(submitted.body.data.submission.oaRequestId);

    // 6) 冪等：已送出的對話重送 → 409，不會重複送單
    const dup = await request(app)
      .post(`/api/conversations/${id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .send();
    expect(dup.status).toBe(409);
  });

  it('非法值被 form.engine 擋下並回 rejected，狀態留 collecting', async () => {
    const token = await loginToken();
    const created = await request(app)
      .post('/api/conversations')
      .set('authorization', `Bearer ${token}`)
      .send({});
    const id = created.body.data.id as string;

    const patched = await request(app)
      .patch(`/api/conversations/${id}/fields`)
      .set('authorization', `Bearer ${token}`)
      .send({ fields: { leaveType: 'not-a-valid-enum', startTime: '25:99' } });
    expect(patched.status).toBe(200);
    expect(patched.body.data.rejected.length).toBeGreaterThan(0);
    expect(patched.body.data.status).toBe('collecting');
  });
});
