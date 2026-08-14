/**
 * 資料夾批次匯入的執行器。
 *
 * 與 admin 單檔上傳共用同一條 ingestFile 管線——本檔不含任何解析、切塊或 embedding 邏輯，
 * 只負責「挑出該處理哪些檔、依序餵進去、把結果歸檔」。
 */
import { AppError } from '@/utils/app-error';
import { logger } from '@/lib/logger';
import type { BatchSource, PendingItem } from './batch-source';
import { ingestFile, removeFile } from './knowledge-file.service';
import { loadIndex } from './knowledge.index.repo';
import { knowledgeStore } from './knowledge.store';
import { refreshSuggestedPrompts } from './knowledge.suggest';

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
  /** 本輪實際有成功匯入檔案的租戶 */
  tenants: string[];
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

/** 同名檔視為更新：先移除既有的同名檔，否則索引會留下兩份 chunks */
async function replaceSameName(tenantId: string, name: string): Promise<void> {
  const existing = knowledgeStore.getMeta(tenantId).files?.find((f) => f.name === name);
  if (existing) await removeFile(tenantId, existing.fileId);
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
    tenants: [],
  };
  if (stable.length === 0) return result;

  if (opts.dryRun) {
    for (const it of stable) {
      logger.info({ tenantId: it.tenantId, name: it.name, size: it.size }, '[dry-run] 將匯入');
    }
    return result;
  }

  const touched = new Set<string>();
  for (const it of stable) {
    const outcome = await ingestOne(source, it, opts);
    if (outcome === 'done') {
      result.done += 1;
      touched.add(it.tenantId);
    } else if (outcome === 'failed') {
      result.failed += 1;
    } else {
      result.retry += 1;
    }
  }

  // 推薦問句每租戶只重生一次：逐檔觸發會讓 N-1 次呼叫因世代防護而白花
  for (const tenantId of touched) {
    const idx = await loadIndex(tenantId);
    if (idx) await refreshSuggestedPrompts(tenantId, idx).catch(() => {});
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

  const attempt = async (): Promise<void> => {
    const buf = await source.read(item);
    await replaceSameName(item.tenantId, item.name);
    // deferSuggestions：推薦問句留到整輪結束統一重生
    const meta = await ingestFile(item.tenantId, item.name, buf, { deferSuggestions: true });
    logger.info({ tenantId: item.tenantId, name: item.name, chunks: meta.chunks }, '匯入完成');
  };

  try {
    await attempt();
    await source.settle(item, 'done');
    return 'done';
  } catch (err) {
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
      logger.warn(
        { tenantId: item.tenantId, name: item.name, err: retryErr },
        '匯入失敗（暫時性），保留原檔待下輪重試',
      );
      return 'retry';
    }
  }
}
