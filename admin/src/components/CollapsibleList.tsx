import type { ReactNode } from 'react';

/**
 * 可能很多筆的清單：先顯示前 max 筆，其餘收進「另有 N 項」展開（展開區有高度上限可捲動）。
 * 用在標籤、缺漏名單等數量不固定、可能成長到數十上百筆的地方，避免一整排撐爆版面。
 */
export default function CollapsibleList<T>({ items, max = 5, render, separator = '、', empty = null }: {
  items: T[];
  max?: number;
  render: (item: T) => ReactNode;
  /** 行內清單的分隔字；傳 null 代表項目本身是區塊（例如按鈕） */
  separator?: string | null;
  empty?: ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;
  const join = (list: T[]) => list.map((item, i) => (
    <span key={i}>{i > 0 && separator}{render(item)}</span>
  ));
  const head = items.slice(0, max);
  const rest = items.slice(max);
  return <>
    {join(head)}
    {rest.length > 0 && (
      <details className="collapsible-more">
        <summary>另有 {rest.length} 項</summary>
        <div>{join(rest)}</div>
      </details>
    )}
  </>;
}
