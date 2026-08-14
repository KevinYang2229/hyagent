/**
 * 資料夾批次匯入的執行器。
 *
 * 與 admin 單檔上傳共用同一條 ingestFile 管線——本檔不含任何解析、切塊或 embedding 邏輯，
 * 只負責「挑出該處理哪些檔、依序餵進去、把結果歸檔」。
 */
import { AppError } from '@/utils/app-error';
import type { PendingItem } from './batch-source';

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
