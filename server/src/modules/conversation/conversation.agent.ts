import { querySignal, throwIfQueryCancelled } from '@/lib/query-cancellation';
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
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import { publicSuggestedPrompts } from '@/modules/knowledge/prompt-feed';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { assistantAgentService } from './assistant.agent-service';
import { conversationStore } from './conversation.store';
import type { Session, TurnResult } from './conversation.types';
import { intentRouter } from './intent-router';
import { recordReply } from './reply-record';
import { serviceRegistry } from './service.registry';

// 送出語意判斷仍由 form 服務定義；此處 re-export 維持既有匯入點（含測試）不變
export { isSubmitConfirmation } from './form.agent-service';

// 建議回覆產生器：站在「使用者」立場，針對助理最後一則訊息給 2-3 個可一鍵送出的短回覆。
// 依 session locale 產生對應語言的建議（英文 UI → 英文建議）。
function suggestSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You generate "quick reply" suggestions for a chat assistant. Respond entirely in English.',
      "Based on the user's question, the assistant's last message, and the form state, produce the user's most likely, most helpful follow-up replies.",
      'Rules:',
      '- Output 2-3 options; each a short imperative/answer phrase (no more than ~6 words).',
      '- Answer AS THE USER replying to the assistant, not restating the assistant; options must not overlap.',
      '- In the confirm stage include things like "Confirm & submit", "Edit details", "Cancel"; in the collecting stage match the field the assistant is asking about.',
      '- Every option must move the conversation forward: a follow-up question, a concrete answer, or an action. Never output acknowledgements or courtesies such as "Got it", "OK", "Thanks", "Understood", and never begin or end an option with one (e.g. not "Change the date, thanks").',
      '- Only use what appears in the conversation above. You do not know what the knowledge base or the company covers — never invent topics, policies, or documents (e.g. travel expenses, annual leave, employee handbook) that were not mentioned.',
      'Output ONLY a JSON string array, e.g. ["Confirm & submit","Change date"], with no extra text.',
    ].join('\n');
  }
  return [
    '你是對話助理的「建議回覆」產生器，全程使用繁體中文。',
    '根據「使用者的提問」「助理最後一則訊息」與表單狀態，產生使用者最可能、最有幫助的接續回覆。',
    '規則：',
    '- 輸出 2-3 個選項；每個是簡短的祈使／回答短語（不超過 14 個字）。',
    '- 站在「使用者」立場回答助理，而非複述助理的話；選項之間語意不重複。',
    '- 確認階段可包含「確認送出」「修改內容」「取消」之類；收集階段則貼合助理正在詢問的欄位。',
    '- 每個選項都要讓對話往前：接續提問、具體回答或操作。不要輸出「了解」「好的」「謝謝」「收到」「知道了」這類客套或表示收到的短語，選項開頭與結尾也不要加（例如不要「請幫我查詢，謝謝」）。',
    '- 只能根據上面對話中出現過的內容提出追問或回答。你不知道知識庫或公司有哪些內容，不要自行假設或編造對話中沒出現的主題、制度或文件（例如差旅報帳、特休、員工手冊）。',
    '只輸出 JSON 字串陣列，例如 ["確認送出","修改日期"]，不要任何額外文字或說明。',
  ].join('\n');
}

// 客套、表示收到的短語。長的放前面，避免「了解」先吃掉「了解了」的一部分。
// 「謝謝」這類不會和內容黏在一起，結尾沒有標點也切（「請幫我查詢謝謝」）；
// 「好」「了解」可能是內容的一部分（「怎麼請假比較好」「我想了解」），前面要有標點或空白才當客套話
const THANKS_TOKENS = ['謝謝你', '謝謝您', '謝謝啦', '謝謝', '感謝你', '感謝您', '感謝', '多謝', 'thank\\s*you', 'thanks', 'thx'];
const ACK_TOKENS = [
  '我了解了', '了解了', '了解', '明白了', '明白', '我知道了', '知道了', '好的', '好喔', '好',
  '收到', '沒問題', '嗯', 'got\\s*it', 'understood', 'noted', 'okay', 'ok',
];
const SEP = '[\\s\\p{P}\\p{S}\\p{M}\\p{Cf}]';
const THANKS = `(?:${THANKS_TOKENS.join('|')})`;
const COURTESY = `(?:${[...THANKS_TOKENS, ...ACK_TOKENS].join('|')})`;
const COURTESY_SEQ = `(?:${SEP}*${COURTESY})*${SEP}*`;
const COURTESY_TAIL_RE = new RegExp(`(?:(?<=^|${SEP})${COURTESY}|${THANKS})${COURTESY_SEQ}$`, 'iu');
const COURTESY_HEAD_RE = new RegExp(`^${SEP}*${COURTESY}(?:${SEP}*${COURTESY})*${SEP}+(?=[^\\s\\p{P}\\p{S}])`, 'iu');
const COURTESY_WHOLE_RE = new RegExp(COURTESY, 'giu');

