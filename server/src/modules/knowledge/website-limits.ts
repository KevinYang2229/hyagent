/** 網站解析的記憶體預算；超量時停止任務，不以殘缺內容覆寫既有索引。 */
import { getHeapStatistics } from 'node:v8';
export const MAX_WEBSITE_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_WEBSITE_TEXT_CHARS = 2_000_000;
export const MAX_WEBSITE_CHUNKS = 1000;

/** 可穿過逐頁錯誤處理的資源超量錯誤。 */
export class WebsiteIngestLimitError extends Error {
  constructor(message: string) {
    super(`${message}；請縮小網站解析範圍或降低最大頁數，原有索引未變更`);
    this.name = 'WebsiteIngestLimitError';
  }
}

/** 為 DOM 解析及向量序列化預留 64 MiB，接近 heap 上限時提早結束工作。 */
export function assertWebsiteHeapBudget(): void {
  if (getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed < 64 * 1024 * 1024) {
    throw new WebsiteIngestLimitError('網站解析可用記憶體不足');
  }
}

/** 串流讀取且逐批檢查解壓後大小，不先以 response.text 載入整份內容。 */
export async function readWebsiteHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let bytes = 0;
  let html = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_WEBSITE_HTML_BYTES) {
        throw new WebsiteIngestLimitError('單頁 HTML 超過 2 MiB');
      }
      html += decoder.decode(next.value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
