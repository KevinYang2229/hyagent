import type { Attachment } from '@oa-agent/shared';
import { refreshApprovals } from '@/modules/form/approvals';
import { computeStatus, setField, validateAll } from '@/modules/form/form.engine';
import { getDefinition } from '@/modules/form/form.registry';
import type { FieldIssue } from '@/modules/form/form.types';
import { getApplicant } from '@/modules/user/user.directory';
import { normalizeLocale } from '@/lib/locale';
import { usageStore } from '@/modules/usage/usage.store';
import { webhookDispatcher } from '@/modules/webhook/webhook.dispatcher';
import { AppError } from '@/utils/app-error';
import { attachmentStore } from './attachment.store';
import { runTurn } from './conversation.agent';
import { resolveSubmit } from './form-submit.registry';
import { conversationStore } from './conversation.store';
import type { Session, TurnResult } from './conversation.types';
import { listEnabledForms } from './form.agent-service';
import { pickFormId } from './intent-router';

/** 申請人欄位值格式：姓名(工號)，與真實 OA 畫面一致 */
function formatApplicant(userId: string): string {
  const profile = getApplicant(userId);
  return `${profile.name}(${profile.id})`;
}

export interface UpdateFieldsResult extends TurnResult {
  applied: string[];
  rejected: FieldIssue[];
}

