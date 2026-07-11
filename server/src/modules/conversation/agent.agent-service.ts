/**
 * Agent 服務：處理「跨多個工具、多步驟」的開放式任務。
 *
 * 與 Form/Knowledge 走固定劇本不同，Agent 把「該使用者有權限、且允許暴露給 Agent」的工具
 * （toolRegistry.availableFor）交給 LLM 自選，靠共用 tool-loop 多輪往返完成任務。
 * 安全：dispatchTool 只放行 availableFor 清單內的工具；LLM 即使幻想出別的工具名也呼叫不到
 * （送單等寫入動作因此不會被 Agent 觸發）。工具錯誤回傳為 tool_result，讓 LLM 自行修正而非中斷整輪。
 * sticky=false：v1 Agent 是單輪、唯讀的旁路服務（與 knowledge 相同定位），完成一輪就放手，
 * 不會把後續對話點黏在自己身上；否則下一句普通填表訊息（如「我要請假」）會被困在沒有表單工具
 * 的 Agent 裡出不來。等 Agent 具備跨輪的多步驟狀態後，再評估是否需要真正的點黏。
 */
import type { LLMProvider } from '@/lib/llm/types';
import type { EmailSendResult } from '@/lib/email/types';
import { languageDirective } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { runToolLoop } from './tool-loop';

// 確認/取消語意判斷：取消優先於確認（例如「確認」被「不要，先不要確認」蓋過時，先擋取消詞）。
// 需「整句就是明確的確認」才送出（避免『OK 謝謝先這樣』這類夾帶確認詞卻非確認意圖的訊息誤送）。
const EMAIL_CONFIRM_RE = /^(好的?[，,]?\s*)?(請\s*)?(幫我\s*)?(確認寄出|確定寄出|確認|確定|寄出|送出|同意寄出|可以寄出?|寄|OK|ok)$/;
const EMAIL_CANCEL_RE = /(不要|先不要|別|取消|不寄|暫停|改)/;
function isEmailConfirmation(text: string): boolean {
  const s = text.trim().replace(/[。.,，!！~\s]+$/u, '');
  if (!s || EMAIL_CANCEL_RE.test(s)) return false;
  return EMAIL_CONFIRM_RE.test(s);
}

function buildSystemPrompt(userId: string, locale?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你是公司 OA 系統的智慧代理，協助使用者完成需要操作公司系統的任務。${languageDirective(locale)}`,
    `今天日期是 ${today}；請把相對日期（明天、下週一等）換算成 YYYY-MM-DD。`,
    `目前登入使用者的識別碼是 ${userId}；查詢「自己」資料的工具會自動綁定此身分，不需要你提供或詢問使用者 id。`,
    '工作方式：',
    '- 只能使用提供給你的工具；沒有合適工具時，據實說明目前無法完成，不要捏造結果或假裝已完成。',
    '- 需要時可連續呼叫多個工具，依回傳結果決定下一步，完成後用簡潔中文回覆使用者。',
    '- 工具回傳錯誤時，向使用者說明狀況或改用其他方式，不要重複無效呼叫。',
    '- 只處理與公司 OA 相關的任務；與公司無關的一般問題請禮貌婉拒。',
    '- 需要寄信時：呼叫 email.propose 擬稿（不會立即寄出），然後把收件人、主旨、內文清楚出示給使用者，請他確認；使用者回覆「確認」後系統才會寄出。你無法自行寄出。',
  ].join('\n');
}

export const agentAgentService: AgentService = {
  id: 'agent',
  label: '智慧代理',
  sticky: false,
  serviceScope: 'service:agent',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'agent.task',
        keywords: [],
        description:
          '需要操作公司系統/工具的任務，例如查詢並彙整多項資料、代擬並（經確認後）寄送通知信 Email。',
      },
    ];
  },

  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const ctx = makeToolContext({
      tenantId: session.tenantId,
      userId: session.userId,
      locale: session.locale,
    });

    // 確認閘：有待確認草稿且本輪為確認語意 → 伺服器端直接寄出（LLM 全程碰不到 email.send）
    if (session.pendingEmail && isEmailConfirmation(userText)) {
      const pending = session.pendingEmail;
      session.pendingEmail = undefined;
      let reply: string;
      try {
        const r = (await toolRegistry.invoke('email.send', pending, ctx)) as EmailSendResult;
        reply = `已寄出，messageId：${r.messageId}。`;
      } catch (err) {
        reply = `寄送失敗：${(err as Error).message}`;
      }
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      logger.info({ sessionId: session.id, to: pending.to }, 'agent email sent (confirmed)');
      return { reply };
    }
    // 非確認 → 讓上一份草稿過期（避免殘留被日後無關「確認」誤觸發），再走 tool-loop（可能重新提議）
    session.pendingEmail = undefined;

    const tools = toolRegistry.availableFor(ctx);
    const allowed = new Set(tools.map((t) => t.name));

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.userId, session.locale),
      tools,
      dispatchTool: async (name, input) => {
        // 安全邊界：只放行 availableFor 清單內的工具，LLM 幻想出別的名字一律擋下
        if (!allowed.has(name)) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const result = await toolRegistry.invoke(name, input, ctx);
          // 提議寄信：存草稿、指示 LLM 出示並徵求確認，切勿宣稱已寄
          if (name === 'email.propose') {
            session.pendingEmail = (result as { draft: { to: string; subject: string; html: string } }).draft;
            return JSON.stringify({
              ok: true,
              proposed: true,
              note: '草稿已存。請把收件人、主旨、內文完整出示給使用者，並請他回覆「確認」才會寄出；切勿宣稱已寄出。',
            });
          }
          return JSON.stringify({ ok: true, result });
        } catch (err) {
          // 工具錯誤（權限/驗證/連接器）回傳給 LLM 自行修正，不中斷整輪
          return JSON.stringify({ ok: false, error: (err as Error).message });
        }
      },
    });

    logger.info({ sessionId: session.id, toolCount: tools.length }, 'agent turn complete');
    return { reply };
  },
};
