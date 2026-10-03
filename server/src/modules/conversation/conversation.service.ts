import type { Attachment, PendingActionView } from '@hyagent/shared';
import { refreshApprovals } from '@/modules/form/approvals';
import { computeStatus, setField } from '@/modules/form/form.engine';
import { getDefinition } from '@/modules/form/form.registry';
import type { FieldIssue } from '@/modules/form/form.types';
import { getApplicant } from '@/modules/user/user.directory';
import { normalizeLocale } from '@/lib/locale';
import { usageStore } from '@/modules/usage/usage.store';
import { webhookDispatcher } from '@/modules/webhook/webhook.dispatcher';
import { isWriteTool, makeToolContext, toolRegistry } from '@/modules/tools';
import { AppError } from '@/utils/app-error';
import { attachmentStore } from './attachment.store';
import { runTurn } from './conversation.agent';
import { describeEdits, validateEditedInput } from './edited-input';
import { assertFormAccess } from './form-access';
import { assertMutable, submitSession } from './submit-session';
import { conversationStore } from './conversation.store';
import type { Session, TurnResult } from './conversation.types';
import { pickFormId } from './intent-router';
import { createPendingAction, isPendingActionExpired, toPendingActionView } from './pending-action';
import { cancelPendingAction, runConfirmedAction } from './pending-action.service';

/** 申請人欄位值格式：姓名(工號)，與真實 OA 畫面一致 */
function formatApplicant(userId: string, tenantId: string): string {
  const profile = getApplicant(userId, tenantId);
  return `${profile.name}(${profile.id})`;
}

export interface UpdateFieldsResult extends TurnResult {
  applied: string[];
  rejected: FieldIssue[];
}

export interface ActionTurnResult extends TurnResult {
  /** 確認後的執行結果是否成功（失敗時 reply 帶原因） */
  actionOk: boolean;
}

