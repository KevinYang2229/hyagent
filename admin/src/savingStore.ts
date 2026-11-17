import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * 全域「儲存中」計數：任何寫入後端的請求（POST/PUT/PATCH/DELETE）進行中時 > 0，
 * App 最外層的 GlobalSavingOverlay 依此顯示全畫面遮罩，等完成後才能操作其他功能。
 * 用計數而非布林：同時送出多個請求時，要等最後一個結束才解除。
 */
let pending = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const savingStore = {
  begin(): () => void {
    pending += 1;
    emit();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      pending = Math.max(0, pending - 1);
      emit();
    };
  },
  get: () => pending,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** 包住一個非同步工作：開始時鎖住畫面，結束（成功或失敗）時解除 */
export async function withSaving<T>(work: () => Promise<T>): Promise<T> {
  const end = savingStore.begin();
  try {
    return await work();
  } finally {
    end();
  }
}

/**
 * 寫入方法但其實只是查詢／測試、不改資料的端點：不擋畫面，
 * 讓管理者能邊看結果邊操作（測試查詢、資料預覽、連線測試、dry-run 驗證）。
 */
const NON_BLOCKING = [/\/knowledge\/query-test$/, /\/query\/preview$/, /\/connection-test$/, /[?&]dry_run=1/];

export function shouldBlock(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET') return false;
  return !NON_BLOCKING.some((re) => re.test(path));
}

/**
 * 目前是否該顯示遮罩。結束後延遲一小段才解除：
 * 一次儲存若是連續幾個請求（先 PATCH 再重新載入、或分段寫入），中間空檔不會閃一下又放開。
 */
export function useSaving(releaseDelayMs = 120): boolean {
  const count = useSyncExternalStore(savingStore.subscribe, savingStore.get, savingStore.get);
  const [show, setShow] = useState(count > 0);
  useEffect(() => {
    if (count > 0) {
      setShow(true);
      return;
    }
    const t = setTimeout(() => setShow(false), releaseDelayMs);
    return () => clearTimeout(t);
  }, [count, releaseDelayMs]);
  return show;
}

/** 讓元件在 busy 期間持有鎖（例如一次儲存含多個步驟、或中間要先做 dry-run） */
export function useHoldSaving(busy: boolean) {
  useEffect(() => {
    if (!busy) return;
    return savingStore.begin();
  }, [busy]);
}
