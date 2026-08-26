/**
 * 知識庫檔案來源：上傳檔解析成文字，沿用 chunk/embedding 管線附加進租戶索引（chunk 標 fileId）。
 * 與網站來源並存：網站重爬經 carryOverFileChunks（定義於 ingest.service）保留檔案 chunks；刪檔只移除該檔 chunks。
 * 不保存原始檔（重傳即更新）。
 */
import { randomUUID } from 'node:crypto';
import { getEmbeddingProvider } from '@/lib/embedding';
import { getLLMProvider } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import {
  appendChunks,
  countChunksBySource,
  loadIndex,
  loadIndexMeta,
  loadIndexText,
  removeFileChunks,
} from './knowledge.index.repo';
// carryOverFileChunks 從 ingest.service 匯入（而非本檔自行定義），維持單向依賴：
// 本檔已需要 ingest.service 的 chunkText/squash，若 ingest.service 反過來 import 本檔會形成循環引用。
import {
  carryOverFileChunks,
  chunkMarkdown,
  embedInBatches,
  normalizeDocText,
  squash,
} from './ingest.service';
import { parseDocument } from './doc-parse';
import { deleteTablesByFile, saveTables, tableDescriptor } from './knowledge.tables.repo';
import type { IndexedChunk } from './knowledge-index.types';
import { knowledgeStore, type KnowledgeFileMeta } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';

export type { KnowledgeFileMeta };
export { carryOverFileChunks };

export interface IngestFileOptions {
  /**
   * true 時跳過結尾的推薦問句重生觸發。
   *
   * 批次匯入專用：`refreshSuggestedPrompts` 每次都會打 LLM，而它的世代編號機制會讓
   * 早發動的呼叫放棄寫入——N 個檔連續匯入等於白花 N-1 次呼叫。改由批次跑完統一觸發一次。
   */
  deferSuggestions?: boolean;
  /**
   * 匯入時的可見性標籤（kb:<labelId>）；未帶＝未標記，fail-closed 下對所有人不可見。
   *
   * 真相來源（KnowledgeFileMeta.visibilityScopes）與投影（每個 chunk 的 visibilityScopes）
   * 都要寫，兩者缺一就是 bug：admin 檔案清單認真相來源做批次標籤操作，
   * 檢索時 retriever 直接讀 chunk 上的投影，不會回頭查 meta。
   */
  visibilityScopes?: string[];
}

const MIN_TEXT_CHARS = 20;

/** 摘要輸入上限：超長文件截前段即可（摘要只求鳥瞰，兼顧 token 成本） */
const SUMMARY_MAX_INPUT_CHARS = 24000;

/**
 * 全文摘要 chunk：入庫時先「消化一次」，讓籠統問題（這份文件在講什麼）有可命中的候選。
 * 只是多一個檢索候選、不取代原文 chunks；失敗一律回 null，匯入照常進行。
 */
async function summarizeText(tenantId: string, name: string, text: string): Promise<string | null> {
  try {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
      system: [
        '你是文件摘要員。將使用者提供的文件濃縮成 150~250 字的繁體中文摘要。',
        '只能濃縮原文內容，嚴禁補充原文沒有的資訊；專有名詞、代號、網址保留原文寫法。',
        '直接輸出摘要文字，不要任何前後綴或條列符號。',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `文件名稱：${name}\n\n${text.slice(0, SUMMARY_MAX_INPUT_CHARS)}` }],
        },
      ],
      maxTokens: 512,
      model: env.LLM_ROUTER_MODEL, // 摘要屬輔助任務，用便宜模型即可（同意圖分類器）
    });
    usageStore.recordLLMUsage(tenantId, result); // 摘要呼叫此前漏記用量，一併補上
    const summary = squash(result.text ?? '');
    return summary.length >= MIN_TEXT_CHARS ? summary : null;
  } catch (err) {
    logger.warn({ err, name }, 'file summary generation failed; ingest continues without summary');
    return null;
  }
}

/** 只要文字的呼叫端用這個；格式判定與各格式解析見 doc-parse。 */
export async function parseFileToText(name: string, buf: Buffer): Promise<string> {
  return (await parseDocument(name, buf)).text;
}