export const conversationService = {
  async start(
    tenantId: string,
    userId: string,
    message?: string,
    formId?: string,
    lang?: string,
  ): Promise<{ session: Session; turn?: TurnResult }> {
    // 表單選擇：明確指定優先，否則依首句意圖路由（皆驗證表單存在）。
    // 明確指定 formId 時另需驗證使用者持有該表單 scope（form:<id>）——
    // 無指定則走 pickFormId，其已僅回傳 listEnabledForms 授予的表單，無需重複檢查。
    if (formId && !listEnabledForms(tenantId, userId).some((d) => d.formId === formId)) {
      throw AppError.forbidden('無權使用此表單');
    }
    const def = getDefinition(tenantId, formId ?? pickFormId(tenantId, userId, message));
    const session = conversationStore.create(tenantId, userId, def.formId);
    // 開場即以 form 為點黏擁有者；後續每輪由 intent-router 決定是否讓知識問答旁路插入
    session.activeServiceId = 'form';
    // 回覆語系：由前端 UI 語言決定（未帶時預設繁中）
    session.locale = normalizeLocale(lang);
    usageStore.increment(tenantId, 'conversations');
    // 申請人／外出人＝目前登入者，建立 session 時即帶入（代人申請時使用者可再覆寫）
    if ('applicant' in def.data.properties) {
      session.values.applicant = formatApplicant(userId);
    }
    conversationStore.save(session);
    if (message && message.trim()) {
      usageStore.increment(tenantId, 'messages');
      const turn = await runTurn(session, message);
      return { session, turn };
    }
    return { session };
  },

  async sendMessage(
    tenantId: string,
    userId: string,
    id: string,
    message: string,
    lang?: string,
  ): Promise<TurnResult> {
    const session = conversationStore.get(id, tenantId, userId);
    if (session.status === 'submitted') throw AppError.conflict('Conversation already submitted');
    if (session.status === 'cancelled') throw AppError.conflict('Conversation cancelled');
    // 允許對話中途切換語言：每則訊息帶來的語系覆寫 session
    if (lang) session.locale = normalizeLocale(lang);
    usageStore.increment(tenantId, 'messages');
    return runTurn(session, message);
  },

  /**
   * 確認送出（不經 LLM）：確認畫面按「送出」時呼叫。直接驗證 session.values 並送出，
   * 不依賴模型是否於對話中呼叫 submit 工具——避免「第一次按送出沒送出、要按第二次」。
   */
  async submit(tenantId: string, userId: string, id: string): Promise<TurnResult> {
    const session = conversationStore.get(id, tenantId, userId);
    if (session.status === 'submitted') throw AppError.conflict('Conversation already submitted');
    if (session.status === 'cancelled') throw AppError.conflict('Conversation cancelled');

    const def = getDefinition(tenantId, session.formId);
    const issues = validateAll(def, session.values);
    if (issues.length > 0) {
      throw AppError.unprocessable('表單尚有欄位未完成，無法送出', issues);
    }

    session.status = 'submitting';
    try {
      // 依表單類型查表選送出 service（外出登記 / 出差報銷 / 請假…），與 agent 工具一致
      const submitForm = resolveSubmit(session.formId);
      const result = await submitForm(tenantId, userId, session.values);
      session.status = 'submitted';
      session.submission = {
        oaRequestId: result.oaRequestId,
        status: result.status,
        submittedAt: result.submittedAt,
        approvals: result.approvals,
      };
      // 已送出：附件 metadata 已隨 payload 交付，清掉本地暫存的檔案內容
      attachmentStore.clearSession(session.id);
    } catch (err) {
      session.status = 'failed';
      conversationStore.save(session);
      throw err;
    }

    // 在逐字稿留下確認/送出紀錄，維持對話一致
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '確認' }] });
    session.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `已送出，OA 單號：${session.submission.oaRequestId}。` }],
    });
    conversationStore.save(session);
    usageStore.increment(tenantId, 'submissions');

    // 表單送出成功 → 回拋 webhook 給租戶登記的端點（行內非同步，不阻塞此回應）
    webhookDispatcher.dispatch({
      type: 'form.submitted',
      tenantId,
      data: {
        conversationId: session.id,
        formId: session.formId,
        userId,
        values: session.values,
        submission: session.submission,
      },
    });

    return {
      reply: '',
      status: session.status,
      values: session.values,
      submission: session.submission,
      suggestions: [],
    };
  },

  /**
   * 確認畫面手動編輯欄位（不經 LLM）：每欄走 form.engine 的 coerce + 驗證，
   * 重算 slot 狀態並同步 collecting/confirming，確保送出時 session.values 與畫面一致。
   */
  updateFields(
    tenantId: string,
    userId: string,
    id: string,
    fields: Record<string, unknown>,
  ): UpdateFieldsResult {
    const session = conversationStore.get(id, tenantId, userId);
    if (session.status === 'submitted') throw AppError.conflict('Conversation already submitted');
    if (session.status === 'cancelled') throw AppError.conflict('Conversation cancelled');

    const def = getDefinition(tenantId, session.formId);
    const applied: string[] = [];
    const rejected: FieldIssue[] = [];

    for (const [field, value] of Object.entries(fields)) {
      if (!(field in def.data.properties)) {
        rejected.push({ field, message: `未知欄位：${field}` });
        continue;
      }
      // 空值＝清除該欄（選填欄位允許；必填清空則於 status 反映為 missing）
      if (value === null || value === undefined || value === '') {
        const { [field]: _omit, ...rest } = session.values;
        session.values = rest;
        applied.push(field);
        continue;
      }
      const res = setField(def, session.values, field, value);
      if (res.issue) rejected.push(res.issue);
      else {
        session.values = res.values;
        applied.push(field);
      }
    }

    const status = computeStatus(def, session.values);
    if (status.isComplete && session.status === 'collecting') session.status = 'confirming';
    if (!status.isComplete && session.status === 'confirming') session.status = 'collecting';

    // 在 LLM 逐字稿留下手動修改紀錄，下一輪「確認」時模型可據此對齊摘要
    if (applied.length > 0) {
      session.messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `（使用者於確認畫面手動更新欄位：${JSON.stringify(session.values)}）`,
          },
        ],
      });
    }

    conversationStore.save(session);
    return {
      reply: '',
      status: session.status,
      values: session.values,
      submission: session.submission,
      suggestions: [],
      applied,
      rejected,
    };
  },

  /**
   * 上傳一個附件：驗證對話歸屬與狀態 → 存入附件儲存區 → 回 metadata。
   * 不直接寫入 session.values；附件清單由確認畫面經 updateFields 持久化（單一寫入路徑）。
   */
  addAttachment(
    tenantId: string,
    userId: string,
    id: string,
    file: { name: string; mime: string; buffer: Buffer },
  ): Attachment {
    const session = conversationStore.get(id, tenantId, userId);
    if (session.status === 'submitted') throw AppError.conflict('Conversation already submitted');
    if (session.status === 'cancelled') throw AppError.conflict('Conversation cancelled');
    return attachmentStore.save(session.id, file);
  },

  /** 刪除一個附件（檔案內容）；對話歸屬驗證後才動作 */
  removeAttachment(tenantId: string, userId: string, id: string, attachmentId: string): void {
    const session = conversationStore.get(id, tenantId, userId);
    const ok = attachmentStore.remove(session.id, attachmentId);
    if (!ok) throw AppError.notFound('Attachment not found');
  },

  get(tenantId: string, userId: string, id: string): Session {
    const session = conversationStore.get(id, tenantId, userId);
    // 查詢時即時反映目前簽核進度（依送出時間重算關卡狀態）
    if (session.submission?.approvals?.length) {
      session.submission = {
        ...session.submission,
        approvals: refreshApprovals(
          session.submission.approvals,
          session.submission.submittedAt,
        ),
      };
    }
    return session;
  },

  cancel(tenantId: string, userId: string, id: string): Session {
    const session = conversationStore.get(id, tenantId, userId);
    if (session.status !== 'submitted') {
      session.status = 'cancelled';
      // 已取消的對話不會送出，清掉暫存附件內容避免記憶體累積
      attachmentStore.clearSession(session.id);
    }
    conversationStore.save(session);
    return session;
  },
};
