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

/** 本機（或已掛載的網路）資料夾來源：<root>/<tenantId>/<檔案> */
export class LocalFolderSource implements BatchSource {
  constructor(private readonly root: string) {}

  async list(): Promise<PendingItem[]> {
    const tenantDirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const items: PendingItem[] = [];

    for (const dir of tenantDirs) {
      if (!dir.isDirectory() || isReserved(dir.name)) continue;
      const tenantPath = join(this.root, dir.name);
      const entries = await readdir(tenantPath, { withFileTypes: true }).catch(() => []);

      for (const entry of entries) {
        // 不遞迴：租戶資料夾底下的子目錄一律略過（_done/_failed 也在此被擋掉）
        if (!entry.isFile() || isReserved(entry.name)) continue;
        if (!SUPPORTED.has(extname(entry.name).toLowerCase())) continue;

        const ref = join(tenantPath, entry.name);
        const st = await stat(ref).catch(() => null);
        if (!st) continue; // 掃描期間被刪掉／搬走，下一輪自然不會再出現
        items.push({ tenantId: dir.name, name: entry.name, ref, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return items;
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
