/** 實際 Chromium 回歸測試：需 RUN_KNOWLEDGE_BROWSER_TESTS=1，無外網或模型服務依賴。 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), tokens: 0 }),
  }),
}));
jest.mock('@/modules/knowledge/knowledge.index.repo', () => ({ replaceWebsiteChunks: jest.fn() }));

import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { WebsiteBrowser } from '@/modules/knowledge/website-browser';
import { runIngest } from '@/modules/knowledge/ingest.service';
import { replaceWebsiteChunks } from '@/modules/knowledge/knowledge.index.repo';

const liveDescribe = process.env.RUN_KNOWLEDGE_BROWSER_TESTS === '1' ? describe : describe.skip;

liveDescribe('實際瀏覽器動態解析', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/dashboard') {
        res.end(`<html><head><title>展覽數據</title></head><body><main id="content"></main><script>
          setTimeout(() => { document.getElementById('content').innerHTML =
          '<h1>台北國際自行車展</h1><p>今年參觀者預登人數：360 人，台灣 128 人，海外 232 人。此為示意用模擬資料。</p><a href="/details">統計說明</a>'; }, 100);
          </script></body></html>`);
      } else if (req.url === '/private') {
        res.end('<script>window.location.replace("/login")</script>');
      } else if (req.url === '/login') {
        res.end('<main>請先登入</main>');
      } else if (req.url === '/session') {
        if (!req.headers.cookie) res.setHeader('set-cookie', 'test-session=first; Path=/');
        res.end(`<main>${req.headers.cookie ? '已有登入 cookie' : '沒有登入 cookie'}</main>`);
      } else if (req.url === '/large-script') {
        res.end(`<main><h1>統計資訊</h1><p>今年參觀者預登人數為 360 人，包含台灣與海外參觀者，此為測試資料。</p></main><script type="application/json">"${'X'.repeat(3_000_000)}"</script>`);
      } else if (req.url === '/large-dom') {
        res.end(`<main>${'X'.repeat(3_000_000)}</main>`);
      } else {
        res.end('<main><h1>統計說明</h1><p>本頁為動態插入連結的子頁，說明參觀者預登總數包括台灣及海外人數，統計僅供示意。</p></main>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('執行延遲 JavaScript 後將數字與動態子頁寫入索引', async () => {
    const index = await runIngest({
      tenantId: 'browser-live', startUrl: `${origin}/dashboard`, maxPages: 2,
      chunkChars: 800, embeddingModel: 'test', renderJavaScript: true, renderWaitMs: 500,
    });
    expect(index.chunks.some((chunk) => chunk.text.includes('360 人') && chunk.text.includes('台北國際自行車展'))).toBe(true);
    expect(index.chunks.some((chunk) => chunk.url === `${origin}/details`)).toBe(true);
    expect(replaceWebsiteChunks).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('不沿用登入狀態，起始頁跳往登入頁時不覆寫索引', async () => {
    await expect(runIngest({
      tenantId: 'browser-live', startUrl: `${origin}/private`, maxPages: 1,
      chunkChars: 800, embeddingModel: 'test', renderJavaScript: true, renderWaitMs: 500,
    })).rejects.toThrow('網站需要登入');
    expect(replaceWebsiteChunks).not.toHaveBeenCalled();
  }, 30_000);

  it('獨立任務不共用 cookies', async () => {
    const first = new WebsiteBrowser();
    const second = new WebsiteBrowser();
    try {
      await first.open();
      await second.open();
      await first.load(`${origin}/session`, 0);
      expect((await first.load(`${origin}/session`, 0)).html).toContain('已有登入 cookie');
      expect((await second.load(`${origin}/session`, 0)).html).toContain('沒有登入 cookie');
    } finally {
      await first.close();
      await second.close();
    }
  }, 30_000);

  it('在瀏覽器端去掉大型 script，正文仍可索引；超量 DOM 則拒絕傳入 Node', async () => {
    const browser = new WebsiteBrowser();
    try {
      await browser.open();
      const page = await browser.load(`${origin}/large-script`, 0);
      expect(page.html).toContain('360 人');
      expect(page.html.length).toBeLessThan(1000);
      await expect(browser.load(`${origin}/large-dom`, 0)).rejects.toThrow('渲染後單頁 HTML 超過');
    } finally {
      await browser.close();
    }
  }, 30_000);
});
