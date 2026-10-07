/**
 * 相機辨識完成 → 結果頁。
 *
 * 相機是根 Stack 疊在 (tabs) 上的全螢幕 modal；用 replace 會在根 Stack 再生出第二個 (tabs)。
 * dismissTo（POP_TO）會退回既有的 (tabs) 再往下導到 AI 對話分頁的結果頁；withAnchor 讓 chat Stack
 * 首次掛載時也先放 index（對話）在結果頁下面，返回一定回得到對話。
 */
import { router } from 'expo-router';

export type ResultRoute = '/chat/shelf-result' | '/chat/coupon-result';

/**
 * 相機畫面還在才寫入結果並導頁；相機已關閉（使用者在辨識中按了關閉）就什麼都不做。
 * 回傳是否已導頁。
 */
export function goToResult(route: ResultRoute, isMounted: () => boolean, store: () => void): boolean {
  if (!isMounted()) return false;
  store();
  router.dismissTo(route, { withAnchor: true });
  return true;
}
