/**
 * 每租戶知識來源設定（KnowledgeSource）與索引 meta（KnowledgeIndexMeta）的記憶體＋磁碟持久化 store。
 * 結構與 tenant.store 相同：啟動時從 JSON 還原，每次異動立即寫回。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { normalizeSuggestedPrompts, type SourceKey, type SuggestedPromptSlots } from './prompt-slots';

/** 每租戶的網站爬取與 embedding 設定 */
export interface KnowledgeSource {
  /** 爬取起點 URL */
  startUrl: string;
  /** 最大爬取頁數 */
  maxPages: number;
  /** 只爬取此路徑前綴（選填） */
  pathPrefix?: string;
  /** 包含的 URL pattern（選填） */
  includePatterns?: string[];
  /** 排除的 URL pattern（選填） */
  excludePatterns?: string[];
  /** 每個 chunk 的字元數 */
  chunkChars: number;
  /** embedding 模型名稱 */
  embeddingModel: string;
  /** 是否啟用 rerank 兩階段檢索 */
  rerank: boolean;
  /** 最後更新時間（ISO 8601） */
  updatedAt?: string;
}

/** 單一上傳檔案的索引紀錄（供 admin 顯示與刪除比對） */
export interface KnowledgeFileMeta {
  /** 檔案唯一 id（同時是索引中該檔案 chunks 的 fileId） */
  fileId: string;
  /** 原始檔名 */
  name: string;
  /** 該檔切出的 chunk 數 */
  chunks: number;
  /** ingest 完成時間（ISO 8601） */
  ingestedAt: string;
  /** 實際解析採用的格式（依 magic bytes 判定，未必等同副檔名）；舊紀錄無此欄 */
  format?: 'txt' | 'md' | 'html' | 'docx' | 'doc' | 'pdf';
  /**
   * 結構保真度：structured = 標題/表格已保留；text = 僅純文字。
   * text 者（doc/pdf）檢索準確度較低，admin 據此提示使用者改上傳 docx。
   */
  fidelity?: 'structured' | 'text';
}

/** 由 prompt-slots.ts 定義的型別，此處 re-export 供既有呼叫端沿用 */
export type { SuggestedPrompts, PromptSlot, SourceKey, SuggestedPromptSlots } from './prompt-slots';


/** 每租戶的向量索引狀態 */
export interface KnowledgeIndexMeta {
  /** 索引狀態：none（未建立）/ ready（可用）/ failed（建立失敗） */
  status: 'none' | 'ready' | 'failed';
  /** 索引中的 chunk 數 */
  chunkCount: number;
  /** 索引建立時間（ISO 8601） */
  generatedAt?: string;
  /** 所使用的 embedding 模型 */
  model?: string;
  /** 來源 URL */
  source?: string;
  /** 失敗原因（status=failed 時） */
  error?: string;
  /** 已上傳的檔案來源清單（與網站來源並存） */
  files?: KnowledgeFileMeta[];
  /**
   * 依索引內容生成的開場推薦問句，依來源分兩格（見 prompt-slots.ts）。
   * 有效句 = manual ?? generated；無內容時不存在，widget 即不顯示該顆 chip。
   */
  suggestedPrompts?: SuggestedPromptSlots;
  /**
   * 各來源的 chunk 數。widget config 是免登入端點，不該為了算數量去讀整份索引檔，
   * 故在索引寫入時一併記下。舊 meta 無此欄，讀取端需自備退路。
   */
  chunkCountBySource?: Record<SourceKey, number>;
}

/** 回傳預設來源設定（以 env 為基準） */
function defaultSource(): KnowledgeSource {
  return {
    startUrl: '',
    maxPages: 100,
    chunkChars: 800,
    embeddingModel: env.EMBEDDING_MODEL,
    rerank: env.KNOWLEDGE_RERANK,
  };
}

/** 持久化 JSON 路徑：存在 KNOWLEDGE_INDEX_DIR 下（file 後端） */
const FILE = resolve(process.cwd(), env.KNOWLEDGE_INDEX_DIR, 'knowledge-config.json');

