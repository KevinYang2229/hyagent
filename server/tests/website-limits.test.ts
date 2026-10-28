import { readWebsiteHtml, MAX_WEBSITE_HTML_BYTES, assertWebsiteHeapBudget } from '@/modules/knowledge/website-limits';

afterEach(() => jest.restoreAllMocks());

it('分批讀取 HTML 不破壞跨批次 UTF-8 中文', async () => {
  const bytes = new TextEncoder().encode('<main>預登人數</main>');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7));
      controller.close();
    },
  });
  expect(await readWebsiteHtml(new Response(stream))).toBe('<main>預登人數</main>');
});

it('沒有 content-length 的串流超量時停止讀取並取消下載', async () => {
  const cancel = jest.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_WEBSITE_HTML_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel,
  });
  await expect(readWebsiteHtml(new Response(stream))).rejects.toThrow('單頁 HTML 超過 2 MiB');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('接近 Node heap 上限時回報錯誤，不再進行解析', () => {
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 0, heapTotal: 0, heapUsed: Number.MAX_SAFE_INTEGER, external: 0, arrayBuffers: 0 });
  expect(() => assertWebsiteHeapBudget()).toThrow('可用記憶體不足');
});
