/**
 * Agent 服務：處理「跨多個工具、多步驟」的開放式任務。
 *
 * 與 Form/Knowledge 走固定劇本不同，Agent 把「該使用者有權限、且允許暴露給 Agent」的工具
 * （toolRegistry.availableFor）交給 LLM 自選，靠共用 tool-loop 多輪往返完成任務。
 * 安全：dispatchTool 只放行 availableFor 清單內的工具；LLM 即使幻想出別的工具名也呼叫不到
 * （送單等寫入動作因此不會被 Agent 觸發）。工具錯誤回傳為 tool_result，讓 LLM 自行修正而非中斷整輪。
 * sticky=true 依藍圖設定；目前 router 的點黏閘以 form 狀態為條件，唯讀 Agent 尚不觸發（見 plan 註）。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { languageDirective } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { runToolLoop } from './tool-loop';

function buildSystemPrompt(locale?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你是公司 OA 系統的智慧代理，協助使用者完成需要操作公司系統的任務。${languageDirective(locale)}`,
    `今天日期是 ${today}；請把相對日期（明天、下週一等）換算成 YYYY-MM-DD。`,
    '工作方式：',
    '- 只能使用提供給你的工具；沒有合適工具時，據實說明目前無法完成，不要捏造結果或假裝已完成。',
    '- 需要時可連續呼叫多個工具，依回傳結果決定下一步，完成後用簡潔中文回覆使用者。',
    '- 工具回傳錯誤時，向使用者說明狀況或改用其他方式，不要重複無效呼叫。',
    '- 只處理與公司 OA 相關的任務；與公司無關的一般問題請禮貌婉拒。',
  ].join('\n');
}

export const agentAgentService: AgentService = {
  id: 'agent',
  label: '智慧代理',
  sticky: true,

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'agent.task',
        keywords: [],
        description:
          '需要一次操作多個公司系統/工具、且多步驟才能完成的複合任務（例如同時查詢並彙整多項資料）',
      },
    ];
  },

  async handleTurn(session: Session, _userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const ctx = makeToolContext({
      tenantId: session.tenantId,
      userId: session.userId,
      locale: session.locale,
    });
    const tools = toolRegistry.availableFor(ctx);
    const allowed = new Set(tools.map((t) => t.name));

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.locale),
      tools,
      dispatchTool: async (name, input) => {
        // 安全邊界：只放行 availableFor 清單內的工具，LLM 幻想出別的名字一律擋下
        if (!allowed.has(name)) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const result = await toolRegistry.invoke(name, input, ctx);
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