/** 以租戶 ID 為 key 的來源設定 Map */
const sources = new Map<string, KnowledgeSource>();
/** 以租戶 ID 為 key 的索引 meta Map */
const metas = new Map<string, KnowledgeIndexMeta>();

const writeQueue = new DbWriteQueue('knowledge-sources');

/** 將目前 Map 狀態寫入磁碟 JSON（file 後端） */
function persist(): void {
  try {
    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(
      FILE,
      JSON.stringify({ sources: [...sources], metas: [...metas] }),
      'utf8',
    );
  } catch (err) {
    logger.warn({ err }, 'knowledge config persist failed');
  }
}

/**
 * db 後端：定向 upsert 單一租戶。
 * source 與 meta 兩個欄位分開寫——setMeta 不該覆蓋 saveSource 的內容，反之亦然。
 */
function upsertToDb(tenantId: string, patch: { source?: KnowledgeSource; meta?: KnowledgeIndexMeta }): void {
  // undefined 欄位序列化剔除（與 file 後端同語意）
  const json = <T,>(v: T): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  const create = {
    tenantId,
    source: patch.source ? json(patch.source) : {},
    meta: patch.meta ? json(patch.meta) : {},
  };
  const update = {
    ...(patch.source ? { source: json(patch.source) } : {}),
    ...(patch.meta ? { meta: json(patch.meta) } : {}),
  };
  writeQueue.enqueue(async (db) => {
    await db.knowledgeSourceRow.upsert({ where: { tenantId }, create, update });
  });
}

/** 依後端寫回（db 走佇列、file 寫檔） */
function save(tenantId: string, patch: { source?: KnowledgeSource; meta?: KnowledgeIndexMeta }): void {
  if (env.DATA_BACKEND === 'db') upsertToDb(tenantId, patch);
  else persist();
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as {
        sources: [string, KnowledgeSource][];
        metas: [string, KnowledgeIndexMeta][];
      };
      raw.sources?.forEach(([k, v]) => sources.set(k, v));
      raw.metas?.forEach(([k, v]) => metas.set(k, v));
    }
  } catch (err) {
    logger.warn({ err }, 'knowledge config restore failed');
  }
}

/**
 * db 後端的開機載入。必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 * jsonb 欄位預設 '{}'，空物件視同未設定，交由 getSource/getMeta 的預設值處理。
 */
export async function initKnowledgeStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.knowledgeSourceRow.findMany();
  for (const r of rows) {
    const src = r.source as unknown as KnowledgeSource;
    const meta = r.meta as unknown as KnowledgeIndexMeta;
    if (src && Object.keys(src).length) sources.set(r.tenantId, src);
    if (meta && Object.keys(meta).length) metas.set(r.tenantId, meta);
  }
  logger.info({ count: rows.length }, 'knowledge config restored from db');
}

export const knowledgeStore = {
  /** 取得租戶的知識來源設定；未設定時回預設值 */
  getSource(tenantId: string): KnowledgeSource {
    return sources.get(tenantId) ?? defaultSource();
  },

  /** 儲存租戶的知識來源設定，自動加上 updatedAt；回傳已儲存的物件 */
  saveSource(tenantId: string, src: Omit<KnowledgeSource, 'updatedAt'>): KnowledgeSource {
    const saved: KnowledgeSource = { ...src, updatedAt: new Date().toISOString() };
    sources.set(tenantId, saved);
    save(tenantId, { source: saved });
    return saved;
  },

  /** 取得租戶的索引 meta；未建立時回預設 none 狀態。舊格式的推薦問句於此就地正規化 */
  getMeta(tenantId: string): KnowledgeIndexMeta {
    const meta = metas.get(tenantId) ?? { status: 'none', chunkCount: 0 };
    const slots = normalizeSuggestedPrompts(meta.suggestedPrompts, {
      hasStartUrl: !!sources.get(tenantId)?.startUrl,
    });
    return slots ? { ...meta, suggestedPrompts: slots } : meta;
  },

  /** 更新租戶的索引 meta */
  setMeta(tenantId: string, meta: KnowledgeIndexMeta): void {
    metas.set(tenantId, meta);
    save(tenantId, { meta });
  },
};
