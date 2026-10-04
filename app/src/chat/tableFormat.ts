/** 表格儲存格格式（與網頁版 DisplayBlockView 一致）。 */
import type { DisplayTone, TableColumn } from '@hyagent/shared';

type Cell = string | number | null | undefined;

export function formatCell(col: TableColumn, v: Cell): string {
  if (col.format === 'delta') {
    return typeof v === 'number' && v > 0 ? `+${v}${col.unit ? ` ${col.unit}` : ''}` : '–';
  }
  if (v === null || v === undefined || v === '') return '–';
  return `${v}${col.unit ? ` ${col.unit}` : ''}`;
}

export function cellTone(col: TableColumn, v: Cell): DisplayTone | null {
  if (col.badge && v !== null && v !== undefined) {
    const key = String(v);
    return Object.prototype.hasOwnProperty.call(col.badge, key) ? col.badge[key] : 'neutral';
  }
  if (col.format === 'delta' && typeof v === 'number' && v > 0) return 'danger';
  return null;
}

export function imageUri(row: Record<string, unknown>, col: TableColumn): string | null {
  if (!col.image) return null;
  const u = row[col.image];
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}
