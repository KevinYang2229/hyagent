/**
 * PDF renderer：把 html renderer 的產物交給 headless Chromium 印成 PDF。
 *
 * 直接叫 Chromium 執行檔，而不引 puppeteer：
 * - 版面早已由 html renderer 與它的 @page／break-inside 規則決定，這裡只需要「印」這一個
 *   動作。為它多一包依賴與一組會隨版本漂移的 API 並不划算。
 * - 一份報告一個行程，印完就結束。長跑的 server 不必養一個會累積記憶體的瀏覽器單例，
 *   而報告本來就是數十秒的非同步工作，多花半秒啟動行程無關痛癢；行程崩了也只影響這一份。
 *
 * 網路一律封死（--host-resolver-rules）。報告內文來自被爬取的網站與 LLM 輸出，其中的
 * markdown 圖片語法 ![](http://…) 會被 markdown-it 轉成真正的 <img>。讀者自己開那份 HTML 時
 * 是他的機器去抓；改由 server 印 PDF，就變成 server 去抓內網位址——那是 SSRF，不是排版。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { ReportDoc } from '../report.types';
import type { ReportRenderer } from '../report.render';
import { htmlRenderer } from './html';

const run = promisify(execFile);

/** 未設定 REPORT_PDF_BROWSER 時依序探測的位置：容器在前，開發機在後 */
const CANDIDATES = [
  // Ubuntu 的 Chromium 可能是 Snap 包裝器，其 /tmp 與主機不同；優先使用原生 Chrome。
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** 純檔案系統探測，不看 env。測試要驗真實輸出時得繞過 env 的覆寫，所以單獨開一支 */
export function probeBrowserPath(): string | undefined {
  return CANDIDATES.find((path) => existsSync(path));
}

/**
 * 找出可用的瀏覽器執行檔；找不到回 undefined，登錄表據此決定要不要提供 pdf 格式。
 *
 * env 指定的路徑一樣要檢查存在——但不存在時**不再往下探測**，而是留下一筆警告後放棄：
 * 操作者明確指了一個路徑，卻默默改用別的瀏覽器，是比缺少格式更難查的問題。
 */
export function resolveBrowserPath(): string | undefined {
  const configured = env.REPORT_PDF_BROWSER?.trim();
  if (configured) {
    if (existsSync(configured)) return configured;
    logger.warn({ path: configured }, 'REPORT_PDF_BROWSER 指向的檔案不存在，本次部署不提供 PDF 格式');
    return undefined;
  }
  return probeBrowserPath();
}

/** 一份報告的印製上限。卡住時要讓工作以錯誤收場，而不是把 job 永遠掛在那裡 */
const PRINT_TIMEOUT_MS = 30_000;

export async function renderPdf(doc: ReportDoc): Promise<Buffer> {
  const browser = resolveBrowserPath();
  if (!browser) {
    throw new Error('找不到 Chromium 執行檔，無法輸出 PDF（可用 REPORT_PDF_BROWSER 指定路徑）');
  }

  const dir = await mkdtemp(join(tmpdir(), 'oa-report-'));
  const src = join(dir, 'report.html');
  const out = join(dir, 'report.pdf');
  try {
    await writeFile(src, await htmlRenderer.render(doc));
    await run(
      browser,
      [
        '--headless',
        '--disable-gpu',
        // 每次使用獨立 profile，避免把列印命令轉交既有 Chrome 行程後提早結束。
        // 放在同一個暫存目錄，成功與失敗都由 finally 一起清除。
        `--user-data-dir=${join(dir, 'profile')}`,
        // 容器裡以 root 執行時沒有 user namespace 可用。內容是自家產生的 HTML、
        // 不含腳本且網路已封死，關掉沙箱換得起
        '--no-sandbox',
        // 容器的 /dev/shm 預設只有 64MB，大報告會在這裡當掉
        '--disable-dev-shm-usage',
        // 封死所有連外解析（見檔頭）
        '--host-resolver-rules=MAP * ~NOTFOUND',
        // 頁首頁尾預設會印上檔名與日期；報告表頭自己已經有標題與產生時間了
        '--no-pdf-header-footer',
        `--print-to-pdf=${out}`,
        pathToFileURL(src).href,
      ],
      { timeout: PRINT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    let pdf: Buffer;
    try {
      pdf = await readFile(out);
    } catch (cause) {
      throw new Error('Chromium 已結束但無法讀取 PDF 產出，請檢查瀏覽器執行環境與暫存目錄存取權限', { cause });
    }
    if (pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('Chromium 未產生有效的 PDF 檔案');
    }
    return pdf;
  } finally {
    // 報告內容不留在磁碟上：暫存目錄無論成敗都要清掉
    await rm(dir, { recursive: true, force: true });
  }
}

export const pdfRenderer: ReportRenderer = {
  format: 'pdf',
  contentType: 'application/pdf',
  render: renderPdf,
};
