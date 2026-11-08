import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { Dialog } from '@hyagent/ui';
import { isLeaving, UnsavedContext, type Report } from './unsaved';

/** 掛在路由最外層（需在 data router 內，useBlocker 才能運作） */
export default function UnsavedGuard({ children }: { children: ReactNode }) {
  const [dirtyLabels, setDirtyLabels] = useState<string[]>([]);
  const report = useCallback<Report>((label, dirty) => {
    setDirtyLabels((prev) => {
      const has = prev.includes(label);
      if (dirty === has) return prev;
      return dirty ? [...prev, label] : prev.filter((l) => l !== label);
    });
  }, []);

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirtyLabels.length > 0 && isLeaving(currentLocation, nextLocation));

  // 重整或關閉瀏覽器：只能用瀏覽器內建的提示（瀏覽器不允許自訂這個畫面）
  useEffect(() => {
    if (dirtyLabels.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyLabels.length]);

  return (
    <UnsavedContext.Provider value={report}>
      {children}
      <Dialog
        isOpen={blocker.state === 'blocked'}
        title="放棄未儲存的變更？"
        confirmText="放棄並離開"
        cancelText="留在此頁"
        confirmVariant="danger"
        onClose={() => blocker.reset?.()}
        onConfirm={() => {
          setDirtyLabels([]);
          blocker.proceed?.();
        }}
      >
        以下區塊有尚未儲存的變更，離開後會遺失：{dirtyLabels.join('、')}。
      </Dialog>
    </UnsavedContext.Provider>
  );
}