/** 切掉開頭與結尾的客套話（「特休怎麼算？謝謝」→「特休怎麼算？」、「了解，我要改成下週一」→「我要改成下週一」） */
function stripCourtesy(s: string): string {
  return s
    .replace(COURTESY_TAIL_RE, '')
    .replace(COURTESY_HEAD_RE, '')
    .replace(/[\s,，、~～:：;；]+$/u, '')
    .trim();
}

/** 是否只剩客套或表示收到（「了解」「好的，謝謝！」「Got it」「👍」）：點了不會讓對話往前，不該當建議回覆 */
function isAcknowledgement(s: string): boolean {
  const bare = s.replace(/[\p{P}\p{S}\p{M}\p{Cf}\s]/gu, '');
  return bare.replace(COURTESY_WHOLE_RE, '') === '';
}

/** 從模型輸出中寬鬆解析出建議字串陣列；任何異常都回空陣列（best-effort） */
export function parseSuggestions(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === 'string')
      .map((s) => stripCourtesy(s.trim()))
      .filter((s, i, all) => s && !isAcknowledgement(s) && all.indexOf(s) === i)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * 產生建議回覆（best-effort，失敗不影響主流程）。
 * - 閒聊／守門（自我介紹、說明能力、婉拒離題）：直接用知識庫的開場推薦問句。產生器只看得到對話，
 *   不知道租戶知識庫有什麼，會憑「公司 OA」的印象編出不相干的主題；開場推薦問句是從知識庫內容生成、
 *   且只用訪客看得到的內容（publicSuggestedPrompts），拿來用不會洩漏可見範圍。
 * - 其他回答（或沒有開場推薦問句時）：一次獨立、輕量的 LLM 呼叫，帶上使用者的提問，只能依對話內容建議。
 */
