/**
 * Form Agent 服務：把既有的填表 slot-filling 邏輯包成 AgentService 契約。
 *
 * system prompt / tools / tool 分派 / 送出守門皆自本檔（原 conversation.agent.ts 遷入），
 * 行為與重構前一致。form.engine / form-submit.registry / 各 domain service 不動。
 * sticky=true：填表流程一旦開始即點黏，知識問答只能旁路插入、不奪走流程。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { languageDirective } from '@/lib/locale';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { formScopeId } from '@/modules/authz/scope-catalog';
import { computeStatus, setField, validateAll } from '@/modules/form/form.engine';
import { getDefinition, listDefinitions } from '@/modules/form/form.registry';
import { buildTools } from '@/modules/form/form.tools';
import type { Definition, FieldIssue } from '@/modules/form/form.types';
import { leaveService } from '@/modules/leave/leave.service';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { listDeputyCandidates } from '@/modules/user/user.directory';
import { attachmentStore } from './attachment.store';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { resolveSubmit } from './form-submit.registry';
import { runToolLoop } from './tool-loop';

const SUBMIT_CONFIRMATION_RE = /(確認|確定|送出|提交|送件|可以送|幫我送|同意送出)/;
const SUBMIT_NEGATION_RE = /(不要|先不要|別|取消|不送|不要送出|不要提交|暫停|修改)/;

export function isSubmitConfirmation(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (SUBMIT_NEGATION_RE.test(normalized)) return false;
  return SUBMIT_CONFIRMATION_RE.test(normalized);
}

/** 該租戶表單中，principal 具 form:<formId> scope 者（opt-in：未授予則不可見）。 */
export function listEnabledForms(tenantId: string, userId: string): Definition[] {
  const scopes = new Set(resolveScopes({ tenantId, userId }));
  return listDefinitions(tenantId).filter((d) => scopes.has(formScopeId(d.formId)));
}

function describeFields(def: Definition): string {
  const order = def.agent.askOrder ?? Object.keys(def.data.properties);
  return order
    .map((name) => {
      const f = def.field[name];
      const required = def.validation.required.includes(name) ? '必填' : '選填';
      const opts = f?.options
        ? `；可選值：${f.options.map((o) => `${o.label}=${o.value}`).join('、')}`
        : '';
      const guide = def.agent.fieldGuidance?.[name] ? `；${def.agent.fieldGuidance[name]}` : '';
      return `- ${name}（${f?.label ?? name}，${required}）${opts}${guide}`;
    })
    .join('\n');
}

