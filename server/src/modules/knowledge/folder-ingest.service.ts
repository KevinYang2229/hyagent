/**
 * 資料夾批次匯入的執行器。
 *
 * 與 admin 單檔上傳共用同一條 ingestFile 管線——本檔不含任何解析、切塊或 embedding 邏輯，
 * 只負責「挑出該處理哪些檔、依序餵進去、把結果歸檔」。
 */
import { AppError } from '@/utils/app-error';
import { logger } from '@/lib/logger';
import { kbScopeId } from '@/modules/authz/scope-catalog';
import type { BatchSource, PendingItem } from './batch-source';
import { ingestFile, removeFile } from './knowledge-file.service';
import { loadIndexText } from './knowledge.index.repo';
import { knowledgeStore, type KnowledgeFileMeta } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';
import { acquireIngestLock, releaseIngestLock, renewIngestLock } from './knowledge.ingest-lock';
import { tenantStore } from '@/modules/tenant/tenant.store';

/** 上一輪看到的檔案指紋，用來判斷檔案是否已經寫完 */
export interface SeenEntry {
  size: number;
  mtimeMs: number | null;
}

/**
 * 穩定性判定：只有 (size, mtime) 連續兩輪完全相同的檔案才算「寫完」。
 *
 * 沒有這道閘，rsync/scp 傳到一半、SMB 複製大檔、瀏覽器拖放大 PDF 都會被讀成截斷的內容，
 * 而截斷的 PDF 往往還能解析出前幾頁——那會安靜地把半份文件灌進知識庫，比直接失敗更糟。
 *
 * 回傳的 next 只包含本輪仍存在的檔案，讓已消化或被移走的項目自然淘汰（Map 不會無限成長）。
 */
export function selectStable(
  items: PendingItem[],
  seen: Map<string, SeenEntry>,
): { stable: PendingItem[]; next: Map<string, SeenEntry> } {
  const next = new Map<string, SeenEntry>();
  const stable: PendingItem[] = [];

  for (const it of items) {
    const entry: SeenEntry = { size: it.size, mtimeMs: it.mtimeMs };
    next.set(it.ref, entry);

    // 來源沒有 mtime 概念（例如未來的物件儲存）：無從判定，視為永遠穩定
    if (it.mtimeMs === null) {
      stable.push(it);
      continue;
    }
    const prev = seen.get(it.ref);
    if (prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs) stable.push(it);
  }
  return { stable, next };
}

/**
 * 錯誤分類：永久性失敗才歸檔到 _failed，暫時性失敗留在原地下輪重試。
 *
 * 判定保守方向刻意偏向「暫時性」——把暫時性誤判為永久性會讓檔案被歸檔而不再重試
 * （形同丟掉），反之只是多試幾輪。故僅 4xx（且非 429）視為永久性。
 */
export function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.statusCode === 429) return false; // rate limit：等一下就好
  return err.statusCode >= 400 && err.statusCode < 500;
}

/** 上游回報「帳號額度用完」的錯誤碼：credit_balance_exhausted 為現行，insufficient_quota 為舊版 */
const CREDIT_EXHAUSTED_CODES = new Set(['credit_balance_exhausted', 'insufficient_quota']);

/**
 * 帳號額度用完：與限流同為 429，但不會等一下就好——在儲值之前每次呼叫都會失敗。
 *
 * 依錯誤碼而非 status 判定：一般限流（rate_limit_exceeded）必須照舊留在暫時性，
 * 否則尖峰時段一次限流就會讓整輪停擺。
 */
function isCreditExhausted(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CREDIT_EXHAUSTED_CODES.has(code);
}

/** ingestOne 往上拋、要求整輪停下的訊號；檔案本身沒有錯，故不歸檔 */
class RoundHalt extends Error {}

