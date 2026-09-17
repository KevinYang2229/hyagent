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

// db 模式測試（knowledge-index-repo-db、report-store-db 等 6 支）會把 DATA_BACKEND 翻成 'db'
// 再 isolateModules 重載 env；env schema 於 DATA_BACKEND=db 時強制要求 DATABASE_URL，缺了就
// process.exit(1) 打死整個 jest 進程。本機靠 server/.env 剛好補上，CI 沒有 .env 就整包紅。
// 這些測試一律 jest.mock('@/lib/db')，不會真的連線，故給一個明確不可用的假值即可；
// 用假值而非真 URL 也是防線：萬一哪天有測試漏 mock，會連線失敗而不是靜靜寫進開發者的真 DB。
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/oa_agent_test_never_connected';

// 靜態加密固定關閉（'' 在 env schema 視為未設定）：本機 .env 可能有 DATA_ENCRYPTION_KEY，
// 測試需確定性的明文預設；要驗證加密的測試自行以 isolateModules 注入金鑰。
process.env.DATA_ENCRYPTION_KEY ??= '';

// PDF 輸出固定關閉：開發機上探測得到 Chrome 的話，每個報告 job 測試都會真的去印一份，
// 整套測試多花二十幾秒還可能逾時。真正驗證 PDF 輸出的是 report-pdf.test.ts，它自行探測。
process.env.REPORT_PDF_BROWSER ??= join(tmpdir(), 'oa-agent-no-such-browser');

process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';
// Prevent dotenv from importing the developer's real embedding API key.
process.env.OPENAI_API_KEY ??= 'test-openai-key';
// 啟用管理 API（Form Designer 端點測試用）
process.env.ADMIN_API_KEY ??= 'test-admin-key';
// 知識庫索引/設定寫檔隔離到暫存目錄，避免污染 repo 的 server/data。
// 目錄須依 worker 分開：knowledge.store 會整份覆寫 knowledge-config.json，refreshKnowledgeStore
// 又會從檔案重讀並刪掉檔案裡沒有的租戶；多個 worker 共用同一檔時，別的 worker 的快照會把
// 本 worker 剛建立的租戶資料清掉，完整測試因而隨機失敗（--runInBand 則全過）。
process.env.KNOWLEDGE_INDEX_DIR ??= join(tmpdir(), `oa-agent-test-knowledge-${process.env.JEST_WORKER_ID ?? '0'}`);

// LLM 設定測試與本機 server/.env 脫鉤：setupFiles 先佔住的值 dotenv 不會覆蓋
process.env.LLM_PROVIDER ??= 'anthropic';
process.env.LLM_MODEL ??= 'claude-sonnet-4-5';

// 地端 LLM 測試：resolve/embedding 的 local 路徑需要端點；僅在 provider=local 時生效，
// 不影響預設 anthropic 的雲端測試
process.env.LLM_BASE_URL ??= 'http://localhost:8000/v1';
