import { createContext, useContext, useEffect } from 'react';
import type { Location } from 'react-router-dom';

/**
 * 未儲存變更的共用提醒。
 *
 * 規則：後台所有「新增」或「編輯」的表單，只要有尚未儲存的輸入，離開前都要先確認。
 * 需要按「儲存」的區塊用 useUnsavedChanges(區塊名稱, 是否未儲存) 回報；最外層的 UnsavedGuard
 * 彙總後攔下所有離開途徑——側邊選單、頁籤切換、返回鍵、程式導頁——以及重整／關閉瀏覽器，
 * 並在確認彈窗列出是哪幾個區塊。
 *
 * 不攔的情況：
 * - 同一頁內只改了不會卸載畫面的網址參數（例如知識庫子頁 ?kb=，子頁只是隱藏、內容都還在）。
 * - 儲存成功後的導頁：導頁時帶 state={LEAVE_WITHOUT_PROMPT}（例如表單設計器存檔後回到表單清單）。
 */
export type Report = (label: string, dirty: boolean) => void;

/** 回報用的 context；由 UnsavedGuard 提供（未提供時回報不做任何事） */
export const UnsavedContext = createContext<Report>(() => {});

/** 直接提供回報函式（測試用；正式畫面由 UnsavedGuard 提供） */
export const UnsavedChangesProvider = UnsavedContext.Provider;

/** 儲存成功後導頁時帶入的 location state：這次導頁不需要提醒 */
export const LEAVE_WITHOUT_PROMPT = { skipUnsavedGuard: true } as const;

/** label 會直接顯示在離開提醒裡，請用「頁面：區塊」這類看得懂的名稱 */
export function useUnsavedChanges(label: string, dirty: boolean): void {
  const report = useContext(UnsavedContext);
  useEffect(() => { report(label, dirty); }, [label, dirty, report]);
  // 區塊卸載（切走頁籤、放棄變更）時撤銷回報
  useEffect(() => () => report(label, false), [label, report]);
}

/** 只換了同一頁內不會卸載畫面的參數時不攔（路徑或租戶頁籤 ?tab= 不同才算離開） */
export function isLeaving(current: Location, next: Location): boolean {
  if ((next.state as { skipUnsavedGuard?: boolean } | null)?.skipUnsavedGuard) return false;
  if (current.pathname !== next.pathname) return true;
  const tabOf = (search: string) => new URLSearchParams(search).get('tab');
  return tabOf(current.search) !== tabOf(next.search);
}
