/** 後台深/淺色主題：套用 <html data-theme>，@hyagent/ui token 隨之切換。 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'oa-admin-theme';

/** 初始主題：優先本地記憶，否則跟隨系統偏好 */
export function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 訂閱 <html data-theme> 變動，回傳目前主題（供圖表等需即時跟隨主題的元件用）。 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(getTheme());
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(getTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}