/** 把任意拋出物轉成可寫進 .error.txt 的字串 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface RoundOptions {
  /** 只列出將處理什麼，不呼叫任何付費 API、不搬檔 */
  dryRun?: boolean;
  /** 單檔大小上限（位元組）；超過判永久性失敗 */
  maxBytes: number;
  /** 只處理此租戶 */
  tenantFilter?: string;
  /** 暫時性失敗的重試間隔（毫秒），預設 5000；測試傳 0 */
  retryDelayMs?: number;
}

export interface RoundResult {
  done: number;
  failed: number;
  /** 暫時性失敗、留在原地待下輪重試 */
  retry: number;
  /** 尚未穩定（可能還在寫入）而本輪略過 */
  skipped: number;
  /** 該租戶正被另一條匯入流程處理，本輪整個租戶略過 */
  locked: number;
  /** 本輪實際有成功匯入檔案的租戶 */
  tenants: string[];
  /**
   * 本輪中途停下的原因（目前只有 embedding 帳號額度用完）。有值時剩下的檔案都沒嘗試、
   * 留在原地；呼叫端應停止輪詢並提示處理，而不是下一輪繼續撞同一面牆。
   */
  halted?: string;
}

/** 跨輪次保留的狀態；由 CLI 持有，每輪傳入 */
export interface WatchState {
  seen: Map<string, SeenEntry>;
}

export function createWatchState(): WatchState {
  return { seen: new Map() };
}

const DEFAULT_RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 同名檔視為更新：找出應被取代的舊檔。
 *
 * **必須在 ingestFile 之前呼叫**——匯入成功後 meta.files 會同時存在新舊兩筆同名項，
 * 屆時再找就可能選中剛寫進去的那一筆，把新檔自己刪掉。
 */
function findSupersededFile(tenantId: string, name: string): KnowledgeFileMeta | undefined {
  return knowledgeStore.getMeta(tenantId).files?.find((f) => f.name === name);
}

/**
 * 執行一輪：掃描 → 穩定性判定 → 依租戶分組後**嚴格序列**逐檔匯入 → 歸檔。
 *
 * 序列而非平行：瓶頸在 embedding API（embedInBatches 內部已分批），而平行匯入只會
 * 讓錯誤處理與進度回報變複雜，換不到吞吐量。
 */
