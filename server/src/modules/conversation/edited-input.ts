/**
 * 使用者在確認卡片上修改後的參數：結構驗證與差異描述（純函式）。
 *
 * 前端不可信：鎖定鍵（唯讀、隱藏、被 x-image 指為圖片來源）必須與原值相同；表格的每一列必須能以
 * 「識別鍵（readOnly／x-hidden）相同」對應到原本唯一的一列，且該列的鎖定鍵不得變動——允許刪列、改可編輯欄位，不允許新增列。型別與數值範圍交給 Ajv。
 */
import { isLockedProp, labelOf, lockedKeysOf, schemaProps, type JsonSchemaLike } from './confirm-form';

type Result = { ok: true } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function isObjectArraySchema(s: JsonSchemaLike): boolean {
  return s.type === 'array' && isRecord(s.items) && isRecord((s.items as JsonSchemaLike).properties);
}

function identityKeys(itemProps: Record<string, JsonSchemaLike>): string[] {
  return Object.entries(itemProps).filter(([, p]) => p.readOnly === true || p['x-hidden'] === true).map(([k]) => k);
}

function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => Object.hasOwn(a, k) === Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** 回傳每一列修改後對應的原始列索引；無法對應時回錯誤訊息。 */
function matchRows(
  label: string,
  itemProps: Record<string, JsonSchemaLike>,
  original: unknown[],
  edited: unknown[],
): { pairs: [number, Record<string, unknown>][] } | { error: string } {
  const keys = identityKeys(itemProps);
  const origRows = original.filter(isRecord);
  const pairs: [number, Record<string, unknown>][] = [];
  if (keys.length === 0) {
    if (edited.length !== origRows.length) return { error: `${label}：不可增減列` };
    for (let i = 0; i < edited.length; i++) {
      const row = edited[i];
      if (!isRecord(row)) return { error: `${label}：第 ${i + 1} 列格式錯誤` };
      pairs.push([i, row]);
    }
    return { pairs };
  }
  const used = new Set<number>();
  for (let i = 0; i < edited.length; i++) {
    const row = edited[i];
    if (!isRecord(row)) return { error: `${label}：第 ${i + 1} 列格式錯誤` };
    const idx = origRows.findIndex((o, j) => !used.has(j) && sameIdentity(o, row, keys));
    if (idx < 0) {
      const dup = origRows.some((o) => sameIdentity(o, row, keys));
      return { error: dup ? `${label}：同一列不可重複` : `${label}：不可新增列或修改唯讀欄位` };
    }
    used.add(idx);
    pairs.push([idx, row]);
  }
  return { pairs };
}

export function validateEditedInput(schema: unknown, original: Record<string, unknown>, edited: unknown): Result {
  if (!isRecord(edited)) return { ok: false, errors: ['參數格式錯誤'] };
  const props = schemaProps(schema);
  const locked = lockedKeysOf(props);
  const errors: string[] = [];

  for (const k of Object.keys(edited)) {
    if (!Object.hasOwn(props, k)) errors.push(`不允許的欄位：${k}`);
  }

  for (const [key, s] of Object.entries(props)) {
    const has = Object.hasOwn(edited, key);
    const before = original[key];
    const after = edited[key];
    if (isObjectArraySchema(s) && Array.isArray(before) && !isLockedProp(s)) {
      if (!Array.isArray(after)) {
        errors.push(`${labelOf(key, s)}：格式錯誤`);
        continue;
      }
      const itemProps = schemaProps(s.items);
      const m = matchRows(labelOf(key, s), itemProps, before, after);
      if ('error' in m) {
        errors.push(m.error);
        continue;
      }
      const lockedCols = lockedKeysOf(itemProps);
      const origRows = before.filter(isRecord);
      for (const [idx, row] of m.pairs) {
        for (const rk of Object.keys(row)) if (!Object.hasOwn(itemProps, rk)) errors.push(`${labelOf(key, s)}：不允許的欄位 ${rk}`);
        for (const ck of lockedCols) {
          if (Object.hasOwn(row, ck) !== Object.hasOwn(origRows[idx], ck) || !deepEqual(row[ck], origRows[idx][ck])) {
            errors.push(`${labelOf(key, s)}：${rowName(origRows[idx], itemProps, idx)} 的 ${labelOf(ck, itemProps[ck])} 不可修改`);
          }
        }
      }
      continue;
    }
    if (locked.has(key) || isRecord(before) || Array.isArray(before)) {
      // 唯讀、或不提供編輯的巢狀值：必須與原值相同（含「原本沒有就不能出現」）
      if (has !== Object.hasOwn(original, key) || !deepEqual(before, after)) errors.push(`${labelOf(key, s)} 不可修改`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '（空）';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function rowName(row: Record<string, unknown>, itemProps: Record<string, JsonSchemaLike>, index: number): string {
  for (const [k, p] of Object.entries(itemProps)) {
    if (p.readOnly === true && p['x-hidden'] !== true && typeof row[k] === 'string') return row[k] as string;
  }
  return `第 ${index + 1} 列`;
}

export function describeEdits(schema: unknown, original: Record<string, unknown>, edited: Record<string, unknown>): string[] {
  const props = schemaProps(schema);
  const locked = lockedKeysOf(props);
  const lines: string[] = [];
  for (const [key, s] of Object.entries(props)) {
    const before = original[key];
    const after = edited[key];
    if (isObjectArraySchema(s) && Array.isArray(before) && Array.isArray(after) && !isLockedProp(s)) {
      const itemProps = schemaProps(s.items);
      const m = matchRows(labelOf(key, s), itemProps, before, after);
      if ('error' in m) continue;
      const lockedCols = lockedKeysOf(itemProps);
      const origRows = before.filter(isRecord);
      const kept = new Set<number>();
      for (const [idx, row] of m.pairs) {
        kept.add(idx);
        for (const [ck, cp] of Object.entries(itemProps)) {
          if (lockedCols.has(ck) || deepEqual(origRows[idx][ck], row[ck])) continue;
          lines.push(`${rowName(origRows[idx], itemProps, idx)} ${labelOf(ck, cp)} ${show(origRows[idx][ck])}→${show(row[ck])}`);
        }
      }
      origRows.forEach((row, idx) => {
        if (!kept.has(idx)) lines.push(`移除 ${rowName(row, itemProps, idx)}`);
      });
      continue;
    }
    if (locked.has(key) || isLockedProp(s) || deepEqual(before, after)) continue;
    lines.push(`${labelOf(key, s)} ${show(before)}→${show(after)}`);
  }
  return lines;
}
