import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@hyagent/ui';

/**
 * 全站共用的確認彈窗：取代瀏覽器原生 confirm()。
 *
 * 規則：後台所有刪除、撤銷、作廢、清除等不易復原的操作，都必須先經過這個確認彈窗，
 * 不使用 window.confirm／alert／prompt（樣式無法統一、無法顯示結構化說明，深色模式下也很突兀）。
 *
 * 用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: '刪除表單「請假單」？', message: '…', confirmText: '刪除' }))) return;
 */
export interface ConfirmOptions {
  title: ReactNode;
  /** 說明後果；字串內的換行會保留 */
  message?: ReactNode;
  /** 確認按鈕文字，預設「刪除」 */
  confirmText?: string;
  cancelText?: string;
  /** 確認按鈕是否用危險色，預設 true（多數確認都是刪除類） */
  danger?: boolean;
  /** 需輸入此字樣才能確認（用於大量或不可逆的刪除） */
  requireText?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    // 前一個尚未回應就被新的取代時，視為取消，避免 Promise 永遠懸著
    resolver.current?.(false);
    setTyped('');
    setCurrent(options);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const close = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setCurrent(null);
    setTyped('');
  };

  const needText = current?.requireText;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        isOpen={!!current}
        title={current?.title ?? ''}
        confirmText={current?.confirmText ?? '刪除'}
        cancelText={current?.cancelText ?? '取消'}
        confirmVariant={current?.danger === false ? 'primary' : 'danger'}
        {...(needText ? { confirmDisabled: typed.trim() !== needText } : {})}
        onClose={() => close(false)}
        onConfirm={() => close(true)}
      >
        {current?.message !== undefined && (
          <div style={{ whiteSpace: 'pre-line', marginTop: 0 }}>{current.message}</div>
        )}
        {needText && (
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field-label">請輸入「{needText}」以確認</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** 取得確認函式；必須在 ConfirmProvider 之內使用（App 最外層已掛） */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm 必須在 <ConfirmProvider> 內使用');
  return confirm;
}
