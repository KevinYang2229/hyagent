/**
 * 確認表單的純邏輯（與網頁版 ConfirmActionCard 規則一致）：
 * 表格列可取消勾選；只送表格與可編輯的純量欄位（不可編輯欄位由後端以原值補齊）；沒有修改就不帶內容。
 */
import type { ConfirmField, ConfirmTableField, PendingActionView } from '@hyagent/shared';

export type Values = Record<string, unknown>;
/** 每個表格欄位被取消勾選的列索引 */
export type Removed = Record<string, number[]>;

type Row = Record<string, unknown>;

export function initialValues(fields: ConfirmField[]): Values {
  const v: Values = {};
  for (const f of fields) v[f.key] = f.kind === 'table' ? f.rows.map((r) => ({ ...r })) : f.value;
  return v;
}

export function coerce(kind: string, raw: string): unknown {
  if (kind !== 'number') return raw;
  const n = Number(raw);
  return raw.trim() === '' || Number.isNaN(n) ? raw : n;
}

/** 選項的顯示值還原成原本的型別（數字 enum 要送回數字） */
export function rawOf(options: { value: string; label?: string; raw?: string | number | boolean }[] | undefined, value: string): unknown {
  const o = options?.find((x) => x.value === value);
  return o ? (o.raw ?? o.value) : value;
}

export function rowLabel(field: ConfirmTableField, row: Row, i: number): string {
  const col = field.columns.find((c) => !c.editable && typeof row[c.key] === 'string');
  return col ? String(row[col.key]) : `#${i + 1}`;
}

function keptRows(field: ConfirmTableField, values: Values, removed: Removed): Row[] {
  const gone = new Set(removed[field.key] ?? []);
  return (values[field.key] as Row[]).filter((_, i) => !gone.has(i));
}

export function buildInput(fields: ConfirmField[], values: Values, removed: Removed): Values {
  const out: Values = {};
  for (const f of fields) {
    if (f.kind === 'table') out[f.key] = keptRows(f, values, removed);
    else if (f.editable) out[f.key] = values[f.key];
  }
  return out;
}

export function isChanged(fields: ConfirmField[], values: Values, removed: Removed): boolean {
  const now = buildInput(fields, values, removed);
  const orig = buildInput(fields, initialValues(fields), {});
  return Object.keys(now).some((k) => JSON.stringify(now[k]) !== JSON.stringify(orig[k]));
}

/** 原本有列、被使用者全部取消勾選 */
export function hasEmptyTable(fields: ConfirmField[], values: Values, removed: Removed): boolean {
  return fields.some((f) => f.kind === 'table' && f.rows.length > 0 && keptRows(f, values, removed).length === 0);
}

function rangeError(label: string, v: unknown, min?: number, max?: number): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${label}需填數字`;
  if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
    return `${label}需介於 ${min ?? '-∞'}–${max ?? '∞'}`;
  }
  return null;
}

/** 送出前的本地檢查（只檢查勾選中的列）；通過回 null */
export function validateLocal(fields: ConfirmField[], values: Values, removed: Removed): string | null {
  for (const f of fields) {
    if (f.kind === 'table') {
      const gone = new Set(removed[f.key] ?? []);
      const rows = values[f.key] as Row[];
      for (let i = 0; i < rows.length; i++) {
        if (gone.has(i)) continue;
        for (const c of f.columns) {
          if (!c.editable || c.kind !== 'number') continue;
          const err = rangeError(`${rowLabel(f, rows[i], i)} 的${c.label}`, rows[i][c.key], c.min, c.max);
          if (err) return err;
        }
      }
    } else if (f.editable && f.kind === 'number') {
      const err = rangeError(f.label, values[f.key], f.min, f.max);
      if (err) return err;
    }
  }
  return null;
}

export function isExpired(action: PendingActionView, now: number = Date.now()): boolean {
  return Date.parse(action.expiresAt) <= now;
}

/** 裝置時區的今天（YYYY-MM-DD） */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

function dateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${iso.replace(/-/g, '/')}（${WEEKDAY[d.getUTCDay()]}）`;
}

/** 到貨日期下拉：從今天起 days 天；目前值不在範圍內時放在第一個 */
export function dateOptions(today: string, days = 7, current?: string): { value: string; label: string }[] {
  const base = new Date(`${today}T00:00:00Z`);
  const opts = Array.from({ length: days }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const tag = i === 0 ? '今天' : i === 1 ? '明天' : '';
    return { value: iso, label: `${dateLabel(iso)}${tag}` };
  });
  if (current && !opts.some((o) => o.value === current)) opts.unshift({ value: current, label: dateLabel(current) });
  return opts;
}
