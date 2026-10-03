/**
 * 已確認動作的執行與取消（不經 LLM）。
 *
 * 一律以「當下」重新解析的權限執行：提議到確認之間權限可能已被撤銷。
 * 呼叫端必須在呼叫前清除 session.pendingAction（確認是一次性的，雙擊或重送不得執行第二次）。
 */
import { logger } from '@/lib/logger';
import { makeToolContext, toolRegistry, unwrapToolOutput } from '@/modules/tools';
import { AppError } from '@/utils/app-error';
import type { Session } from './conversation.types';
import type { PendingAction } from './pending-action';

export type ExecuteOutcome =
  | { ok: true; reply: string; result: unknown }
  | { ok: false; reply: string; code: 'FORBIDDEN' | 'FAILED' };

const RESULT_NOTE_MAX_CHARS = 500;

function resultNote(result: unknown): string {
  if (result === undefined) return '';
  // 絕不可丟例外：此時工具已執行成功，摘要失敗不得讓成功變成「失敗」而誘使使用者重試
  let s: string | undefined;
  try {
    s = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return '';
  }
  if (s === undefined) return '';
  return `\n（執行結果：${s.length > RESULT_NOTE_MAX_CHARS ? `${s.slice(0, RESULT_NOTE_MAX_CHARS)}…` : s}）`;
}

export async function runConfirmedAction(session: Session, action: PendingAction): Promise<ExecuteOutcome> {
  const ctx = makeToolContext({ tenantId: session.tenantId, userId: session.userId, locale: session.locale });
  const title = action.summary.title;
  let outcome: ExecuteOutcome;
  let transcript: string;
  try {
    // 動態來源（MCP）的工具要先備妥快取，否則 resolve 不到
    await toolRegistry.prepare(ctx);
    const { data: result } = unwrapToolOutput(await toolRegistry.invoke(action.toolId, action.input, ctx));
    outcome = { ok: true, reply: `已完成「${title}」。`, result };
    // 逐字稿附上結果摘要，讓後續對話（如「剛才的預約編號是多少」）有上下文；使用者看到的回覆維持簡潔
    transcript = outcome.reply + resultNote(result);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof AppError && err.statusCode === 403) {
      outcome = { ok: false, code: 'FORBIDDEN', reply: `無法執行「${title}」：你目前沒有此操作的權限。` };
    } else if (message.startsWith('unknown tool:')) {
      outcome = { ok: false, code: 'FAILED', reply: `無法執行「${title}」：相關服務目前無法使用，請稍後再試。` };
    } else {
      outcome = { ok: false, code: 'FAILED', reply: `執行「${title}」失敗：${message}` };
    }
    transcript = outcome.reply;
    logger.warn({ err, sessionId: session.id, toolId: action.toolId }, 'confirmed action failed');
  }
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: transcript }] });
  return outcome;
}

export function cancelPendingAction(session: Session): string {
  const action = session.pendingAction;
  session.pendingAction = undefined;
  const reply = action ? `已取消「${action.summary.title}」。` : '目前沒有待確認的動作。';
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  return reply;
}
