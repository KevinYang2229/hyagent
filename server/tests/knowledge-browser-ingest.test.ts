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
import { MAX_WEBSITE_CHUNKS, WebsiteIngestLimitError } from '@/modules/knowledge/website-limits';

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

it('重複連結僅入列一次，無正文頁也計入最大造訪頁數', async () => {
  const load = jest.mocked(WebsiteBrowser.prototype.load);
  load.mockResolvedValueOnce({ html: '<nav><a href="/a">A</a><a href="/a">A</a><a href="/b">B</a></nav>', url: params.startUrl })
    .mockResolvedValueOnce({ html: '<nav><a href="/b">B</a></nav>', url: 'https://example.com/a' });
  await expect(runIngest({ ...params, renderJavaScript: true })).rejects.toThrow('沒有可解析的文字內容');
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenNthCalledWith(2, 'https://example.com/a', 1500);
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});

it('網站超過片段預算時終止且關閉瀏覽器，不覆寫索引', async () => {
  const largeHtml = '<main>' + Array.from({ length: MAX_WEBSITE_CHUNKS + 1 }, (_, i) =>
    `<h2>統計項目 ${i}</h2><p>第 ${i} 項預登人數為 360 人，台灣 128 人與海外 232 人，模擬測試。</p>`).join('') + '</main>';
  jest.mocked(WebsiteBrowser.prototype.load).mockResolvedValueOnce({ html: largeHtml, url: params.startUrl });
  await expect(runIngest({ ...params, renderJavaScript: true })).rejects.toThrow('網站片段超過');
  expect(WebsiteBrowser.prototype.close).toHaveBeenCalledTimes(1);
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});

it('第二頁文字超過累積預算時不提交第一頁的殘缺索引', async () => {
  const largeHtml = `<main><p>${'A'.repeat(1_100_000)}</p></main><a href="/a">下一頁</a>`;
  jest.mocked(WebsiteBrowser.prototype.load).mockResolvedValueOnce({ html: largeHtml, url: params.startUrl })
    .mockResolvedValueOnce({ html: largeHtml, url: 'https://example.com/a' });
  await expect(runIngest({ ...params, chunkChars: 4000, renderJavaScript: true })).rejects.toThrow('文字總量超過');
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});

it('非起始頁超量也必須終止，不被逐頁錯誤處理略過', async () => {
  jest.mocked(WebsiteBrowser.prototype.load).mockResolvedValueOnce({ html: `${html}<a href="/a">更多</a>`, url: params.startUrl })
    .mockRejectedValueOnce(new WebsiteIngestLimitError('渲染後單頁 HTML 超過 2 MiB'));
  await expect(runIngest({ ...params, renderJavaScript: true })).rejects.toThrow('單頁 HTML 超過');
  expect(replaceWebsiteChunks).not.toHaveBeenCalled();
});
