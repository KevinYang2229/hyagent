/**
 * dbi-e2e-eval 的第一個 import：在任何 server 模組（env.ts 於載入時解析）之前強制 file 後端與臨時資料目錄。
 * dotenv 不覆寫已設定的變數，故 .env 若指向正式資料庫也不會被寫入。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_BACKEND = 'file';
process.env.OA_AGENT_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'dbi-eval-'));
process.env.NODE_ENV ??= 'development';
