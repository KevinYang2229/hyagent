jest.mock('@/modules/knowledge/website-browser');
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), tokens: 0 }),
  }),
}));
jest.mock('@/modules/knowledge/knowledge.index.repo', () => ({ replaceWebsiteChunks: jest.fn() }));

import { WebsiteBrowser } from '@/modules/knowledge/website-browser';
import { runIngest } from '@/modules/knowledge/ingest.service';
import { replaceWebsiteChunks } from '@/modules/knowledge/knowledge.index.repo';

const params = {
  tenantId: 'browser-ingest-test', startUrl: 'https://example.com/dashboard',
  maxPages: 2, chunkChars: 800, embeddingModel: 'test',
};
const html = '<main><h1>台北國際自行車展</h1><p>今年參觀者預登人數：360 人，台灣 128 人、海外 232 人。此為模擬資料。</p></main>';

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.restoreAllMocks(); });

it('未開啟渲染時維持直接解析 HTML，不啟動瀏覽器', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html' } }));
  const index = await runIngest(params);
  expect(WebsiteBrowser).not.toHaveBeenCalled();
  expect(index.chunks[0].text).toContain('360');
});

it('渲染模式使用渲染後正文與動態連結，傳遞等待時間並關閉瀏覽器', async () => {
  const load = jest.mocked(WebsiteBrowser.prototype.load);
  load.mockResolvedValueOnce({ html: `${html}<a href="/more">更多</a>`, url: params.startUrl })
    .mockResolvedValueOnce({ html, url: 'https://example.com/more' });
  const index = await runIngest({ ...params, renderJavaScript: true, renderWaitMs: 2200 });
  expect(load).toHaveBeenNthCalledWith(1, params.startUrl, 2200);
  expect(load).toHaveBeenNthCalledWith(2, 'https://example.com/more', 2200);
  expect(index.chunks[0].text).toContain('台灣 128');
  expect(replaceWebsiteChunks).toHaveBeenCalledTimes(1);
  expect(WebsiteBrowser.prototype.close).toHaveBeenCalledTimes(1);
});

it('起始頁渲染失敗時釋放瀏覽器且不覆寫索引', async () => {
  jest.mocked(WebsiteBrowser.prototype.load).mockRejectedValueOnce(new Error('網站需要登入'));
  await expect(runIngest({ ...params, renderJavaScript: true })).rejects.toThrow('網站需要登入');
  expect(WebsiteBrowser.prototype.close).toHaveBeenCalledTimes(1);
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});

it('渲染後仍無正文時不清除原有索引', async () => {
  jest.mocked(WebsiteBrowser.prototype.load).mockResolvedValueOnce({ html: '<main></main>', url: params.startUrl });
  await expect(runIngest({ ...params, renderJavaScript: true })).rejects.toThrow('沒有可解析的文字內容');
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});

it('啟動瀏覽器失敗時不覆寫索引', async () => {
  jest.mocked(WebsiteBrowser.prototype.open).mockRejectedValueOnce(new Error('找不到 Chromium'));
  await expect(runIngest({ ...params, renderJavaScript: true })).rejects.toThrow('找不到 Chromium');
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});