/** 直讀索引（不經 retriever 的記憶體快取）；無索引回 null */
export const loadIndexFile = loadIndex;

/** 上傳檔 ingest：解析→切塊→embed→附加索引→meta.files。解析成功前不動索引/meta。 */
export async function ingestFile(
  tenantId: string,
  name: string,
  buf: Buffer,
  opts?: IngestFileOptions,
): Promise<KnowledgeFileMeta> {
  const parsed = await parseDocument(name, buf);
  // normalizeDocText（而非 squash）：保留段落與 Markdown 標題行，切塊才切得到語意邊界
  const text = normalizeDocText(parsed.text);
  if (text.length < MIN_TEXT_CHARS) {
    throw AppError.unprocessable('無可抽取文字（可能為掃描檔或空檔）');
  }
  const source = knowledgeStore.getSource(tenantId);
  const pieces = chunkMarkdown(text, source.chunkChars);

  // 單一 chunk 就是全文本身，摘要無增益；多 chunk 才值得花一次 LLM 呼叫
  const summary = pieces.length >= 2 ? await summarizeText(tenantId, name, text) : null;
  const toEmbed = summary ? [...pieces, summary] : pieces;

  // loadIndexMeta 而非 loadIndex：這裡只要 model/source 兩個字串，它們在 knowledge_indexes
  // 的單列上。原本走整份載入等於為了兩個字串把該租戶所有向量拖過網路（每筆約 27KB），
  // chunks 上千之後必然撞 Postgres 的 statement timeout（57014），且每匯入一個檔重演一次。
  const existing = await loadIndexMeta(tenantId);
  // 模型一致性：同一份索引只能用同一個 embedding 模型
  const model = existing?.model ?? source.embeddingModel;
  const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
  // 必須分批：整份文件一次送出會撞 embeddings 端點的 300k tokens/request 上限（400 Invalid 'input'）
  const vectors = await embedInBatches(embedder, toEmbed, model, (tokens) => {
    usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
  });

  const fileId = randomUUID();
  const scopes = opts?.visibilityScopes;
  const fileChunks: IndexedChunk[] = pieces.map((t, i) => ({
    id: `${fileId}-${i}`,
    url: `file://${name}`,
    title: name,
    text: t,
    vector: vectors[i],
    fileId,
    ...(scopes ? { visibilityScopes: scopes } : {}),
  }));
  if (summary) {
    // 標明「全文摘要」讓回答模型知道這是衍生內容，細節仍以原文 chunks 為準
    fileChunks.push({
      id: `${fileId}-summary`,
      url: `file://${name}`,
      title: `${name}（全文摘要）`,
      text: summary,
      vector: vectors[pieces.length],
      fileId,
      ...(scopes ? { visibilityScopes: scopes } : {}),
    });
  }

  /*
   * 結構化表與 chunks 並存：chunks 回答「這在講什麼」，表回答「數字是多少」。
   * 失敗不得中斷匯入——沒有表只是報告畫不了精確圖，而 chunks 已經付過 embedding 的錢。
   */
  if (parsed.tables?.length) {
    try {
      /*
       * 表的描述句也 embed 一份，供報告依語意挑表。與 chunks 分開：
       * chunks 是「內容」的向量，這裡是「這張表在講什麼」的向量，用途與粒度都不同。
       * embedding 失敗不阻斷——沒有向量只是選表退回字面比對。
       */
      let tableVectors: number[][] | undefined;
      try {
        tableVectors = await embedInBatches(
          embedder,
          parsed.tables.map((t) => tableDescriptor({ ...t, source: name })),
          model,
          (tokens) => usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource),
        );
      } catch (err) {
        logger.warn({ err, tenantId, name }, '資料表描述 embedding 失敗，選表將退回字面比對');
      }
      const n = await saveTables(tenantId, fileId, name, parsed.tables, tableVectors);
      logger.info({ tenantId, name, tables: parsed.tables.length, rows: n }, '結構化表已留存');
    } catch (err) {
      logger.warn({ err, tenantId, name }, '結構化表留存失敗，匯入照常完成（報告將無法畫精確圖）');
    }
  }

  // 點狀附加：只寫本檔的 chunks，不重寫整份索引（見 knowledge.index.repo 的 appendChunks 註解）
  await appendChunks(tenantId, fileChunks, {
    model,
    source: existing?.source ?? `file://${name}`,
  });

  // 計數在 DB 端聚合，不搬任何列回來。原本是「既有快照 + 本次新增」就地拼出，除了要先
  // 付一次全量載入的代價，併發匯入時還會短暫偏低；寫入後直接 count 既便宜又是權威值。
  const counts = await countChunksBySource(tenantId);
  const generatedAt = new Date().toISOString();

  const fileMeta: KnowledgeFileMeta = {
    fileId,
    name,
    chunks: fileChunks.length,
    ingestedAt: generatedAt,
    format: parsed.format,
    fidelity: parsed.fidelity,
    ...(scopes ? { visibilityScopes: scopes } : {}),
  };
  // files 走 delta 操作（而非整包覆蓋的 setMeta）：watcher CLI 與 server 是兩個 process，
  // 各自的記憶體快照只在啟動時同步一次，整包覆蓋會把另一個 process 期間新增的檔案蓋掉
  // （db 後端見 knowledge.store.ts 的 addFileMeta／enqueueFilesDelta 註解）。
  knowledgeStore.addFileMeta(tenantId, fileMeta, {
    status: 'ready',
    chunkCount: counts.website + counts.file,
    generatedAt,
    model,
    chunkCountBySource: counts,
  });

  if (!opts?.deferSuggestions) {
    // 推薦問句只吃文字，用 loadIndexText 讀（不含向量）；而且只在真的要重生時才讀，
    // 批次匯入帶 deferSuggestions 時這一整段連碰都不會碰到
    void loadIndexText(tenantId)
      .then((idx) => (idx ? refreshSuggestedPrompts(tenantId, idx) : undefined))
      .catch(() => {});
  }
  return fileMeta;
}

