/** 導到 AI 對話：nonce 每次唯一，讓同一個問題也能再問一次（畫面用 nonce 判斷是否已處理）。 */
let seq = 0;

export function chatRoute(params: { q?: string; voice?: '1'; focus?: '1' } = {}) {
  seq += 1;
  return { pathname: '/chat' as const, params: { ...params, nonce: `${Date.now()}-${seq}` } };
}
