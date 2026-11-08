import { createContext, useContext, useEffect } from 'react';

/**
 * 未儲存變更的共用回報機制。
 *
 * 後台各頁籤的儲存方式不同：有的立即生效、有的按卡片儲存、權限頁整頁儲存。需要按「儲存」的區塊
 * 用 useUnsavedChanges 回報自己是否有未儲存的修改；租戶頁（TenantDetailPage）彙總後，
 * 在切換頁籤、回租戶清單或關閉瀏覽器前提醒，並列出是哪幾個區塊。
 */
type Report = (label: string, dirty: boolean) => void;

const UnsavedContext = createContext<Report>(() => {});

export const UnsavedChangesProvider = UnsavedContext.Provider;

/** label 會直接顯示在離開提醒裡，請用「頁籤：區塊」這類看得懂的名稱 */
export function useUnsavedChanges(label: string, dirty: boolean): void {
  const report = useContext(UnsavedContext);
  useEffect(() => { report(label, dirty); }, [label, dirty, report]);
  // 區塊卸載（切走頁籤、放棄變更）時撤銷回報
  useEffect(() => () => report(label, false), [label, report]);
}
