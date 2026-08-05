/**
 * 依持久化後端挑檢索器。所有「要拿知識庫檢索結果」的呼叫端都必須走這裡。
 *
 * 抽成共用模組是因為漏掉任何一個呼叫端都不會噴錯，只會靜默回 0 命中：
 * 在 db 模式下寫死 staticIndexRetriever 會走到 existsSync(索引檔) → false → 快取 null → []，
 * 看起來就像「知識庫真的查不到東西」。admin 的測試查詢正是操作者用來驗證遷移成功的工具，
 * 這種靜默錯誤會在切換當下主動誤導人。
 *
 * 相依方向固定為「呼叫端 → 本模組 → 各 retriever」；本模組不得反向 import 任何
 * controller / service，避免製造循環引用。
 */
import { env } from '@/config/env';
import { hasPgvectorIndex, pgvectorRetriever } from './retriever.pgvector';
import { hasStaticIndex, staticIndexRetriever } from './retriever.staticIndex';
import { stubRetriever } from './retriever.stub';
import type { KnowledgeRetriever } from './retriever.types';

/**
 * db 走 pgvector、file 走靜態索引檔；兩者都沒有索引時退回 stub FAQ（dev/測試）。
 */
export async function pickRetriever(tenantId: string): Promise<KnowledgeRetriever> {
  if (env.DATA_BACKEND === 'db') {
    return (await hasPgvectorIndex(tenantId)) ? pgvectorRetriever : stubRetriever;
  }
  return hasStaticIndex(tenantId) ? staticIndexRetriever : stubRetriever;
}
