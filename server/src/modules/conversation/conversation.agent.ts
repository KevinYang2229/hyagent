/**
 * 對話 turn 編排（路由 + 建議回覆）。
 *
 * 一則使用者訊息 → intent-router 判斷指派服務 → 該 AgentService 處理一輪 → 一則回覆。
 * 填表 slot-filling 的細節在 form.agent-service.ts；知識問答在 knowledge 模組。
 */
import { getLLMProvider } from '@/lib/llm';
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { normalizeLocale } from '@/lib/locale';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { conversationStore } from './conversation.store';
import type { Session, TurnResult } from './conversation.types';
import { intentRouter } from './intent-router';
import { serviceRegistry } from './service.registry';

// 送出語意判斷仍由 form 服務定義；此處 re-export 維持既有匯入點（含測試）不變
export { isSubmitConfirmation } from './form.agent-service';

// 建議回覆產生器：站在「使用者」立場，針對助理最後一則訊息給 2-3 個可一鍵送出的短回覆。
// 依 session locale 產生對應語言的建議（英文 UI → 英文建議）。
function suggestSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You generate "quick reply" suggestions for an OA chat UI. Respond entirely in English.',
      "Based on the assistant's last message and the form state, produce the user's most likely, most helpful follow-up replies.",
      'Rules:',
      '- Output 2-3 options; each a short imperative/answer phrase (no more than ~6 words).',
      '- Answer AS THE USER replying to the assistant, not restating the assistant; options must not overlap.',
      '- In the confirm stage include things like "Confirm & submit", "Edit details", "Cancel"; in the collecting stage match the field the assistant is asking about.',
      'Output ONLY a JSON string array, e.g. ["Confirm & submit","Change date"], with no extra text.',
    ].join('\n');
  }
  return [
    '你是 OA 對話介面的「建議回覆」產生器，全程使用繁體中文。',
    '根據「助理最後一則訊息」與表單狀態，產生使用者最可能、最有幫助的接續回覆。',
    '規則：',
    '- 輸出 2-3 個選項；每個是簡短的祈使／回答短語（不超過 14 個字）。',
    '- 站在「使用者」立場回答助理，而非複述助理的話；選項之間語意不重複。',
    '- 確認階段可包含「確認送出」「修改內容」「取消」之類；收集階段則貼合助理正在詢問的欄位。',
    '只輸出 JSON 字串陣列，例如 ["確認送出","修改日期"]，不要任何額外文字或說明。',
  ].join('\n');
}

/** 從模型輸出中寬鬆解析出建議字串陣列；任何異常都回空陣列（best-effort） */
function parseSuggestions(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** 以一次獨立、輕量的 LLM 呼叫產生建議回覆；失敗不影響主流程 */
async function generateSuggestions(
  llm: LLMProvider,
  session: Session,
  reply: string,
): Promise<string[]> {
  // 對話已結束（送出／取消／失敗）不需要建議；無回覆內容也略過
  if (!reply || ['submitted', 'cancelled', 'failed'].includes(session.status)) return [];
  try {
    const userMsg = `助理最後一則訊息：\n「${reply}」\n\n目前表單狀態：${session.status}。\n請給建議回覆。`;
    const result = await llm.createMessage({
      system: suggestSystem(session.locale),
      messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
      maxTokens: 256,
    });
    usageStore.recordLLMUsage(session.tenantId, result);
    return parseSuggestions(result.text);
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'generate suggestions failed');
    return [];
  }
}

export async function runTurn(session: Session, userText: string): Promise<TurnResult> {
  const llm = getLLMProvider(tenantStore.getTenant(session.tenantId)?.llmConfig);
  session.messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });

  // 路由：判斷本輪指派哪個服務（填表點黏、知識可旁路插入）
  const route = await intentRouter.route(session, userText);
  const service = serviceRegistry.get(route.serviceId);
  const { reply } = await service.handleTurn(session, userText, llm);

  // 只有點黏服務（form）成為 activeService；旁路服務（knowledge）不奪走流程擁有權
  if (service.sticky) session.activeServiceId = service.id;

  logger.info(
    { sessionId: session.id, serviceId: service.id, viaLLM: route.viaLLM, status: session.status },
    'conversation turn routed',
  );

  const suggestions = await generateSuggestions(llm, session, reply);
  conversationStore.save(session); // flush 本輪變更（values/status/messages/submission）
  return {
    reply,
    status: session.status,
    values: session.values,
    submission: session.submission,
    suggestions,
  };
}
