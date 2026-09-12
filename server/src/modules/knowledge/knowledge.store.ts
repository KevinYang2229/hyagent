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
  /** 網站來源的可見性標籤（整個來源一組）；重爬時重新投影到 chunks */
  visibilityScopes?: string[];
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
  format?: 'txt' | 'md' | 'html' | 'docx' | 'doc' | 'pdf' | 'xlsx';
  /**
   * 結構保真度：structured = 標題/表格已保留；text = 僅純文字。
   * text 者（doc/pdf）檢索準確度較低，admin 據此提示使用者改上傳 docx。
   */
  fidelity?: 'structured' | 'text';
  /** 可見性標籤（kb:<labelId>）真相來源；未設＝未標記，fail-closed 下不可見 */
  visibilityScopes?: string[];
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
  /** Authorization fingerprint for each generated (public) prompt. */
  generatedPromptAcl?: Partial<Record<'website' | 'file', string>>;
  /**
   * 各來源的 chunk 數。widget config 是免登入端點，不該為了算數量去讀整份索引檔，
   * 故在索引寫入時一併記下。舊 meta 無此欄，讀取端需自備退路。
   */
  chunkCountBySource?: Record<SourceKey, number>;
}

/** 索引 meta 的衍生欄位 patch；files 陣列本身走專屬的 delta 操作（見 addFileMeta / removeFileMeta），不走這裡 */
export type KnowledgeMetaPatch = Partial<Omit<KnowledgeIndexMeta, 'files'>>;

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

/** undefined 欄位序列化剔除（與 file 後端同語意）；db 後端所有寫入路徑共用 */
function toJson<T>(v: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/**
 * db 後端：定向 upsert 單一租戶。
 * source 與 meta 兩個欄位分開寫——setMeta 不該覆蓋 saveSource 的內容，反之亦然。
 */
function upsertToDb(tenantId: string, patch: { source?: KnowledgeSource; meta?: KnowledgeIndexMeta }): void {
  const json = toJson;
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

/** meta 的預設空狀態；DB 的 jsonb 欄位預設 '{}'，與「未設定」同義 */
const EMPTY_META: KnowledgeIndexMeta = { status: 'none', chunkCount: 0 };

/**
 * db 後端的 files delta 寫入：在 writeQueue 的 task 內部重新 findUnique 讀回該租戶「當下」
 * 的 meta，把 delta 套用在 DB 的最新值上（而非呼叫端手上的記憶體快照），再寫回、並同步記憶體 Map。
 *
 * 這是修正跨 process lost update 的關鍵：watcher CLI 與 server 是兩個 process，各自的記憶體
 * 快照只在啟動時同步一次；若沿用記憶體快照做 files 增減再整包寫回，會把「另一個 process 這段
 * 期間新增/刪除的檔案」蓋掉。寫入佇列本身是序列的（enqueue 內的 task 依序執行），同一 process
 * 內排隊的多次呼叫不會互相競爭，故此處不需要額外的鎖。
 */
function enqueueFilesDelta(tenantId: string, applyFilesDelta: (base: KnowledgeIndexMeta) => KnowledgeIndexMeta): void {
  writeQueue.enqueue(async (db) => {
    const row = await db.knowledgeSourceRow.findUnique({ where: { tenantId } });
    const dbMeta = row?.meta as unknown as KnowledgeIndexMeta | undefined;
    const base = dbMeta && Object.keys(dbMeta).length ? dbMeta : EMPTY_META;
    const merged = applyFilesDelta(base);
    await db.knowledgeSourceRow.upsert({
      where: { tenantId },
      create: { tenantId, source: {}, meta: toJson(merged) },
      update: { meta: toJson(merged) },
    });
    metas.set(tenantId, merged);
  });
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

  /**
   * 新增一筆檔案 meta（delta 操作，取代「整包覆蓋」的 setMeta({ files: [...] })）。
   *
   * files 陣列的增減走「本次異動要套用在誰身上」的 delta 語意；patch 內其餘欄位
   * （status/chunkCount/generatedAt/model/chunkCountBySource 等）維持 last-writer-wins，
   * 直接採用呼叫端傳入的值——這些是顯示用衍生欄位，下一次任何索引異動就會自我修正。
   *
   * - file 後端：單一 process 寫檔，無跨 process 競態，直接對記憶體 Map 做 delta 即可。
   * - db 後端：先同步更新記憶體 Map（讓同 process 內緊接著的 getMeta，例如批次匯入判斷
   *   下一筆同名檔，能立即看到本次異動），再另外排入寫入佇列，於佇列 task 內部重讀 DB
   *   最新值做 delta 合併，避免跨 process 的 lost update（見 enqueueFilesDelta 註解）。
   */
  addFileMeta(tenantId: string, file: KnowledgeFileMeta, patch: KnowledgeMetaPatch): void {
    const current = metas.get(tenantId) ?? EMPTY_META;
    const merged: KnowledgeIndexMeta = { ...current, ...patch, files: [...(current.files ?? []), file] };
    metas.set(tenantId, merged);

    if (env.DATA_BACKEND !== 'db') {
      persist();
      return;
    }
    enqueueFilesDelta(tenantId, (base) => ({ ...base, ...patch, files: [...(base.files ?? []), file] }));
  },

  /** 移除指定 fileId 的檔案 meta（delta 操作）；語意與 addFileMeta 對稱，見其註解 */
  removeFileMeta(tenantId: string, fileId: string, patch: KnowledgeMetaPatch): void {
    const current = metas.get(tenantId) ?? EMPTY_META;
    const merged: KnowledgeIndexMeta = {
      ...current,
      ...patch,
      files: (current.files ?? []).filter((f) => f.fileId !== fileId),
    };
    metas.set(tenantId, merged);

    if (env.DATA_BACKEND !== 'db') {
      persist();
      return;
    }
    enqueueFilesDelta(tenantId, (base) => ({
      ...base,
      ...patch,
      files: (base.files ?? []).filter((f) => f.fileId !== fileId),
    }));
  },
};
