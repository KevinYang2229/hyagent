/** 網站動態解析：每次爬取使用獨立瀏覽器，不沿用管理者或其他租戶的登入狀態。 */
import { existsSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright-core';
import { MAX_WEBSITE_HTML_BYTES, WebsiteIngestLimitError } from './website-limits';

export interface RenderedWebsitePage {
  html: string;
  url: string;
}

/** 尋找容器或本機的 Chromium；不在解析期間下載瀏覽器。 */
function browserExecutable(): string {
  const configured = process.env.KNOWLEDGE_BROWSER_EXECUTABLE?.trim();
  const candidates = configured ? [configured] : [
    process.env.REPORT_PDF_BROWSER,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error('找不到 Chromium，請安裝瀏覽器或設定 KNOWLEDGE_BROWSER_EXECUTABLE');
  return executable;
}

/** 同一次網站解析共用程序，頁面逐一處理；所有資源由 close 釋放。 */
export class WebsiteBrowser {
  private browser?: Browser;
  private context?: BrowserContext;

  /** 啟動獨立的無痕環境；啟動失敗時仍釋放已建立的程序。 */
  async open(): Promise<void> {
    try {
      // 一般 API 與非瀏覽器測試不需載入 Playwright 的執行期模組。
      const { chromium } = await import('playwright-core');
      this.browser = await chromium.launch({
        executablePath: browserExecutable(),
        headless: true,
        args: ['--disable-dev-shm-usage'],
        timeout: 30_000,
      });
      this.context = await this.browser.newContext({
        userAgent: 'oa-agent-knowledge-ingest',
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** 等待 DOM 與非同步內容，回傳渲染後 HTML；登入跳轉不當作知識內容。 */
  async load(url: string, waitMs: number): Promise<RenderedWebsitePage> {
    if (!this.context) throw new Error('網站解析瀏覽器尚未啟動');
    const page = await this.context.newPage();
    try {
      // 字型、圖片與影片不影響文字索引，省下下載與解碼成本。
      await page.route('**/*', (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (!['http:', 'https:'].includes(target.protocol)
          || ['image', 'media', 'font'].includes(request.resourceType())
          || (request.isNavigationRequest() && new URL(url).origin !== target.origin)) {
          return route.abort();
        }
        return route.continue();
      });
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!response?.ok()) throw new Error(`網站載入失敗（HTTP ${response?.status() ?? '無回應'}）`);
      if (!(response.headers()['content-type'] ?? '').includes('text/html')) {
        throw new Error('網站內容不是 HTML');
      }
      // 不以 networkidle 當必要條件，避免輪詢或聊天 widget 讓解析永遠等不到完成。
      await page.waitForTimeout(waitMs);
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== new URL(url).origin) throw new Error('網站跳轉至其他網域，無法解析');
      if (new URL(finalUrl).pathname !== new URL(url).pathname
        && /(?:^|\/)(?:login|sign-in|signin|auth)(?:[/.]|$)/i.test(new URL(finalUrl).pathname)) {
        throw new Error('網站需要登入，瀏覽器渲染不會沿用管理者的登入狀態；請提供可直接讀取的頁面或上傳資料檔案');
      }
      // 在瀏覽器端先去掉不入索引的大型程式與圖形，避免整份 DOM 複製進 Node heap。
      // 使用字串形式執行，server TypeScript 不需引入 DOM 型別。
      const html = await page.evaluate<string | null>(`(() => {
        document.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
        const html = document.documentElement.outerHTML;
        return new Blob([html]).size <= ${MAX_WEBSITE_HTML_BYTES} ? html : null;
      })()`);
      if (html === null) throw new WebsiteIngestLimitError('渲染後單頁 HTML 超過 2 MiB');
      return { html, url: finalUrl };
    } finally {
      await page.close();
    }
  }

  /** 結束爬取，不論成功或失敗均釋放瀏覽器程序。 */
  async close(): Promise<void> {
    await this.browser?.close();
    this.context = undefined;
    this.browser = undefined;
  }
}
