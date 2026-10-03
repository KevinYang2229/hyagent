/**
 * 顯示提示 → 畫面區塊。
 *
 * MCP 工具在 `_meta["hyagent/display"]` 宣告如何把 structuredContent 畫成表格；
 * 這裡做白名單式的驗證與複製：只取宣告過的欄位、只接受安全的值，任何不合法一律不產生區塊。
 * 前端拿到的是現成的表格資料，不必自己解析工具結果。
 */
import type { DisplayBlock, DisplayTone, TableBlock, TableColumn } from '@hyagent/shared';

export const DISPLAY_META_KEY = 'hyagent/display';
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLUMNS = 12;
export const TABLE_SHOWN_NOTE = '結果已以表格顯示給使用者，請簡述重點，不要逐列重複數字。';

const TONES = new Set<DisplayTone>(['success', 'warning', 'danger', 'neutral']);
const FORMATS = new Set(['text', 'delta', 'date']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseColumn(raw: unknown): TableColumn | undefined {
  if (!isRecord(raw) || !nonEmptyString(raw.key) || !nonEmptyString(raw.label)) return undefined;
  const col: TableColumn = { key: raw.key, label: raw.label };
  if (nonEmptyString(raw.unit)) col.unit = raw.unit;
  if (raw.format !== undefined) col.format = FORMATS.has(raw.format as string) ? (raw.format as TableColumn['format']) : 'text';
  if (nonEmptyString(raw.image)) col.image = raw.image;
  if (isRecord(raw.badge)) {
    const badge: Record<string, DisplayTone> = {};
    for (const [value, tone] of Object.entries(raw.badge)) {
      if (TONES.has(tone as DisplayTone)) badge[value] = tone as DisplayTone;
    }
    col.badge = badge;
  }
  return col;
}

function cell(v: unknown): string | number | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function imageCell(v: unknown): string | null {
  return typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null;
}

export function buildDisplayBlock(display: unknown, data: unknown): DisplayBlock | undefined {
  if (!isRecord(display) || display.type !== 'table' || !nonEmptyString(display.rows)) return undefined;
  if (!isRecord(data)) return undefined;
  const source = Object.hasOwn(data, display.rows) ? data[display.rows] : undefined;
  if (!Array.isArray(source)) return undefined;
  if (!Array.isArray(display.columns) || display.columns.length === 0 || display.columns.length > MAX_TABLE_COLUMNS) return undefined;

  const columns: TableColumn[] = [];
  for (const raw of display.columns) {
    const col = parseColumn(raw);
    if (!col) return undefined;
    columns.push(col);
  }

  const rows = source.slice(0, MAX_TABLE_ROWS).map((r) => {
    const src = isRecord(r) ? r : {};
    const row: Record<string, string | number | null> = {};
    for (const col of columns) {
      row[col.key] = cell(Object.hasOwn(src, col.key) ? src[col.key] : undefined);
      if (col.image) row[col.image] = imageCell(Object.hasOwn(src, col.image) ? src[col.image] : undefined);
    }
    return row;
  });

  const block: TableBlock = { type: 'table', columns, rows };
  if (nonEmptyString(display.title)) block.title = display.title;
  return block;
}