export async function runFolderIngestRound(
  source: BatchSource,
  state: WatchState,
  opts: RoundOptions,
): Promise<RoundResult> {
  const all = await source.list();
  const scoped = opts.tenantFilter ? all.filter((i) => i.tenantId === opts.tenantFilter) : all;

  const { stable, next } = selectStable(scoped, state.seen);
  state.seen = next;

  const result: RoundResult = {
    done: 0,
    failed: 0,
    retry: 0,
    skipped: scoped.length - stable.length,
    locked: 0,
    tenants: [],
  };
  if (stable.length === 0) return result;

  if (opts.dryRun) {
    for (const it of stable) {
      logger.info({ tenantId: it.tenantId, name: it.name, size: it.size }, '[dry-run] 將匯入');
    }
    return result;
  }

  /*
   * 依租戶分組後逐一取鎖，而不是逐檔取鎖。
   *
   * 逐檔取鎖擋得住重複寫入，但兩支流程會交錯搶檔：先跑完的把檔案搬進 _done，
   * 另一支拿到鎖後 read 撲空，於是整輪都是錯誤。整個租戶一次鎖起來，第二支
   * 直接跳過該租戶，下一輪檔案已經歸檔、清單自然是空的。
   */
  const byTenant = new Map<string, PendingItem[]>();
  for (const it of stable) {
    const list = byTenant.get(it.tenantId);
    if (list) list.push(it);
    else byTenant.set(it.tenantId, [it]);
  }

  const touched = new Set<string>();
  for (const [tenantId, items] of byTenant) {
    const lock = await acquireIngestLock(tenantId);
    if (!lock) {
      result.locked += items.length;
      logger.warn(
        { tenantId, files: items.length },
        '該租戶已有另一條匯入流程進行中，本輪略過（檔案留在原地，下輪再試）',
      );
      continue;
    }
    try {
      for (const it of items) {
        let outcome: Awaited<ReturnType<typeof ingestOne>>;
        try {
          outcome = await ingestOne(source, it, opts);
        } catch (err) {
          if (!(err instanceof RoundHalt)) throw err;
          result.halted = err.message;
          break;
        }
        if (outcome === 'done') {
          result.done += 1;
          touched.add(tenantId);
        } else if (outcome === 'failed') {
          result.failed += 1;
        } else {
          result.retry += 1;
        }
        // 每個檔跑完就續期：單一檔案可能數分鐘，不續期會讓長匯入被 TTL 誤判成殘留
        await renewIngestLock(lock);
      }
    } finally {
      await releaseIngestLock(lock);
    }
    // 額度是整個帳號共用的：換下一個租戶一樣會失敗，直接結束本輪
    if (result.halted) break;
  }

  // 推薦問句每租戶只重生一次：逐檔觸發會讓 N-1 次呼叫因世代防護而白花。
  // loadIndexText（不含向量）：推薦問句只吃文字，載入向量在 chunks 上千時會撞 statement timeout。
  for (const tenantId of touched) {
    try {
      const idx = await loadIndexText(tenantId);
      if (idx) await refreshSuggestedPrompts(tenantId, idx);
    } catch (err) {
      // 推薦問句是錦上添花，不該讓已經匯入成功的整輪連同歸檔結果一起崩掉——
      // 這裡原本沒有 try：loadIndex 一逾時就整個 CLI 退出，done 的檔案也拿不到報告
      logger.warn({ err, tenantId }, '推薦問句重生失敗，不影響本輪匯入結果');
    }
  }
  result.tenants = [...touched];
  return result;
}