export const conversationService = {
  async start(
    tenantId: string,
    userId: string,
    message?: string,
    formId?: string,
    lang?: string,
  ): Promise<{ session: Session; turn?: TurnResult }> {
    const selectedForm = formId ?? pickFormId(tenantId, userId, message);
    if (selectedForm) assertFormAccess(tenantId, userId, selectedForm);
    // A tenant with no form grants can still use knowledge/report conversations.
    const def = selectedForm ? getDefinition(tenantId, selectedForm) : undefined;
    const session = conversationStore.create(tenantId, userId, selectedForm);
    // 這裡刻意不設 session.activeServiceId：formId 只是「這個對話若要填表，填哪張」的預選，
    // 不等於 form 已經是流程擁有者。session 一建立 status 就是 'collecting'，若同時把
    // activeServiceId 設成 'form'，intent-router 從第一輪起就判定為填表點黏中，第二輪起
    // 沒踩到知識語氣詞的訊息會被 0-token 鎖回 form——使用者體感是同一句知識問句「第一次答得出來、
    // 第二次就被請假助理婉拒」。點黏改由 runTurn 在 form 真的處理過一輪後才寫入。
    // 回覆語系：由前端 UI 語言決定（未帶時預設繁中）
    session.locale = normalizeLocale(lang);
    usageStore.increment(tenantId, 'conversations');
    // 申請人／外出人＝目前登入者，建立 session 時即帶入（代人申請時使用者可再覆寫）
    if (def && 'applicant' in def.data.properties) {
      session.values.applicant = formatApplicant(userId, tenantId);
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
    if (session.formId) assertFormAccess(tenantId, userId, session.formId);
    assertMutable(session);
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
    await submitSession(session);
    const submission = session.submission!;

    // 在逐字稿留下確認/送出紀錄，維持對話一致
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '確認' }] });
    session.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `已送出，OA 單號：${submission.oaRequestId}。` }],
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
        submission,
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
   * 確認卡片按「確認」（不經 LLM）：比對動作 id 與效期後立即清除（一次性，擋雙擊與並行重送），
   * 再驗證使用者修改後的參數；驗證失敗還原動作並回 422。執行時重新解析權限；權限已撤銷回 403。
   */
  async confirmAction(
    tenantId: string,
    userId: string,
    id: string,
    actionId: string,
    editedInput?: Record<string, unknown>,
  ): Promise<ActionTurnResult> {
    const session = conversationStore.get(id, tenantId, userId);
    const action = session.pendingAction;
    if (!action || action.id !== actionId) {
      throw new AppError(409, 'ACTION_NOT_FOUND', '這個動作已不存在或已處理過');
    }
    // 同步領取：之後任何 await 期間，並行的第二個請求都會看到沒有待確認動作而回 409
    session.pendingAction = undefined;
    if (isPendingActionExpired(action)) {
      conversationStore.save(session);
      throw new AppError(409, 'ACTION_EXPIRED', '這個動作已逾時失效，請重新提出');
    }

    let finalAction = action;
    let edits: string[] = [];
    if (editedInput) {
      const ctx = makeToolContext({ tenantId, userId, locale: session.locale });
      const restore = (): void => {
        if (!session.pendingAction) session.pendingAction = action;
      };
      try {
        await toolRegistry.prepare(ctx);
        let schema: unknown;
        try {
          schema = toolRegistry.resolve(action.toolId, ctx).inputSchema;
        } catch {
          // 工具已不可用：不能拿使用者剛改的值去跑原參數，保留動作並回 503
          restore();
          throw new AppError(503, 'TOOL_UNAVAILABLE', '相關服務暫時無法使用，請稍後再試');
        }
        const structural = validateEditedInput(schema, action.input, editedInput);
        if (!structural.ok) {
          restore();
          throw new AppError(422, 'ACTION_INPUT_INVALID', structural.errors.join('；'));
        }
        try {
          toolRegistry.assertInvocable(action.toolId, editedInput, ctx);
        } catch (err) {
          if (err instanceof AppError && err.statusCode === 422) {
            restore();
            throw new AppError(422, 'ACTION_INPUT_INVALID', err.message, err.details);
          }
          throw err;
        }
        edits = describeEdits(schema, action.input, editedInput);
        finalAction = { ...action, input: editedInput };
      } catch (err) {
        // 非預期錯誤（含 403）也不能讓動作憑空消失
        restore();
        throw err;
      }
    }

    // 先落盤再執行：write-behind 的 save 若遇到當機/滾動重啟，會讓已執行的動作重新變回待確認而被重複確認
    await conversationStore.saveCritical(session);
    const confirmText = edits.length > 0 ? `確認（已修改：${edits.join('；')}）` : '確認';
    session.messages.push({ role: 'user', content: [{ type: 'text', text: confirmText }] });
    const outcome = await runConfirmedAction(session, finalAction);
    conversationStore.save(session);
    if (!outcome.ok && outcome.code === 'FORBIDDEN') throw AppError.forbidden(outcome.reply);
    return {
      reply: outcome.reply,
      status: session.status,
      values: session.values,
      submission: session.submission,
      suggestions: [],
      actionOk: outcome.ok,
    };
  },

  /**
   * 不經 AI 直接提議寫入動作（如 app 的「建立補貨單」按鈕）：與 AI 提議相同的權限與輸入驗證，
   * 只建立待確認動作（取代既有的那筆），仍需使用者確認才會執行。
   */
  async proposeAction(
    tenantId: string,
    userId: string,
    id: string,
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<{ pendingAction: PendingActionView }> {
    const session = conversationStore.get(id, tenantId, userId);
    const ctx = makeToolContext({ tenantId, userId, locale: session.locale });
    await toolRegistry.prepare(ctx);
    let tool;
    try {
      tool = toolRegistry.resolve(toolId, ctx);
    } catch {
      throw new AppError(404, 'TOOL_NOT_FOUND', `找不到工具：${toolId}`);
    }
    // agentExposed 邊界：未開放給 agent 的寫入工具（如 oa.submitForm）不得由此提議，視同不存在
    if (!tool.agentExposed) throw new AppError(404, 'TOOL_NOT_FOUND', `找不到工具：${toolId}`);
    if (!isWriteTool(tool)) throw new AppError(422, 'NOT_A_WRITE_TOOL', '只能提議寫入類動作');
    toolRegistry.assertInvocable(toolId, input, ctx);
    const action = createPendingAction(tool, input);
    session.pendingAction = action;
    conversationStore.save(session);
    return { pendingAction: toPendingActionView(action) };
  },

  /** 確認卡片按「取消」：清除待確認動作，不執行。 */
  cancelAction(tenantId: string, userId: string, id: string, actionId: string): TurnResult {
    const session = conversationStore.get(id, tenantId, userId);
    if (!session.pendingAction || session.pendingAction.id !== actionId) {
      throw new AppError(409, 'ACTION_NOT_FOUND', '這個動作已不存在或已處理過');
    }
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '取消' }] });
    const reply = cancelPendingAction(session);
    conversationStore.save(session);
    return { reply, status: session.status, values: session.values, submission: session.submission, suggestions: [] };
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
    assertFormAccess(tenantId, userId, session.formId);
    assertMutable(session);

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
    assertFormAccess(tenantId, userId, session.formId);
    assertMutable(session);
    return attachmentStore.save(session.id, file);
  },

  /** 刪除一個附件（檔案內容）；對話歸屬驗證後才動作 */
  removeAttachment(tenantId: string, userId: string, id: string, attachmentId: string): void {
    const session = conversationStore.get(id, tenantId, userId);
    assertFormAccess(tenantId, userId, session.formId);
    assertMutable(session);
    const ok = attachmentStore.remove(session.id, attachmentId);
    if (!ok) throw AppError.notFound('Attachment not found');
  },

  get(tenantId: string, userId: string, id: string): Session {
    const session = conversationStore.get(id, tenantId, userId);
    if (session.formId) assertFormAccess(tenantId, userId, session.formId);
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
    if (session.formId) assertFormAccess(tenantId, userId, session.formId);
    assertMutable(session);
    if (session.status !== 'submitted') {
      session.status = 'cancelled';
      // 已取消的對話不會送出，清掉暫存附件內容避免記憶體累積
      attachmentStore.clearSession(session.id);
    }
    conversationStore.save(session);
    return session;
  },
};
