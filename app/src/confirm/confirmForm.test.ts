import {
  buildInput, coerce, dateOptions, hasEmptyTable, initialValues, isChanged, isExpired, rawOf, validateLocal,
} from './confirmForm';
import { FIELDS } from './fixtures';

describe('confirmForm', () => {
  it('沒改：buildInput 只含表格與可編輯欄位，isChanged=false', () => {
    const v = initialValues(FIELDS);
    expect(buildInput(FIELDS, v, {})).toEqual({ items: (FIELDS[0] as { rows: unknown[] }).rows, arrivalDate: '2026-10-05' });
    expect(isChanged(FIELDS, v, {})).toBe(false);
  });

  it('取消勾選一列、改數量 → 只送剩下的列，isChanged=true', () => {
    const v = initialValues(FIELDS);
    const rows = (v.items as Record<string, unknown>[]).map((r, i) => (i === 0 ? { ...r, quantity: 36 } : r));
    const input = buildInput(FIELDS, { ...v, items: rows }, { items: [1] });
    expect(input.items).toEqual([{ productId: 'P001', image: 'https://s/P001.png', name: '鮭魚御飯糰', stock: 6, quantity: 36 }]);
    expect(isChanged(FIELDS, { ...v, items: rows }, { items: [1] })).toBe(true);
  });

  it('全部取消勾選 → hasEmptyTable', () => {
    expect(hasEmptyTable(FIELDS, initialValues(FIELDS), { items: [0, 1] })).toBe(true);
    expect(hasEmptyTable(FIELDS, initialValues(FIELDS), { items: [0] })).toBe(false);
  });

  it('validateLocal：數量非數字或超出範圍回錯誤訊息（只檢查勾選中的列）', () => {
    const v = initialValues(FIELDS);
    const bad = (q: unknown) => ({ ...v, items: (v.items as Record<string, unknown>[]).map((r, i) => (i === 0 ? { ...r, quantity: q } : r)) });
    expect(validateLocal(FIELDS, v, {})).toBeNull();
    expect(validateLocal(FIELDS, bad(0), {})).toBe('鮭魚御飯糰 的建議補貨數量需介於 1–200');
    expect(validateLocal(FIELDS, bad('abc'), {})).toBe('鮭魚御飯糰 的建議補貨數量需填數字');
    expect(validateLocal(FIELDS, bad(0), { items: [0] })).toBeNull();
  });

  it('coerce / rawOf', () => {
    expect(coerce('number', '12')).toBe(12);
    expect(coerce('number', '')).toBe('');
    expect(coerce('number', 'x')).toBe('x');
    expect(coerce('text', '12')).toBe('12');
    expect(rawOf([{ value: '1', label: '一', raw: 1 }], '1')).toBe(1);
    expect(rawOf(undefined, 'a')).toBe('a');
  });

  it('isExpired', () => {
    const a = { id: 'a', summary: { title: 't', fields: [] }, expiresAt: '2026-10-04T10:00:00.000Z' };
    expect(isExpired(a, Date.parse('2026-10-04T09:59:59.000Z'))).toBe(false);
    expect(isExpired(a, Date.parse('2026-10-04T10:00:00.000Z'))).toBe(true);
  });

  it('dateOptions：從今天起 7 天，標示今天／明天；目前值不在範圍內時放第一個', () => {
    const opts = dateOptions('2026-10-04', 7);
    expect(opts).toHaveLength(7);
    expect(opts[0]).toEqual({ value: '2026-10-04', label: '2026/10/04（日）今天' });
    expect(opts[1]).toEqual({ value: '2026-10-05', label: '2026/10/05（一）明天' });
    expect(opts[6].value).toBe('2026-10-10');
    expect(dateOptions('2026-10-04', 7, '2026-10-20')[0]).toEqual({ value: '2026-10-20', label: '2026/10/20（二）' });
  });
});
