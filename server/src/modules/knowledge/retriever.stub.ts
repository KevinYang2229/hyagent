/**
 * Stub 檢索器：極簡靜態 FAQ + 中文關鍵詞比對。
 *
 * 僅供驗證「可插拔服務 + Router」流程跑通；真 RAG（chunk/embed/pgvector）為後續 iteration。
 */
import type { KnowledgeChunk, KnowledgeRetriever, RetrievalPrincipal } from './retriever.types';

const FAQ: KnowledgeChunk[] = [
  {
    id: 'leave-annual',
    title: '特休天數規定',
    content: '特休依到職年資計算：滿半年給 3 日、滿一年給 7 日，其後逐年遞增，上限 30 日。',
  },
  {
    id: 'leave-sick',
    title: '病假規定',
    content: '普通傷病假一年以 30 日為限，未住院者超過部分併入事假或留職停薪處理。',
  },
  {
    id: 'trip-domestic',
    title: '國內出差報銷規定',
    content: '國內出差需檢附發票與行程表，交通、住宿與膳雜費依核准標準覈實報銷。',
  },
];

// 每則 FAQ 的比對詞（stub 用；真 RAG 由 embedding 取代）
const KEYWORDS: Record<string, string[]> = {
  'leave-annual': ['特休', '年資', '天數', '幾天', '休假天數'],
  'leave-sick': ['病假', '生病', '傷病'],
  'trip-domestic': ['出差', '報銷', '差旅', '住宿', '交通費'],
};

function hitScore(chunk: KnowledgeChunk, query: string): number {
  const terms = KEYWORDS[chunk.id] ?? [];
  return terms.reduce((n, t) => (query.includes(t) ? n + 1 : n), 0);
}

export const stubRetriever: KnowledgeRetriever = {
  name: 'stub',
  /**
   * stub 為固定 FAQ（dev/測試路徑），**全部視為公開**、不套用可見性過濾。
   * 這是明確決定而非遺漏：stub 內容不含任何租戶資料。
   */
  async search(_principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]> {
    const q = query.trim();
    if (!q) return [];
    return FAQ.map((c) => ({ ...c, score: hitScore(c, q) }))
      .filter((c) => (c.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3);
  },
};