function buildSystemPrompt(
  tenantId: string,
  userId: string,
  def: Definition,
  locale?: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const hasLeaveType = 'leaveType' in def.data.properties;
  const hasDeputy = 'deputy' in def.data.properties;
  const hasHours = !!def.policy;
  const submitToolName =
    def.formId === 'leave-request' ? 'submit_leave_application' : 'submit';

  // 工作方式步驟依表單能力動態組裝：只在對應工具存在時才指示模型呼叫，避免要求外出登記等
  // 表單呼叫不存在的工具（compute_leave_hours / get_leave_balances / find_deputy_candidates）。
  const steps: string[] = [
    '1. 從使用者訊息擷取可得欄位值，呼叫 fill_fields 一次填入。',
    '2. 依工具回傳的 missing/invalid，用友善的語氣逐一詢問還缺的必填欄位。',
  ];
  if (hasHours) {
    steps.push(
      '3. 必填齊全後，先呼叫 compute_leave_hours 取得本次請假時數，再摘要整張表單',
      '   （列出假別、日期時間、事由，並附上「本次請假時數：N 小時」），請使用者回覆「確認」或「送出」。',
    );
  } else {
    steps.push(
      '3. 必填齊全後，摘要整張表單（逐項列出已填欄位，可參考確認語句範本），請使用者回覆「確認」或「送出」。',
    );
  }
  steps.push(
    `4. 只有使用者明確回覆「確認」「送出」「確認送出」等正向送出語意後才呼叫 ${submitToolName}；切勿自行送出，也不要捏造任何值。`,
  );
  if (hasLeaveType) {
    steps.push(
      '5. 使用者詢問假別剩餘／可用時數（例如「特休還有幾小時」「所有假別剩多少」）時，',
      '   呼叫 get_leave_balances 取得真實數字後再回答；以假別名稱呈現；',
      '   查無資料的假別請如實說明（例如「系統查無此假別額度」），切勿捏造時數。',
    );
  }
  if (hasDeputy) {
    steps.push(
      '6. 挑選職務代理人時，呼叫 find_deputy_candidates 取得候選清單（可帶 department 依部門篩選）。',
      '   你只能推薦或填入清單（即使用者「我的最愛」）中的人員，切勿捏造或推薦清單外的人；',
      '   候選人以「姓名(工號)」格式呈現。若使用者堅持指定清單外的人，可如實照填但不要主動推薦。',
    );
  }

  // 全系統可申請的表單清單：讓助理在被問到「有哪些表單可以申請」時能完整回答，
  // 而非只知道自己這場對話的表單。
  const currentTitle = def.data.title ?? def.agent.description;
  const allForms = listEnabledForms(tenantId, userId)
    .map((d) => `- ${d.data.title ?? d.agent.intent}：${d.agent.description}`)
    .join('\n');

  // 租戶自訂的 AI 名稱（admin 後台外觀設定）；未設則不自稱名字，維持既有行為
  const assistantName = tenantStore.getTenant(tenantId)?.appearance?.assistantName?.trim();

  const lines = [
    `你是公司 OA 系統的「${def.agent.description}」助理。${languageDirective(locale)}`,
    ...(assistantName ? [`你的名字是「${assistantName}」，使用者稱呼你時即指你。`] : []),
    `今天日期是 ${today}；請把相對日期（明天、下週一等）換算成 YYYY-MM-DD。`,
    '你專責表單填寫。若使用者問的是其他主題的問題（公司規定、知識庫文件內容等），請告知他可直接提問、系統會交由知識庫助理回答；與任何服務都無關的閒聊、算術等請禮貌婉拒，切勿回答離題內容。',
    '',
    '本系統目前可申請的表單（使用者詢問「有哪些表單可以申請」時，請完整列出以下全部，',
    `勿只回答目前這張表單）：`,
    allForms,
    `這場對話正在協助你填寫「${currentTitle}」。若使用者想改申請其他表單，請告知對方可直接`,
    '說出該表單名稱或需求（例如「我要外出登記」）即可另開申請。',
    '',
    '表單欄位（填入 fill_fields 時請用機器值，例如假別 annual/sick、是否需報銷 yes/no）：',
    describeFields(def),
  ];
  if (def.agent.confirmationTemplate) {
    lines.push('', `確認語句範本：${def.agent.confirmationTemplate}`);
  }
  lines.push('', '工作方式：', ...steps);
  return lines.join('\n');
}

interface DispatchCtx {
  def: Definition;
  session: Session;
  /** 本輪使用者訊息抵達時是否已處於 confirming（確認需在獨立一輪，防同輪自動送出） */
  canSubmit: boolean;
}

