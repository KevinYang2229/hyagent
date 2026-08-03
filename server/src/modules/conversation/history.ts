/**
 * 對話歷史取用：以「訊息數窗口 + 單則長度上限」取最近的逐字稿。
 *
 * session.messages 隨對話無上限成長。需要脈絡的一方一律從這裡取窗口，讓送進 LLM 的
 * input 大小恆定——「上下文太長」不該變成「請使用者重開對話」，那是把實作限制轉嫁給使用者。
 */
import type { LLMMessage } from '@/lib/llm/types';
import type { Session } from './conversation.types';

/** 單則訊息帶入脈絡時的字元上限；超過截斷（脈絡只需辨識談過什麼，不需全文） */
const MESSAGE_CHARS = 400;

/** 取訊息的純文字；tool_use / tool_result 區塊不屬於對話語意，略過 */
export function messageText(message: LLMMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * 本輪之前的最近 maxMessages 則訊息。
 * runTurn 會先把本輪使用者訊息推入 session.messages，故一律排除最後一則。
 */
export function priorMessages(session: Session, maxMessages: number): LLMMessage[] {
  return session.messages.slice(0, -1).slice(-maxMessages);
}

/**
 * 逐字稿文字形式。刻意不還原成 messages 陣列：歷史裡可能含 tool_use / tool_result 區塊，
 * 在沒有對應 tools 定義的呼叫中送出會被 provider 拒絕；轉成文字可一併濾掉這類雜訊。
 */
export function transcriptOf(messages: LLMMessage[]): string {
  return messages
    .map((m) => {
      const text = messageText(m);
      if (!text) return '';
      const body = text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text;
      return `${m.role === 'user' ? '使用者' : '助理'}：${body}`;
    })
    .filter(Boolean)
    .join('\n');
}
