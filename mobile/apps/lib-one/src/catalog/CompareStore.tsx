/** 產品比較的勾選清單：產品探索、詳細頁都能加入，比較頁用 ids 參數讀取。 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { MAX_COMPARE } from './agentBridge';

interface CompareValue {
  ids: string[];
  has(id: string): boolean;
  /** 已滿 MAX_COMPARE 時加入失敗回 false */
  toggle(id: string): boolean;
  clear(): void;
  /** 整組換掉（推薦組合用），超過 MAX_COMPARE 的部分捨去 */
  replace(ids: string[]): void;
}

const CompareContext = createContext<CompareValue | null>(null);

export function CompareProvider({ children, initialIds = [] }: { children: ReactNode; initialIds?: string[] }) {
  const [ids, setIds] = useState<string[]>(initialIds);
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  const toggle = useCallback((id: string) => {
    if (ids.includes(id)) {
      setIds(ids.filter((x) => x !== id));
      return true;
    }
    if (ids.length >= MAX_COMPARE) return false;
    setIds([...ids, id]);
    return true;
  }, [ids]);
  const clear = useCallback(() => setIds([]), []);
  const replace = useCallback((next: string[]) => setIds([...new Set(next)].slice(0, MAX_COMPARE)), []);
  const value = useMemo(() => ({ ids, has, toggle, clear, replace }), [ids, has, toggle, clear, replace]);
  return <CompareContext.Provider value={value}>{children}</CompareContext.Provider>;
}

export function useCompare(): CompareValue {
  const v = useContext(CompareContext);
  if (!v) throw new Error('useCompare 必須在 CompareProvider 內使用');
  return v;
}
