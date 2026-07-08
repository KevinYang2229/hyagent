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
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { listEnabledForms } from './form.agent-service';

function guardSystem(tenantId: string, userId: string, locale?: string): string {
  const forms = listEnabledForms(tenantId, userId)
    .map((d) => d.data.title ?? d.agent.description)
    .filter(Boolean);
  if (normalizeLocale(locale) === 'en') {
    const caps = forms.length
      ? `form applications (e.g. ${forms.join(', ')}) and company information`
      : 'form applications and company information';
    return [
      `You are the company OA assistant. You only help with ${caps}. Respond entirely in English.`,
      'Rules:',
      '- If the user is greeting, thanking, or asking who you are: reply briefly and warmly, and state what you can help with.',
      '- If the user asks anything unrelated to the company or forms (general knowledge, math, chit-chat, news): politely decline, say it is outside your scope, and steer them to a form or company question.',
      '- Keep replies to 2-3 sentences. Never actually answer the off-topic question.',
    ].join('\n');
  }
  const caps = forms.length
    ? `公司表單申請（例如：${forms.join('、')}）與公司相關資訊`
    : '公司表單申請與公司相關資訊';
  return [
    `你是公司 OA 系統的助理，只協助${caps}。全程使用繁體中文。`,
    '規則：',
    '- 若使用者是打招呼、道謝、問候或問「你是誰」：簡短友善回應，並說明你能協助什麼。',
    '- 若使用者問的是與公司/表單無關的一般問題（常識、算術、閒聊、時事等）：禮貌婉拒，說明超出你的服務範圍，並引導他改問表單或公司相關問題。',
    '- 回覆精簡（2-3 句內），切勿真的回答離題問題的內容。',
  ].join('\n');
}

/** LLM 失敗時的靜態婉拒（含關鍵字「服務範圍」，與測試一致）。 */
function staticReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'I can only help with company form applications and company information — both outside that scope I cannot assist. What would you like to do?'
    : '不好意思，這超出我的服務範圍；我可以協助公司表單申請與公司相關資訊，請問需要什麼協助呢？';
}

export const assistantAgentService: AgentService = {
  id: 'assistant',
  label: '對話護欄',
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