async function dispatchFormTool(
  ctx: DispatchCtx,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const { def, session } = ctx;

  if (name === 'fill_fields') {
    const fields = (input.fields ?? {}) as Record<string, unknown>;
    const applied: string[] = [];
    const rejected: FieldIssue[] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined || value === '') continue;
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
    return JSON.stringify({
      applied,
      rejected,
      missing: status.missing,
      invalid: status.invalid,
      isComplete: status.isComplete,
      currentValues: session.values,
    });
  }

  if (name === 'submit' || name === 'submit_leave_application') {
    if (name === 'submit_leave_application' && session.formId !== 'leave-request') {
      return JSON.stringify({ ok: false, error: 'submit_leave_application 僅適用請假申請' });
    }
    const issues = validateAll(def, session.values);
    if (issues.length > 0) {
      return JSON.stringify({ ok: false, error: '尚有欄位未完成，無法送出', issues });
    }
    if (!ctx.canSubmit || session.status !== 'confirming') {
      return JSON.stringify({
        ok: false,
        error: '請先向使用者出示摘要並取得「確認／送出」等明確送出指令，於下一輪再呼叫 submit',
      });
    }
    session.status = 'submitting';
    try {
      // 依表單類型查表選送出 service（外出登記 / 出差報銷 / 請假…）
      const submit = resolveSubmit(session.formId);
      const result = await submit(session.tenantId, session.userId, session.values);
      session.status = 'submitted';
      session.submission = {
        oaRequestId: result.oaRequestId,
        status: result.status,
        submittedAt: result.submittedAt,
        approvals: result.approvals,
      };
      // 已送出：附件 metadata 已隨 payload 交付，清掉本地暫存的檔案內容
      attachmentStore.clearSession(session.id);
      return JSON.stringify({ ok: true, oaRequestId: result.oaRequestId, status: result.status });
    } catch (err) {
      session.status = 'failed';
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }
  }

  if (name === 'get_leave_balances') {
    try {
      const balances = await leaveService.getBalances(session.userId);
      return JSON.stringify({ ok: true, balances });
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }
  }

  if (name === 'find_deputy_candidates') {
    const department = typeof input.department === 'string' ? input.department : undefined;
    const candidates = listDeputyCandidates({ requesterId: session.userId, department });
    return JSON.stringify({ ok: true, candidates });
  }

  if (name === 'compute_leave_hours') {
    const estimate = leaveService.estimateHours(session.tenantId, session.userId, session.values);
    if (!estimate) {
      return JSON.stringify({ ok: false, error: '尚無法計算（缺起訖日期或此表單未設定工時政策）' });
    }
    return JSON.stringify({ ok: true, ...estimate });
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}

export const formAgentService: AgentService = {
  id: 'form',
  label: '填表申請',
  description: '以對話引導填寫並送出 OA 表單（請假、出差報銷、外出登記…）；表單由 schema 定義，新增表單不需改程式',
  sticky: true,
  serviceScope: 'service:form',

  intents(session: Session): IntentDescriptor[] {
    return listEnabledForms(session.tenantId, session.userId).map((d) => ({
      id: `${d.formId}.apply`,
      keywords: d.agent.keywords ?? [],
      description: `填寫並送出「${d.data.title ?? d.agent.description}」表單`,
    }));
  },

  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const def = getDefinition(session.tenantId, session.formId);
    // 守門快照：只有「使用者本輪訊息抵達時已是 confirming」才允許 submit
    const canSubmit = session.status === 'confirming' && isSubmitConfirmation(userText);

    // 快速路徑：確認送出不經 LLM，直接呼叫送出守門（避免第一次按送出沒送出）
    if (canSubmit) {
      const submitToolName =
        session.formId === 'leave-request' ? 'submit_leave_application' : 'submit';
      const out = await dispatchFormTool({ def, session, canSubmit }, submitToolName, {});
      const result = JSON.parse(out) as { ok?: boolean; oaRequestId?: string; error?: string };
      const reply =
        result.ok && result.oaRequestId
          ? `已送出，OA 單號：${result.oaRequestId}。`
          : `尚未送出：${result.error ?? '送出失敗'}`;
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      return { reply };
    }

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.tenantId, session.userId, def, session.locale),
      tools: buildTools(def),
      dispatchTool: (name, inputArgs) =>
        dispatchFormTool({ def, session, canSubmit }, name, inputArgs),
    });

    logger.info(
      { sessionId: session.id, status: session.status, filled: Object.keys(session.values) },
      'form turn complete',
    );
    return { reply };
  },
};
