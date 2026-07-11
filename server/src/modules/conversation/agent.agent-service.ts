/**
 * Agent 服務：處理「跨多個工具、多步驟」的開放式任務。
 *
 * 與 Form/Knowledge 走固定劇本不同，Agent 把「該使用者有權限、且允許暴露給 Agent」的工具
 * （toolRegistry.availableFor）交給 LLM 自選，靠共用 tool-loop 多輪往返完成任務。
 * 安全：dispatchTool 只放行 availableFor 清單內的工具；LLM 即使幻想出別的工具名也呼叫不到
 * （送單等寫入動作因此不會被 Agent 觸發）。工具錯誤回傳為 tool_result，讓 LLM 自行修正而非中斷整輪。
 * sticky=true：Agent 常是多輪任務（如寄信：問主旨→問內容→擬稿→確認），需點黏才不會在
 * 蒐集資訊途中被沖回 form。避免「困在沒有表單工具的 Agent」的舊風險，改由 intent-router 的
 * 點黏逃逸機制處理——使用者只要講出其他服務的關鍵字（如「我要請假」→ form）或知識問句即可轉出。
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
    '- 使用者問申請/簽核進度時：用 oa_listMyRequests 列出他的申請、oa_getApprovalStatus 查特定單號的關卡；如實轉述查詢結果，查無就說查無。要催辦時，用 email.propose 擬催辦信（不確定收件人就先問使用者）。',
    '- 需要寄信時：呼叫 email.propose 擬稿（不會立即寄出），然後把收件人、主旨、內文清楚出示給使用者，請他確認；使用者回覆「確認」後系統才會寄出。你無法自行寄出。',
  ].join('\n');
}

export const agentAgentService: AgentService = {
  id: 'agent',
  label: '智慧代理',
  sticky: true,
  serviceScope: 'service:agent',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'agent.task',
        // 精準的「代寄信」動作片語（0-token 直接路由到 agent）；刻意用完整片語避免誤搶
        // （如「寄信給」不會命中「寄信的規定」這種問答）。開放式多步驟任務仍靠分類器判斷。
        keywords: [
          '寄信給', '幫我寄', '寄封信', '寄一封信', '發信給', '代寄',
          // 查簽核／催辦（完整片語，避免搶走「簽核規定是什麼」這類知識問句）
          '簽核進度', '簽到哪', '我的申請', '申請進度', '簽核狀態', '催辦',
        ],
        description:
          '需要操作公司系統/工具的任務：查詢並彙整資料、查自己申請的簽核進度、代擬並（經確認後）寄送通知信/催辦信 Email。',
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

    const registryTools = toolRegistry.availableFor(ctx);
    // Anthropic 工具名限 ^[a-zA-Z0-9_-]{1,128}$（不允許點）。registry id 用點命名（如 email.propose），
    // 對外暴露時轉成合法名（點→底線），並以明確 map 於 dispatch 時映回真實 id。
    const idByLlmName = new Map<string, string>();
    const tools = registryTools.map((t) => {
      const llmName = t.name.replace(/\./g, '_');
      idByLlmName.set(llmName, t.name);
      return { name: llmName, description: t.description, inputSchema: t.inputSchema };
    });

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.userId, session.locale),
      tools,
      dispatchTool: async (name, input) => {
        // 安全邊界：只放行 availableFor 清單內的工具（映回真實 id），LLM 幻想出別的名字一律擋下
        const realId = idByLlmName.get(name);
        if (!realId) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const result = await toolRegistry.invoke(realId, input, ctx);
          // 提議寄信：存草稿、指示 LLM 出示並徵求確認，切勿宣稱已寄
          if (realId === 'email.propose') {
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
