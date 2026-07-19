/**
 * 測試環境前置：在任何模組 import `@/config/env` 之前補上必要環境變數。
 *
 * env.ts 於載入時 safeParse(process.env)，缺 ANTHROPIC_API_KEY 會 process.exit(1)。
 * jest 會自動把 NODE_ENV 設為 'test'，故 production 守門（dev 預設密鑰 fail-fast）不會觸發。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 持久化 store 隔離：每個 jest worker 用獨立暫存目錄（見 src/lib/data-dir.ts）。
// 否則測試與 dev server 共寫 os.tmpdir() 同一批檔，跑一次測試就污染 dev 資料
// （曾實際覆寫 default 租戶授予、灌入上百個測試租戶）。
process.env.OA_AGENT_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'oa-agent-test-'));

// store 後端固定 file：本機 server/.env 可能設 DATA_BACKEND=db（dotenv 不覆蓋既有值），
// 測試絕不能打到真 DB；db 模式的種子要等 initTenantStore()，測試不跑 boot 流程會缺預設租戶。
process.env.DATA_BACKEND ??= 'file';

process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';
// 啟用管理 API（Form Designer 端點測試用）
process.env.ADMIN_API_KEY ??= 'test-admin-key';
// 知識庫索引/設定寫檔隔離到暫存目錄，避免污染 repo 的 server/data
process.env.KNOWLEDGE_INDEX_DIR ??= join(tmpdir(), 'oa-agent-test-knowledge');

// LLM 設定測試與本機 server/.env 脫鉤：setupFiles 先佔住的值 dotenv 不會覆蓋
process.env.LLM_PROVIDER ??= 'anthropic';
process.env.LLM_MODEL ??= 'claude-sonnet-4-5';

// 地端 LLM 測試：resolve/embedding 的 local 路徑需要端點；僅在 provider=local 時生效，
// 不影響預設 anthropic 的雲端測試
process.env.LLM_BASE_URL ??= 'http://localhost:8000/v1';
