/**
 * 知識檢索器介面（可插拔，對齊 lib/oa 的 stub/http 模式）。
 *
 * 本輪只有 stub 實作；之後接 pgvector + embedding 的真 RAG 時，
 * 新增 retriever.pgvector.ts 實作同介面即可，不動 KnowledgeAgentService。
 */
export interface KnowledgeChunk {
  id: string;
  title: string;
  content: string;
  /** 來源網址（靜態網站索引用，供作答附引用）；stub 無來源時省略 */
  url?: string;
  /** 檢索分數（越大越相關）；stub 為關鍵字命中數，靜態索引為向量餘弦相似度 */
  score?: number;
}

/**
 * 檢索身分。刻意不含 scopes——權限由檢索器內部經 resolveScopes 算出，
 * 呼叫端無從捏造（傳錯的、傳成別人的、圖方便傳萬用值的，全都編譯得過）。
 */
export interface RetrievalPrincipal {
  tenantId: string;
  userId: string;
}

export interface KnowledgeRetriever {
  readonly name: string;
  search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]>;
}
