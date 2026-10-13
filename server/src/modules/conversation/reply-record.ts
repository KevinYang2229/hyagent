/**
 * 可評價的回覆紀錄。replyId 由伺服器發、問答由伺服器記：評價 API 只收 replyId，
 * 後台看到的一定是 AI 真正說過的話（前台送不進任意文字）。
 * 只留最近 MAX_REPLY_RECORDS 則：session 以 JSON 整包存放，trace 含片段節錄，要控制大小。
 */
import { randomUUID } from 'node:crypto';
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';
import type { ReplyRecord, ReplyTrace, ReplyTraceChunk, Session } from './conversation.types';

export const MAX_REPLY_RECORDS = 20;
export const TRACE_EXCERPT_CHARS = 300;

export function recordReply(
  session: Session,
  input: { question: string; answer: string; serviceId: string; trace?: ReplyTrace },
): ReplyRecord {
  const record: ReplyRecord = {
    id: randomUUID(),
    question: input.question,
    answer: input.answer,
    serviceId: input.serviceId,
    at: new Date().toISOString(),
    ...(input.trace ? { trace: input.trace } : {}),
  };
  session.replies = [...(session.replies ?? []), record].slice(-MAX_REPLY_RECORDS);
  return record;
}

export function findReply(session: Session, replyId: string): ReplyRecord | undefined {
  return session.replies?.find((r) => r.id === replyId);
}

/** 檢索片段 → trace：留節錄而非只留 id，文件事後被改掉或刪除仍能判斷模型當時看到什麼 */
export function traceChunks(chunks: KnowledgeChunk[]): ReplyTraceChunk[] {
  return chunks.map((c, i) => ({
    rank: i + 1,
    id: c.id,
    title: c.title,
    ...(c.url ? { url: c.url } : {}),
    ...(c.score !== undefined ? { score: c.score } : {}),
    excerpt: c.content.slice(0, TRACE_EXCERPT_CHARS),
  }));
}
