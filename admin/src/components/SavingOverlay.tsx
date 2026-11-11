import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * 儲存中的全畫面遮罩：擋住滑鼠點擊側邊欄、分頁與其他按鈕，避免儲存途中切走或重複送出。
 * 同時把 #root 設為 inert，連鍵盤 Tab 也無法聚焦到背後的元素。
 * 遮罩以 portal 掛在 body（#root 之外），自身不受 inert 影響。
 */
export default function SavingOverlay({ show, text = '儲存中…' }: { show: boolean; text?: string }) {
  useEffect(() => {
    if (!show) return;
    const root = document.getElementById('root');
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    return () => {
      root.removeAttribute('inert');
      root.removeAttribute('aria-hidden');
      // 還原焦點，讓鍵盤使用者回到原本的儲存按鈕
      active?.focus?.();
    };
  }, [show]);

  if (!show) return null;
  return createPortal(
    <div className="saving-overlay" role="alert" aria-busy="true" aria-live="assertive">
      <div className="saving-overlay-box">
        <span className="kdrop-spinner" aria-hidden />
        <span>{text}</span>
      </div>
    </div>,
    document.body,
  );
}
