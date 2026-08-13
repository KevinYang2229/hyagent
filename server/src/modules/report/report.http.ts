/**
 * 報告下載的 HTTP 表述細節。獨立成模組是因為使用者端與後台兩個 controller 都要用，
 * 讓其中一個 import 另一個只會製造 controller 之間不必要的耦合。
 */

/**
 * Content-Disposition 檔名：classic 的 `filename="..."` 只定義給 ASCII，本產品預設語系是繁中，
 * 報告標題（因此檔名）預設就是中文——把 percent-encoded 字串塞進 `filename="..."` 是非標準用法，
 * 各瀏覽器解讀不一致，使用者很可能下載到檔名字面是 `%E5%A0%B1...` 的檔案，這不是邊角案例。
 * 同時提供 RFC 5987 的 `filename*`（標準做法）與一個安全的 ASCII fallback 給不支援 filename* 的舊瀏覽器。
 * filename 只可能來自 report.job.ts 的 slugify（僅 \p{L}\p{N}_. 組成），不含引號／反斜線，無 header 注入風險。
 */
export function contentDispositionHeader(filename: string): string {
  const isAscii = /^[\x20-\x7E]*$/.test(filename);
  const asciiFallback = isAscii ? filename : `report.${filename.split('.').pop() ?? 'txt'}`;
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