/** 單檔處理；回傳本檔的結局。永久性失敗歸檔，暫時性失敗留在原地 */
async function ingestOne(
  source: BatchSource,
  item: PendingItem,
  opts: RoundOptions,
): Promise<'done' | 'failed' | 'retry'> {
  if (item.size > opts.maxBytes) {
    const reason = `檔案 ${(item.size / 1024 / 1024).toFixed(1)}MB 超過上限 ${(opts.maxBytes / 1024 / 1024).toFixed(0)}MB`;
    await source.settle(item, 'failed', reason);
    logger.warn({ name: item.name }, reason);
    return 'failed';
  }

  /*
   * 資料夾名必須對應到真實租戶。少了這道閘，打錯字或拿租戶「名稱」當資料夾名
   * （例如用 TTS 而非 5b6c6d6e8fec334c）都會安靜地建出一個幽靈租戶的索引：
   * chunks 進了 knowledge_chunks、embedding 的錢也付了，但 tenants 表沒有這個 id，
   * 於是後台看不到、檢索永遠不會用 tenant_id 查到它——完全沒有任何錯誤訊號。
   *
   * 判永久性失敗而非重試：資料夾名不會自己變對，重試只是把同一筆錢再燒一次。
   * 搬進 _failed/ 並附 .error.txt，使用者才看得到原因。
   */
  if (!tenantStore.getTenant(item.tenantId)) {
    const reason = `查無租戶 ${item.tenantId}：資料夾名必須是租戶 id，不是租戶名稱`;
    await source.settle(item, 'failed', reason);
    logger.warn({ tenantId: item.tenantId, name: item.name }, reason);
    return 'failed';
  }

  /*
   * 擋在門口：資料夾名對不上該租戶已知的可見性標籤，就不放行進 ingestFile。
   *
   * 批次匯入無人值守，fail-closed 下「匯入成功但沒人看得到」是最糟的狀態——
   * embedding 的錢付了、資料庫空間佔了、chunkCount 漂亮地漲上去、管理面板一切正常，
   * 但這些文件對所有人都不存在，而且不會有人來抱怨。錯誤區看得見、可處理，
   * 且尚未花掉 embedding 的錢，故在這裡擋下而不是放進來再關燈。
   *
   * 匯入來源的目錄結構必須是 <root>/<tenantId>/<labelId>/*，未分層或標籤不存在一律
   * 歸檔到錯誤區。ACL 過濾無條件生效（見 knowledge.visibility.ts），未標記的檔案
   * 匯進來只會對所有人不可見，擋在這裡才看得見、也還沒花掉 embedding 的錢。
   */
  const labels = tenantStore.getTenant(item.tenantId)?.knowledgeLabels ?? [];
  const known = item.labelId && labels.some((l) => l.id === item.labelId);
  if (!known) {
    const reason = `未知的可見性標籤資料夾：${item.labelId ?? '（未分層）'}`;
    logger.warn(
      { tenantId: item.tenantId, name: item.name, labelId: item.labelId },
      '匯入項目的資料夾未對應到已知標籤，歸檔至錯誤區',
    );
    await source.settle(item, 'failed', reason);
    return 'failed';
  }

  const attempt = async (): Promise<void> => {
    const buf = await source.read(item);
    const superseded = findSupersededFile(item.tenantId, item.name);
    // deferSuggestions：推薦問句留到整輪結束統一重生；visibilityScopes：資料夾層標籤直接投影
    // ——labelId 已由上方閘門確認存在於該租戶的標籤清單。
    const meta = await ingestFile(item.tenantId, item.name, buf, {
      deferSuggestions: true,
      visibilityScopes: [kbScopeId(item.labelId!)],
    });
    /*
     * 舊檔在新檔匯入成功「之後」才刪。反過來的話，匯入一失敗（P2028 交易逾時、embedding
     * 中斷）舊檔的 chunks 已經沒了、新的又沒進來，那個檔會整個從索引消失到某次重試成功
     * 為止——而重試每輪都要重付 embedding 費用，失敗期間機器人則完全查不到這份資料。
     * 現在的失敗代價只是舊檔仍在（等同沒做過這次匯入）。
     *
     * 反向風險是刪除失敗會留下兩份同名 chunks，但那在 admin 的檔案列表看得見、也刪得掉，
     * 遠好過靜默的資料消失。
     */
    if (superseded) await removeFile(item.tenantId, superseded.fileId, { deferSuggestions: true });
    logger.info({ tenantId: item.tenantId, name: item.name, chunks: meta.chunks }, '匯入完成');
  };

  try {
    await attempt();
    await source.settle(item, 'done');
    return 'done';
  } catch (err) {
    // 額度用完：不歸檔（檔案沒問題）、不重試（儲值前必然再失敗），通知上層停下整輪
    if (isCreditExhausted(err)) {
      logger.error({ tenantId: item.tenantId, name: item.name, err }, 'embedding 帳號額度用完，停止本輪匯入');
      throw new RoundHalt(describeError(err));
    }
    if (isPermanentFailure(err)) {
      const reason = describeError(err);
      await source.settle(item, 'failed', reason);
      logger.warn({ tenantId: item.tenantId, name: item.name, reason }, '匯入失敗（永久性）');
      return 'failed';
    }
    // 暫時性：重試一次；仍失敗就留在原地，下一輪再來
    await sleep(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    try {
      await attempt();
      await source.settle(item, 'done');
      return 'done';
    } catch (retryErr) {
      if (isCreditExhausted(retryErr)) {
        logger.error({ tenantId: item.tenantId, name: item.name, err: retryErr }, 'embedding 帳號額度用完，停止本輪匯入');
        throw new RoundHalt(describeError(retryErr));
      }
      logger.warn(
        { tenantId: item.tenantId, name: item.name, err: retryErr },
        '匯入失敗（暫時性），保留原檔待下輪重試',
      );
      return 'retry';
    }
  }
}
