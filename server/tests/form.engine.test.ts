/**
 * form.engine 單元測試：型別 coerce、欄位驗證、不可變 setField、slot 狀態、整表驗證。
 * 用真實的 leave-request Definition（getDefinition 讀 schemas/）確保與線上行為一致。
 */
import {
  coerceValue,
  computeStatus,
  setField,
  validateAll,
  validateField,
} from '@/modules/form/form.engine';
import { getDefinition } from '@/modules/form/form.registry';

const def = getDefinition('default', 'leave-request');
const tripDef = getDefinition('default', 'business-trip-domestic');

/** 一份通過所有必填與商規的完整請假值 */
function fullLeave() {
  return {
    applicant: '王小明',
    deputy: '李小華',
    leaveType: 'annual',
    startDate: '2026-06-02',
    startTime: '09:00',
    endDate: '2026-06-03',
    endTime: '18:00',
    reason: '家裡有事',
  };
}

describe('coerceValue', () => {
  it('數字字串轉為 number', () => {
    expect(coerceValue({ type: 'number' }, '42')).toBe(42);
    expect(coerceValue({ type: 'integer' }, '7')).toBe(7);
  });

  it('非數字字串保持原樣（交由驗證擋下）', () => {
    expect(coerceValue({ type: 'number' }, 'abc')).toBe('abc');
  });

  it('布林字串轉為 boolean', () => {
    expect(coerceValue({ type: 'boolean' }, 'true')).toBe(true);
    expect(coerceValue({ type: 'boolean' }, 'false')).toBe(false);
  });

  it('無 prop 或 null/undefined 原樣回傳', () => {
    expect(coerceValue(undefined, '5')).toBe('5');
    expect(coerceValue({ type: 'number' }, null)).toBeNull();
    expect(coerceValue({ type: 'number' }, undefined)).toBeUndefined();
  });
});

describe('validateField', () => {
  it('合法 enum 值通過', () => {
    expect(validateField(def, 'leaveType', 'annual')).toBeNull();
  });

  it('非法 enum 值回 issue', () => {
    const issue = validateField(def, 'leaveType', 'not-a-type');
    expect(issue).not.toBeNull();
    expect(issue?.field).toBe('leaveType');
  });

  it('未知欄位回 issue', () => {
    expect(validateField(def, 'nope', 'x')?.field).toBe('nope');
  });
});

describe('setField', () => {
  it('合法值寫入新 values，且不改動原物件（不可變）', () => {
    const values = {};
    const r = setField(def, values, 'leaveType', 'annual');
    expect(r.issue).toBeUndefined();
    expect(r.values).toEqual({ leaveType: 'annual' });
    expect(values).toEqual({});
  });

  it('非法值回 issue 且 values 不變（回傳同一參考）', () => {
    const values = { leaveType: 'annual' };
    const r = setField(def, values, 'leaveType', 'bogus');
    expect(r.issue).toBeDefined();
    expect(r.values).toBe(values);
  });

  it('coerce 後存入（數字字串 → number）', () => {
    // business-trip 的 taxiFee 為 number；setField 應 coerce 後存入
    const r = setField(tripDef, {}, 'taxiFee', '350');
    expect(r.issue).toBeUndefined();
    expect(r.values.taxiFee).toBe(350);
  });
});

describe('computeStatus', () => {
  it('空表單列出必填為 missing 且未完成', () => {
    const s = computeStatus(def, {});
    expect(s.isComplete).toBe(false);
    expect(s.missing).toEqual(
      expect.arrayContaining(['applicant', 'leaveType', 'startDate', 'reason']),
    );
  });

  it('跨欄商規：endDate < startDate 觸發 invalid', () => {
    const s = computeStatus(def, { startDate: '2026-06-02', endDate: '2026-06-01' });
    expect(s.invalid.some((i) => i.message.includes('結束日期不可早於開始日期'))).toBe(true);
  });

  it('任一比較欄位缺值時不評跨欄商規（屬 missing 範疇）', () => {
    const s = computeStatus(def, { startDate: '2026-06-02' }); // endDate 缺
    expect(s.invalid).toHaveLength(0);
  });

  it('補齊全部必填且合法 → isComplete', () => {
    const s = computeStatus(def, fullLeave());
    expect(s.isComplete).toBe(true);
    expect(s.missing).toHaveLength(0);
    expect(s.invalid).toHaveLength(0);
  });

  // 陣列欄位（多選 MultiSelect、附件 Upload）給空陣列等同沒填，否則必填形同虛設
  it('必填的陣列欄位給空陣列仍算 missing，有元素才算填了', () => {
    const arrayDef = {
      formId: 'array-form',
      data: {
        type: 'object',
        properties: { products: { type: 'array', items: { type: 'string' } } },
      },
      field: { products: { component: 'MultiSelect', label: '有興趣項目' } },
      validation: { required: ['products'] },
      agent: { intent: 'array-form', description: '多選測試' },
    } as unknown as typeof def;

    expect(computeStatus(arrayDef, { products: [] }).missing).toContain('products');
    expect(computeStatus(arrayDef, { products: ['P001'] }).missing).toHaveLength(0);
  });
});

describe('validateAll', () => {
  it('完整表單無錯', () => {
    expect(validateAll(def, fullLeave())).toHaveLength(0);
  });

  it('缺必填時回含「缺少必填欄位」的 issue', () => {
    const issues = validateAll(def, {});
    expect(issues.some((i) => i.message.includes('缺少必填欄位'))).toBe(true);
  });
});
