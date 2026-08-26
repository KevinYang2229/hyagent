/**
 * 批次匯入的來源抽象。
 *
 * 管線（folder-ingest.service）只依賴 list / read / settle 三個方法，不知道背後是本機
 * 資料夾、網路磁碟機還是物件儲存。上線形態確定後新增實作即可，管線與測試不需改寫。
 *
 * 穩定性判定（檔案有沒有寫完）刻意**不放這裡**：那需要跨輪次的狀態，屬於執行者的職責，
 * 放進來會讓每個 source 實作都得自己重做一次。見 folder-ingest.service 的 selectStable。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { logger } from '@/lib/logger';
import { SUPPORTED_EXTENSIONS } from './doc-parse';

/** 一個待處理的匯入項目 */
export interface PendingItem {
  /** 歸屬租戶（本機來源＝子資料夾名） */
  tenantId: string;
  /** 送進 ingestFile 的檔名，會顯示在知識庫檔案清單 */
  name: string;
  /** 來源內部識別（本機來源＝絕對路徑） */
  ref: string;
  size: number;
  /** 穩定性判定用；來源無此概念時為 null（視為永遠穩定） */
  mtimeMs: number | null;
  /** 可見性標籤 id（本機來源＝租戶目錄下的第二層資料夾名）；未分層時 undefined */
  labelId?: string;
}

/**
 * 自匯入路徑取出 labelId：`<root>/<tenantId>/<labelId>/<file>`。
 * 未分層（檔案直接放在租戶目錄下）回 undefined，由呼叫端依 fail-closed 規則擋下——
 * 這裡刻意不做「擋門」判斷，純解析與擋門邏輯分開，好單獨測試。
 */
export function parseLabelFromRef(ref: string, root: string, tenantId: string): string | undefined {
  const rel = ref.startsWith(root) ? ref.slice(root.length) : ref;
  const segs = rel.split('/').filter(Boolean);
  // segs = [tenantId, ...middle, filename]
  if (segs[0] !== tenantId || segs.length < 3) return undefined;
  return segs[1];
}

export type SettleOutcome = 'done' | 'failed';

export interface BatchSource {
  /** 列出所有待處理項目；已過濾副檔名與保留目錄，不做穩定性判定 */
  list(): Promise<PendingItem[]>;
  read(item: PendingItem): Promise<Buffer>;
  /** 標記完成；failed 時 reason 會落地成 <name>.error.txt */
  settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void>;
}

/** 消化成功的歸檔目錄名 */
export const DONE_DIR = '_done';
/** 永久性失敗的歸檔目錄名 */
export const FAILED_DIR = '_failed';

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

/** `_` 開頭為保留目錄、`.` 開頭為系統或同步中繼檔，兩者都不是租戶也不是待處理檔 */
function isReserved(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.');
}

/**
 * 本機（或已掛載的網路）資料夾來源：`<root>/<tenantId>/<labelId>/<檔案>`。
 *
 * 標籤層是可選的一層：直接放在租戶目錄下的檔案（未分層）也會被列出，
 * 只是其 `labelId` 為 undefined——是否放行由呼叫端（folder-ingest）依
 * fail-closed 規則決定，本類別只負責誠實回報路徑長什麼樣子。
 */
export class LocalFolderSource implements BatchSource {
  constructor(private readonly root: string) {}

  async list(): Promise<PendingItem[]> {
    // root 層：ENOENT 是正常情況（資料夾還沒建），其他錯誤是設定問題必須拋出
    let tenantDirs;
    try {
      tenantDirs = await readdir(this.root, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return [];
      throw err;
    }

    const items: PendingItem[] = [];

    for (const dir of tenantDirs) {
      if (!dir.isDirectory() || isReserved(dir.name)) continue;
      const tenantPath = join(this.root, dir.name);

      // 租戶層：ENOENT / ENOTDIR 屬於掃描期間的競態（資料夾被刪或被替換成檔案），靜默略過
      // 其他錯誤（如權限）必須記錄，但不中斷整輪掃描
      let entries;
      try {
        entries = await readdir(tenantPath, { withFileTypes: true });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
        logger.warn({ err: e, path: tenantPath }, '租戶資料夾讀取失敗，略過該租戶');
        continue;
      }

      for (const entry of entries) {
        // _done/_failed 等保留目錄與 . 開頭系統/同步中繼檔，兩層都要擋
        if (isReserved(entry.name)) continue;

        if (entry.isFile()) {
          // 未分層：檔案直接放在租戶目錄下，之後 parseLabelFromRef 會回 undefined
          await this.collectFile(items, dir.name, tenantPath, entry.name);
          continue;
        }

        if (entry.isDirectory()) {
          // 標籤層：只往下一層找檔案，不再繼續遞迴（標籤目錄底下的子目錄一律略過）
          const labelPath = join(tenantPath, entry.name);
          let labelEntries;
          try {
            labelEntries = await readdir(labelPath, { withFileTypes: true });
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
            logger.warn({ err: e, path: labelPath }, '標籤資料夾讀取失敗，略過');
            continue;
          }
          for (const labelEntry of labelEntries) {
            if (!labelEntry.isFile() || isReserved(labelEntry.name)) continue;
            await this.collectFile(items, dir.name, labelPath, labelEntry.name);
          }
        }
      }
    }
    return items;
  }

  /** 單一候選檔案：篩副檔名、stat、算 labelId，成功才推進 items */
  private async collectFile(
    items: PendingItem[],
    tenantId: string,
    dirPath: string,
    fileName: string,
  ): Promise<void> {
    if (!SUPPORTED.has(extname(fileName).toLowerCase())) return;

    const ref = join(dirPath, fileName);
    // stat 失敗通常是掃描期間被刪掉，靜默略過；其他錯誤記錄但不中斷
    let st;
    try {
      st = await stat(ref);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return; // 掃描期間被刪掉，下一輪自然不會再出現
      logger.warn({ err: e, path: ref }, '檔案 stat 失敗，略過');
      return;
    }
    items.push({
      tenantId,
      name: fileName,
      ref,
      size: st.size,
      mtimeMs: st.mtimeMs,
      labelId: parseLabelFromRef(ref, this.root, tenantId),
    });
  }

  async read(item: PendingItem): Promise<Buffer> {
    return readFile(item.ref);
  }

  async settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void> {
    const destDir = join(this.root, item.tenantId, outcome === 'done' ? DONE_DIR : FAILED_DIR);
    await mkdir(destDir, { recursive: true });
    // rename 在 POSIX 為原子操作且會覆蓋同名目標——重丟改版檔時直接取代舊的歸檔
    await rename(item.ref, join(destDir, item.name));
    if (outcome === 'failed' && reason) {
      await writeFile(join(destDir, `${item.name}.error.txt`), reason, 'utf8');
    }
  }
}
