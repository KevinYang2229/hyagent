/**
 * Agent 服務：處理「跨多個工具、多步驟」的開放式任務。
 *
 * 與 Form/Knowledge 走固定劇本不同，Agent 把「該使用者有權限、且允許暴露給 Agent」的工具
 * （toolRegistry.availableFor，含 MCP 等動態來源）交給 LLM 自選，靠共用 tool-loop 多輪往返完成任務。
 * 安全：
 *  - dispatchTool 只放行 availableFor 清單內的工具；LLM 幻想出別的工具名一律擋下。
 *  - 寫入工具（effect 非 read）LLM 只能「提議」：存成 session.pendingAction 並回給前端確認卡片，
 *    使用者確認後才由後端執行（確認端點或本服務的打字確認閘），LLM 全程碰不到執行。
 *  - 工具錯誤回傳為 tool_result，讓 LLM 自行修正而非中斷整輪。
 * sticky=true：Agent 常是多輪任務，需點黏才不會在蒐集資訊途中被沖回 form。
 */
import type { LLMProvider, LLMTool } from '@/lib/llm/types';
import { languageDirective } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { mcpIntentsFor, mcpPromptLines } from '@/modules/mcp/mcp.intents';
import { isWriteTool, makeToolContext, toolRegistry } from '@/modules/tools';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import {
  createPendingAction,
  isConfirmationText,
  isPendingActionExpired,
  toPendingActionView,
} from './pending-action';
import { runConfirmedAction } from './pending-action.service';
import { runToolLoop } from './tool-loop';

/** Anthropic 上限 128、OpenAI 上限 64，取交集。 */
const LLM_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function buildSystemPrompt(userId: string, locale?: string, extraLines: string[] = []): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你是公司 OA 系統的智慧代理，協助使用者完成需要操作公司系統的任務。${languageDirective(locale)}`,
    `今天日期是 ${today}；請把相對日期（明天、下週一等）換算成 YYYY-MM-DD。`,
    `目前登入使用者的識別碼是 ${userId}；查詢「自己」資料的工具會自動綁定此身分，不需要你提供或詢問使用者 id。`,
    ...extraLines,
    '工作方式：',
    '- 只能使用提供給你的工具；沒有合適工具時，據實說明目前無法完成，不要捏造結果或假裝已完成。',
    '- 需要時可連續呼叫多個工具，依回傳結果決定下一步，完成後用簡潔中文回覆使用者。',
    '- 工具回傳錯誤時，向使用者說明狀況或改用其他方式，不要重複無效呼叫。',
    '- 只處理與公司系統或知識庫相關的任務；純閒聊、與任何服務無關的問題請禮貌婉拒。',
    '- 寫入類工具（寄信、預約、建立或修改資料等）呼叫後不會立即執行：系統會把內容做成確認卡片給使用者。你要用一兩句話說明即將執行的內容並請使用者確認，切勿宣稱已完成。',
    '- 使用者問申請/簽核進度時：用 oa_listMyRequests 列出他的申請、oa_getApprovalStatus 查特定單號的關卡；如實轉述查詢結果，查無就說查無。要催辦時，用 email_send 擬催辦信（不確定收件人就先問使用者）。',
    '- 需要寄信時：呼叫 email_send 並帶上完整收件人、主旨、內文；系統會先請使用者確認才寄出。',
  ].join('\n');
}

/** 把 registry 的點命名轉成 LLM 合法名；不合法或撞名的工具不暴露（記警告），並回傳映回真實 id 的表。 */
function exposeTools(tools: LLMTool[]): { llmTools: LLMTool[]; idByLlmName: Map<string, string> } {
  const idByLlmName = new Map<string, string>();
  const llmTools: LLMTool[] = [];
  for (const t of tools) {
    const llmName = t.name.replace(/\./g, '_');
    if (!LLM_TOOL_NAME_RE.test(llmName) || idByLlmName.has(llmName)) {
      logger.warn({ toolId: t.name, llmName }, 'tool not exposed: invalid or colliding LLM name');
      continue;
    }
    idByLlmName.set(llmName, t.name);
    llmTools.push({ ...t, name: llmName });
  }
  return { llmTools, idByLlmName };
}

export const agentAgentService: AgentService = {
  id: 'agent',
  label: '智慧代理',
  description: '多步驟任務代理：跨工具規劃與執行（查詢、寄信、外部服務等），寫入動作經使用者確認',
  sticky: true,
  serviceScope: 'service:agent',

  intents(session: Session): IntentDescriptor[] {
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
      ...mcpIntentsFor(session.tenantId, session.userId),
    ];
  },

  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const ctx = makeToolContext({
      tenantId: session.tenantId,
      userId: session.userId,
      locale: session.locale,
    });

    // 打字確認閘（確認卡片按鈕的備援）：只有未過期的待確認動作 + 整句即確認時才執行
    const pending = session.pendingAction;
    if (pending) {
      session.pendingAction = undefined; // 一次性：不論結果如何，這筆都不再有效
      if (isPendingActionExpired(pending)) {
        if (isConfirmationText(userText)) {
          const reply = `「${pending.summary.title}」已逾時失效，請重新提出需求。`;
          session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
          return { reply };
        }
      } else if (isConfirmationText(userText)) {
        const outcome = await runConfirmedAction(session, pending);
        logger.info({ sessionId: session.id, toolId: pending.toolId, ok: outcome.ok }, 'agent action confirmed by text');
        return { reply: outcome.reply };
      }
    }

    // 本輪是否已提議過寫入：上一輪遺留的 pendingAction 已在上方作廢，這裡只管同一輪內的第二筆
    let proposedThisTurn = false;

    await toolRegistry.prepare(ctx);
    const { llmTools, idByLlmName } = exposeTools(toolRegistry.availableFor(ctx));

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.userId, session.locale, mcpPromptLines(session.tenantId, session.userId)),
      tools: llmTools,
      dispatchTool: async (name, input) => {
        // 安全邊界：只放行 availableFor 清單內的工具（映回真實 id），LLM 幻想出別的名字一律擋下
        const realId = idByLlmName.get(name);
        if (!realId) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const tool = toolRegistry.resolve(realId, ctx);
          if (isWriteTool(tool)) {
            // 寫入只提議：先跑與 invoke 相同的權限與輸入驗證，通過才建卡片，不執行
            toolRegistry.assertInvocable(realId, input, ctx);
            if (proposedThisTurn) {
              // 一輪只能有一張確認卡片：後者不可悄悄覆蓋前者
              return JSON.stringify({ ok: false, error: '一次只能提議一個寫入動作，請先讓使用者確認上一筆，再提出下一筆。' });
            }
            proposedThisTurn = true;
            const action = createPendingAction(tool, input);
            session.pendingAction = action;
            return JSON.stringify({
              ok: true,
              proposed: true,
              card: action.summary,
              note: '已建立確認卡片，尚未執行。請向使用者簡述將執行的內容並請他確認；切勿宣稱已完成。',
            });
          }
          const result = await toolRegistry.invoke(realId, input, ctx);
          return JSON.stringify({ ok: true, result });
        } catch (err) {
          // 工具錯誤（權限/驗證/連接器/MCP）回傳給 LLM 自行修正，不中斷整輪
          return JSON.stringify({ ok: false, error: (err as Error).message });
        }
      },
    });

    logger.info({ sessionId: session.id, toolCount: llmTools.length }, 'agent turn complete');
    return {
      reply,
      ...(session.pendingAction ? { pendingAction: toPendingActionView(session.pendingAction) } : {}),
    };
  },
};
