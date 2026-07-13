/**
 * 靜態向量索引檔格式（由 scripts/knowledge-ingest.ts 產生，retriever.staticIndex 讀取）。
 */
export interface IndexedChunk {
  id: string;
  url: string;
  title: string;
  text: string;
  /** 該 chunk 的 embedding 向量 */
  vector: number[];
  /** 檔案來源的 chunk：來源檔 id（網站爬取的 chunk 無此欄）。刪檔/重爬保留據此篩選 */
  fileId?: string;
}

export interface KnowledgeIndexFile {
  /** 產生時間（ISO） */
  generatedAt: string;
  /** 產生索引所用的 embedding 模型；查詢端需一致才可比對 */
  model: string;
  /** 爬取起點，供追溯 */
  source: string;
  chunks: IndexedChunk[];
}
