/** 從首頁帶問題進 AI 對話：同一個 nonce 只送一次（避免畫面重新渲染時重送）。 */
import { useEffect, useRef } from 'react';

export function useAutoAsk(q: string | undefined, nonce: string | undefined, send: (text: string) => Promise<boolean>): void {
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!q || !nonce || handled.current === nonce) return;
    handled.current = nonce;
    void send(q);
  }, [q, nonce, send]);
}
