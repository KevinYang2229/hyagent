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
  appendChunksStreamed,
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
  embedBatchesStreamed,
  embedInBatches,
  normalizeDocText,
  squash,
} from './ingest.service';
import { parseDocument } from './doc-parse';
import { deleteTablesByFile, saveTables, tableDescriptor } from './knowledge.tables.repo';
import { SUMMARY_CHUNK_ID_SUFFIX, type IndexedChunk } from './knowledge-index.types';
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

/**
 * 單檔切塊數上限。
 *
 * 串流寫入之後峰值記憶體已與檔案大小脫鉤，這道閘擋的是另一件事：一個異常巨大的檔案
 * 會安靜地跑上幾十分鐘、付掉對應的 embedding 費用，使用者只看到轉圈。與其讓它跑，
 * 不如當場回 422 講清楚。實務參考值：正式環境最大的一份 xlsx 約 1,900 個 chunk。
 */
const MAX_FILE_CHUNKS = 20_000;

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
  if (pieces.length > MAX_FILE_CHUNKS) {
    throw AppError.unprocessable(
      `檔案切出 ${pieces.length} 個片段，超過單檔上限 ${MAX_FILE_CHUNKS}；請拆成多個檔案再匯入`,
    );
  }

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

  const fileId = randomUUID();
  const scopes = opts?.visibilityScopes;
  /** 以「在 toEmbed 中的位置」還原成 chunk；索引落在 pieces 之後的那一筆就是全文摘要 */
  const chunkAt = (i: number, vector: number[]): IndexedChunk =>
    i < pieces.length
      ? {
          id: `${fileId}-${i}`,
          url: `file://${name}`,
          title: name,
          text: pieces[i],
          vector,
          fileId,
          ...(scopes ? { visibilityScopes: scopes } : {}),
        }
      : {
          // 標明「全文摘要」讓回答模型知道這是衍生內容，細節仍以原文 chunks 為準
          id: `${fileId}${SUMMARY_CHUNK_ID_SUFFIX}`,
          url: `file://${name}`,
          title: `${name}（全文摘要）`,
          text: summary as string,
          vector,
          fileId,
          ...(scopes ? { visibilityScopes: scopes } : {}),
        };

  /*
   * 逐批 embed → 逐批寫入 → 釋放。峰值記憶體是 O(單批) 而非 O(整份檔案)。
   *
   * 分批 embed 本來就是必須的（整份一次送出會撞 embeddings 端點的 300k tokens/request
   * 上限），但舊寫法把每批結果累積成完整的 vectors 陣列才交給寫入層，等於自己把峰值
   * 拉回 O(整份檔案)：1200 個 chunk 的 xlsx 光向量與寫入字面值實測就要 330MB，容器
   * 記憶體一到頂 process 直接被 SIGKILL。那不是 500 錯誤——是連 catch 都執行不到的
   * 猝死，補償刪除失效、殘骸留在資料庫，瀏覽器端只看得到一個沒有 CORS 標頭的 502。
   */
  const chunkCount = await appendChunksStreamed(
    tenantId,
    (async function* () {
      for await (const { vectors, offset } of embedBatchesStreamed(
        embedder,
        toEmbed,
        model,
        (tokens) => usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource),
      )) {
        yield vectors.map((v, k) => chunkAt(offset + k, v));
      }
    })(),
    { model, source: existing?.source ?? `file://${name}` },
  );

  /*
   * 結構化表與 chunks 並存：chunks 回答「這在講什麼」，表回答「數字是多少」。
   * 失敗不得中斷匯入——沒有表只是報告畫不了精確圖，而 chunks 已經付過 embedding 的錢。
   *
   * 擺在 chunks 寫入**之後**：chunks 失敗會拋出，這裡就不會執行，也就不會留下
   * 「表在、chunks 不在」的孤兒表（表沒有 chunks 那套補償刪除）。
   */
  if (parsed.tables?.length) {
    try {
      /*
       * 表的描述句也 embed 一份，供報告依語意挑表。與 chunks 分開：
       * chunks 是「內容」的向量，這裡是「這張表在講什麼」的向量，用途與粒度都不同。
       * embedding 失敗不阻斷——沒有向量只是選表退回字面比對。
       *
       * 這裡沿用整包版的 embedInBatches：一張表只有一句描述，總量以工作表數計，
       * 不像 chunks 會隨檔案大小成長。
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
      const n = await saveTables(tenantId, fileId, name, parsed.tables, tableVectors, scopes);
      logger.info({ tenantId, name, tables: parsed.tables.length, rows: n }, '結構化表已留存');
    } catch (err) {
      logger.warn({ err, tenantId, name }, '結構化表留存失敗，匯入照常完成（報告將無法畫精確圖）');
    }
  }

  // 計數在 DB 端聚合，不搬任何列回來。原本是「既有快照 + 本次新增」就地拼出，除了要先
  // 付一次全量載入的代價，併發匯入時還會短暫偏低；寫入後直接 count 既便宜又是權威值。
  const counts = await countChunksBySource(tenantId);
  const generatedAt = new Date().toISOString();

  const fileMeta: KnowledgeFileMeta = {
    fileId,
    name,
    // 由寫入層回報實際列數，不由上游自己數——兩邊分歧時後台顯示的數字就是假的
    chunks: chunkCount,
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