export interface RemoveFileOptions {
  /**
   * true 時跳過推薦問句重生觸發。
   *
   * 批次匯入「同名檔視為更新」會先 removeFile 舊檔再 ingestFile 新檔；removeFile 若無條件
   * 觸發 refreshSuggestedPrompts，重丟 N 個同名改版檔就等於白花 N 次 LLM 呼叫（世代編號防護
   * 只讓最後一次生效），與 ingestFile 的 deferSuggestions 想省下的浪費是同一件事。
   */
  deferSuggestions?: boolean;
}

/** 刪除已上傳檔案：索引剔除該 fileId 的 chunks + meta 移除；查無回 false。 */
export async function removeFile(
  tenantId: string,
  fileId: string,
  opts?: RemoveFileOptions,
): Promise<boolean> {
  const meta = knowledgeStore.getMeta(tenantId);
  if (!meta.files?.some((f) => f.fileId === fileId)) return false;

  // 實際刪除走點狀 SQL，不把整份索引寫回去
  const removed = await removeFileChunks(tenantId, fileId);
  // 結構化表與 chunks 同生命週期：留著會讓報告引用到已刪除檔案的數字
  await deleteTablesByFile(tenantId, fileId).catch((err: unknown) => {
    logger.warn({ err, tenantId, fileId }, '結構化表刪除失敗，可能殘留');
  });

  // files 走 delta 操作（而非整包覆蓋的 setMeta）：理由同 ingestFile 的 addFileMeta，
  // 見 knowledge.store.ts 的 removeFileMeta／enqueueFilesDelta 註解。
  // 計數改為刪除後直接在 DB 聚合，不必為了算數字先把整份索引（含向量）載回來。
  if (removed) {
    const counts = await countChunksBySource(tenantId);
    knowledgeStore.removeFileMeta(tenantId, fileId, {
      chunkCount: counts.website + counts.file,
      chunkCountBySource: counts,
    });
    if (!opts?.deferSuggestions) {
      // 只讀文字版索引：推薦問句用不到向量
      void loadIndexText(tenantId)
        .then((idx) => (idx ? refreshSuggestedPrompts(tenantId, idx) : undefined))
        .catch(() => {});
    }
  } else {
    knowledgeStore.removeFileMeta(tenantId, fileId, {});
  }
  return true;
}