export async function generateSuggestions(
  llm: LLMProvider,
  session: Session,
  reply: string,
  ctx: { serviceId: string; userText: string },
): Promise<string[]> {
  // 對話已結束（送出／取消／失敗）不需要建議；無回覆內容也略過
  if (!reply || ['submitted', 'cancelled', 'failed'].includes(session.status)) return [];
  if (ctx.serviceId === assistantAgentService.id) {
    const grounded = groundedOpeningPrompts(session);
    if (grounded.length > 0) return grounded;
  }
  try {
    const userMsg = `使用者的提問：\n「${ctx.userText}」\n\n助理最後一則訊息：\n「${reply}」\n\n目前表單狀態：${session.status}。\n請給建議回覆。`;
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

/** 這位使用者有開通知識庫時，回傳依介面語言挑好的開場推薦問句；否則空陣列 */
function groundedOpeningPrompts(session: Session): string[] {
  const knowledgeOn = serviceRegistry
    .enabledFor(session.tenantId, session.userId)
    .some((svc) => svc.id === knowledgeAgentService.id);
  if (!knowledgeOn) return [];
  const lang = normalizeLocale(session.locale) === 'en' ? 'en' : 'zh-Hant';
  return publicSuggestedPrompts(session.tenantId)
    .map((p) => p[lang]?.trim())
    .filter((t): t is string => !!t)
    .slice(0, 3);
}

async function performTurn(session: Session, userText: string): Promise<TurnResult> {
  throwIfQueryCancelled();
  const llm = getLLMProvider(tenantStore.getTenant(session.tenantId)?.llmConfig, session.tenantId);
  session.messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });

  // 路由：判斷本輪指派哪個服務（填表點黏、知識可旁路插入）
  const route = await intentRouter.route(session, userText);
  throwIfQueryCancelled();
  const service = serviceRegistry.get(route.serviceId);
  // 記下服務作答時最後一次用的模型：表單、報告等服務不回報 trace，後台回饋仍要看得到模型
  let answerModel: string | undefined;
  const trackedLLM: LLMProvider = {
    name: llm.name,
    async createMessage(params) {
      const result = await llm.createMessage(params);
      answerModel = result.model;
      return result;
    },
  };
  const { reply, report, pendingAction, blocks, trace } = await service.handleTurn(session, userText, trackedLLM);

  throwIfQueryCancelled();
  // 只有點黏服務（form）成為 activeService；旁路服務（knowledge）不奪走流程擁有權
  if (service.sticky) session.activeServiceId = service.id;

  logger.info(
    { sessionId: session.id, serviceId: service.id, viaLLM: route.viaLLM, status: session.status },
    'conversation turn routed',
  );

  const suggestions = await generateSuggestions(llm, session, reply, { serviceId: service.id, userText });
  // 有回覆文字才可評價；報告 id 併進 trace，後台從回饋可追到那份報告。
  // 知識庫／代理自己回報 trace（知識庫查無資料時刻意不帶模型，不能拿改寫或重排的模型冒充）；
  // 沒有回報 trace 的服務才補上作答模型
  throwIfQueryCancelled();
  const serviceTrace = trace ?? (answerModel ? { model: answerModel } : undefined);
  const replyTrace = report ? { ...(serviceTrace ?? {}), reportId: report.id } : serviceTrace;
  const record = reply
    ? recordReply(session, { question: userText, answer: reply, serviceId: service.id, trace: replyTrace })
    : undefined;
  conversationStore.save(session); // flush 本輪變更（values/status/messages/submission/replies）
  return {
    reply,
    ...(record ? { replyId: record.id } : {}),
    status: session.status,
    values: session.values,
    submission: session.submission,
    suggestions,
    ...(report ? { report } : {}),
    ...(pendingAction ? { pendingAction } : {}),
    ...(blocks && blocks.length > 0 ? { blocks } : {}),
  };
}


const runningTurns = new Map<string, Promise<TurnResult>>();

/** 同一對話依序執行；停止後補齊工具訊息配對，下一則可安全繼續。 */
export function runTurn(session: Session, userText: string): Promise<TurnResult> {
  const previous = runningTurns.get(session.id);
  const turn = (async () => {
    if (previous) await previous.catch(() => undefined);
    throwIfQueryCancelled();
    const messageStart = session.messages.length;
    const pendingId = session.pendingAction?.id;
    try {
      return await performTurn(session, userText);
    } catch (err) {
      if (querySignal()?.aborted) {
        const completed = new Set(session.messages.slice(messageStart).flatMap((m) => m.content)
          .filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
        // API 要求每個 tool_use 都有對應 tool_result，取消不能留下破損歷史。
        const missing = session.messages.slice(messageStart).flatMap((m) => m.content)
          .filter((b) => b.type === 'tool_use' && !completed.has(b.id));
        if (missing.length) session.messages.push({ role: 'user', content: missing.map((b) => ({
          type: 'tool_result' as const, toolUseId: b.type === 'tool_use' ? b.id : '',
          content: '查詢已停止；未取得結果，請勿推定操作成功或自動重試。', isError: true,
        })) });
        if (session.pendingAction?.id !== pendingId) session.pendingAction = undefined;
        session.messages.push({ role: 'assistant', content: [{ type: 'text', text:
          session.locale === 'en' ? 'Query stopped.' : '查詢已停止。' }] });
        conversationStore.save(session);
        throwIfQueryCancelled();
      }
      throw err;
    }
  })();
  runningTurns.set(session.id, turn);
  void turn.finally(() => { if (runningTurns.get(session.id) === turn) runningTurns.delete(session.id); }).catch(() => undefined);
  return turn;
}
