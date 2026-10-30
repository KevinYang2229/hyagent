import { describe, expect, it } from 'vitest';
import { redactPlan } from '../src/audit';

describe('redactPlan', () => {
  it('保留結構（資料表、欄位、運算子、聚合、排序、筆數），比較值只記型別', () => {
    const plan = {
      version: '1.0',
      data_source_id: 'ds1',
      dataset: 'customers',
      joins: [{ dataset: 'orders', type: 'left' }],
      select: [{ field: 'name' }, { field: 'amount', agg: 'sum', alias: 'total' }],
      filters: [
        { field: 'id_no', op: 'eq', value: 'A123456789' },
        { field: 'amount', op: 'gt', value: 50000 },
        { field: 'region', op: 'in', value: ['北區', '中區', '南區'] },
      ],
      group_by: [{ field: 'name' }],
      order_by: [{ field: 'total', direction: 'desc' }],
      limit: 20,
    };
    const r = redactPlan(plan);
    expect(r).toEqual({
      ...plan,
      filters: [
        { field: 'id_no', op: 'eq', value: '<文字>' },
        { field: 'amount', op: 'gt', value: '<數字>' },
        { field: 'region', op: 'in', value: '<3 個值>' },
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/A123456789|50000|北區/);
  });

  it('格式外的內容一律遮蔽：未知鍵的文字、數字都變成 ?', () => {
    const r = redactPlan({ dataset: 'x', sql: 'SELECT * FROM salary', tenant_id: 'other', note: { secret: 'p@ss', n: 42 }, limit: 10 });
    expect(r).toEqual({ dataset: 'x', sql: '?', tenant_id: '?', note: { secret: '?', n: '?' }, limit: 10 });
  });

  it('不是物件也能處理；過長、過深、過大都截斷', () => {
    expect(redactPlan('DROP TABLE x')).toBe('?');
    expect(redactPlan(null)).toBe('?');
    expect(redactPlan({ field: 'x'.repeat(100) })).toEqual({ field: `${'x'.repeat(64)}…` });
    const deep = redactPlan({ a: { a: { a: { a: { a: { a: { a: { a: 1 } } } } } } } });
    expect(JSON.stringify(deep)).toContain('…');
    const big = redactPlan({ select: Array.from({ length: 30 }, (_, i) => ({ field: `f${i}`.padEnd(60, 'x'), alias: 'a'.repeat(60) })) });
    expect(big).toMatchObject({ truncated: true });
  });
});
