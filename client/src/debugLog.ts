/**
 * 面板端的整合除錯輸出。
 *
 * 嵌入情境下「面板到底登入了誰、從 HyAgent 取回什麼資料」全發生在 iframe 裡，
 * 畫面上只有放大後的標題列會顯示使用者名稱，整合期很難確認身分有沒有正確帶進來。
 * 宿主頁在 widget script 加 `data-debug="1"`，widget.js 會以 `?debug=1` 帶進面板，
 * 這裡就把身分握手與換發結果印到 console（devtools 切到面板那個 frame 即可看到）。
 *
 * **預設關閉**，而且開啟後也只印遮罩過的憑證片段：console 的內容會被截圖、被貼進
 * issue，Assertion 與 Session Token 的原文不該出現在那裡（規格 §11.1 同樣的理由）。
 */
import { embedConfig } from './embedConfig';

const TAG = '%c[hyagent:panel]';
const STYLE = 'color:#fff;background:#0f766e;padding:1px 5px;border-radius:3px';

/** 是否開啟除錯輸出（宿主頁 data-debug="1" → iframe `?debug=1`）。 */
export const debugEnabled = embedConfig.debug;

export function debugLog(label: string, detail?: unknown): void {
  if (!debugEnabled) return;
  if (detail === undefined) console.log(TAG, STYLE, label);
  else console.log(TAG, STYLE, label, detail);
}

/** 憑證只印前 8 碼與長度——足以比對「是不是同一張」，又不足以拿去用。 */
export function maskToken(token: string | null | undefined): string {
  return token ? `${token.slice(0, 8)}…（共 ${token.length} 字元）` : '(無)';
}
