/**
 * Assistant 守門服務：把守「可回答範圍」的唯一出口。
 *
 * 統一處理兩種「非表單、非知識」情境：
 *  - 基本客套（打招呼、道謝、問候、問你是誰）→ 友善簡短回應並介紹能力。
 *  - 離題（與公司/OA 無關的一般常識、算術、閒聊）→ 禮貌婉拒並引導回服務範圍。
 * sticky=false：旁路服務，回答後不奪走流程，且刻意不觸碰 session.values / status。
 * intents() 回一個 off-topic 描述供分類器目錄使用；alwaysEnabled 讓此服務永遠啟用。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { normalizeLocale } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { mcpServicesFor } from '@/modules/mcp/mcp.intents';
import { usageStore } from '@/modules/usage/usage.store';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { listEnabledForms } from './form.agent-service';

/**
 * 依「這位使用者實際開通的服務」組能力清單——只列他真的能用的，避免護欄不停推銷用不到的服務。
 * 表單走 listEnabledForms（form:<id> scope 過濾）；知識庫/代理各查其 service scope。
 * 不 import service.registry（會與 registry → assistant 形成循環），改直接查 resolveScopes。
 */
function guardSystem(tenantId: string, userId: string, locale?: string): string {
  const scopes = new Set(resolveScopes({ tenantId, userId }));
  const forms = listEnabledForms(tenantId, userId)
    .map((d) => d.data.title ?? d.agent.description)
    .filter(Boolean);
  const knowledgeOn = scopes.has('service:knowledge');
  // 代理任務只列這位使用者真的能用的：已授權的外部服務（後台註冊時填的說明），有寄信權限才提寄信
  const agentOn = scopes.has('service:agent');
  const services = agentOn ? mcpServicesFor(tenantId, userId) : [];
  const emailOn = agentOn && scopes.has('email:write');

  if (normalizeLocale(locale) === 'en') {
    const parts: string[] = [];
    if (forms.length) parts.push(`form applications (e.g. ${forms.join(', ')})`);
    if (knowledgeOn) parts.push('knowledge-base Q&A (company info and any ingested documents, any topic)');
    const tasks = [
      ...services.map((m) => (m.description ? `${m.name} (${m.description})` : m.name)),
      ...(emailOn ? ['drafting emails'] : []),
    ];
    if (tasks.length) parts.push(`assistant tasks (${tasks.join(', ')})`);
    // 一項服務都沒開通：誠實說明並導向管理員，切勿再建議用不到的功能（否則使用者被困在「建議→試→被擋」循環）
    if (parts.length === 0) {
      return [
        "You are this system's assistant. Respond entirely in English.",
        'The current user has no services enabled on their account.',
        'Rules:',
        '- If the user greets, thanks, or asks who you are: reply briefly and warmly.',
        '- For anything else: explain that no services are currently enabled for their account and they should contact their administrator. Do NOT suggest specific capabilities, and do NOT tell them to ask the knowledge base.',
        '- Keep replies to 1-2 sentences. Never actually answer an off-topic question.',
      ].join('\n');
    }
    const rules = [
      `You are this system's assistant. You help with ${parts.join(', ')}. Respond entirely in English.`,
      'Rules:',
      '- If the user is greeting, thanking, or asking who you are: reply briefly and warmly, and state what you can help with (only the capabilities listed above).',
    ];
    if (knowledgeOn) {
      rules.push(
        '- If the question might be answered by the knowledge base: tell the user to just ask it directly — the system will search the knowledge base.',
      );
    }
    rules.push(
      '- Only decline what no enabled service covers (small talk, arithmetic, news): politely say it is outside your scope.',
      '- Never suggest a capability that is not listed above.',
      '- Keep replies to 2-3 sentences. Never actually answer the off-topic question.',
    );
    return rules.join('\n');
  }

  const parts: string[] = [];
  if (forms.length) parts.push(`表單申請（例如：${forms.join('、')}）`);
  if (knowledgeOn) parts.push('知識庫問答（公司資訊與已收錄文件的內容，主題不限）');
  const tasks = [
    ...services.map((m) => (m.description ? `${m.name}（${m.description}）` : m.name)),
    ...(emailOn ? ['代擬寄信'] : []),
  ];
  if (tasks.length) parts.push(`代理任務：${tasks.join('、')}`);
  // 一項服務都沒開通：誠實說明並導向管理員，切勿再建議用不到的功能
  if (parts.length === 0) {
    return [
      '你是本系統的助理，全程使用繁體中文。',
      '目前這位使用者的帳號沒有開通任何可用服務。',
      '規則：',
      '- 若使用者是打招呼、道謝、問候或問「你是誰」：簡短友善回應即可。',
      '- 其餘一律說明「你的帳號目前尚未開通任何可用服務，請洽系統管理員開通」；不要建議任何具體功能，也不要叫他去問知識庫。',
      '- 回覆精簡（1-2 句內），切勿真的回答離題問題的內容。',
    ].join('\n');
  }
  const rules = [
    `你是本系統的助理，協助範圍：${parts.join('、')}。全程使用繁體中文。`,
    '規則：',
    '- 若使用者是打招呼、道謝、問候或問「你是誰」：簡短友善回應，並說明你能協助什麼（僅限上述已開通範圍）。',
  ];
  if (knowledgeOn) {
    rules.push('- 若問題可能在知識庫有答案：告知他直接提問即可，系統會查詢知識庫回答。');
  }
  rules.push(
    '- 只有任何已開通服務都涵蓋不到的內容（閒聊、算術、時事等）才禮貌婉拒，說明超出你的服務範圍。',
    '- 切勿建議任何未列在上述範圍內的功能。',
    '- 回覆精簡（2-3 句內），切勿真的回答離題問題的內容。',
  );
  return rules.join('\n');
}

/**
 * LLM 失敗時的靜態婉拒（含關鍵字「服務範圍」，與測試一致）。
 * 刻意不寫死具體能力（表單/知識庫…）——失敗路徑拿不到 scope，寫死會對「沒開通該服務」的
 * 使用者誤導；改為中性訊息並導向管理員了解可用範圍。
 */
function staticReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'Sorry, I cannot handle this request right now. Please try again shortly, or contact your administrator about the services available to you.'
    : '不好意思，目前無法處理這個請求；請稍後再試，或洽系統管理員了解你可使用的服務範圍。';
}

export const assistantAgentService: AgentService = {
  id: 'assistant',
  label: '對話護欄',
  description: '兜底與守門：離題引導回可用功能、說明平台能力；恆啟用，不可停用',
  sticky: false,
  alwaysEnabled: true,

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'off-topic',
        keywords: [],
        description:
          '與公司/OA 無關的一般問題（常識、算術、閒聊、時事等），或單純打招呼、道謝、問候、問「你是誰」等客套',
      },
    ];
  },

  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    let reply: string;
    try {
      const result = await llm.createMessage({
        system: guardSystem(session.tenantId, session.userId, session.locale),
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        maxTokens: 256,
      });
      // 護欄回覆此前漏記用量（真花 provider token 卻不進月配額統計），一併補上
      usageStore.recordLLMUsage(session.tenantId, result);
      reply = result.text || staticReply(session.locale);
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, 'assistant guard reply failed');
      reply = staticReply(session.locale);
    }
    // 旁路：只留逐字稿，刻意不觸碰 session.values / session.status
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    return { reply };
  },
};
