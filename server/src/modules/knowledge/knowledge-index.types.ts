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
  /**
   * 可見性標籤（kb:<labelId>）。真相來源在檔案 meta／來源設定，本欄為查詢投影。
   * undefined 寫入為 NULL＝從未標記；[] ＝明確標成誰都不能看。
   */
  visibilityScopes?: string[];
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

/** 索引層級 metadata，不含 chunks（db 後端只讀 knowledge_indexes 的單列） */
export type KnowledgeIndexMetaOnly = Omit<KnowledgeIndexFile, 'chunks'>;

/**
 * 不含向量的 chunk。
 *
 * 向量以文字字面值往返時每筆約 27KB，而推薦問句、計數這些路徑一個位元組都用不到——
 * 6k 個 chunk 就是 170MB 白搬，Supabase 的 statement timeout 會直接砍掉查詢（57014）。
 * 用型別把「這條路徑拿不到向量」講明白，比註解可靠。
 */
export type ChunkText = Omit<IndexedChunk, 'vector'>;

/** 不含向量的整份索引；KnowledgeIndexFile 可直接指派給它（多的 vector 欄無妨） */
export interface KnowledgeIndexText extends KnowledgeIndexMetaOnly {
  chunks: ChunkText[];
}

/**
 * 全文摘要 chunk 的 id 後綴（`<fileId>-summary`）。
 *
 * 由 knowledge-file.service 產生、由 knowledge.suggest 辨識。常數放在型別模組是因為
 * knowledge-file.service 已經 import knowledge.suggest，反向 import 會成為循環相依。
 */
export const SUMMARY_CHUNK_ID_SUFFIX = '-summary';

/** 判斷某 chunk 是否為入庫時產生的全文摘要（而非原文片段） */
export function isSummaryChunk(chunk: { id: string }): boolean {
  return chunk.id.endsWith(SUMMARY_CHUNK_ID_SUFFIX);
}
