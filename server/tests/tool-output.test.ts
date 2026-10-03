import { isToolOutput, toolOutput, unwrapToolOutput } from '@/modules/tools';

describe('ToolOutput', () => {
  it('包裝與拆包', () => {
    const o = toolOutput({ a: 1 }, { type: 'table' });
    expect(isToolOutput(o)).toBe(true);
    expect(unwrapToolOutput(o)).toEqual({ data: { a: 1 }, display: { type: 'table' } });
  });

  it('一般值不是 ToolOutput，拆包後 data 就是原值', () => {
    expect(isToolOutput({ data: 1, display: 2 })).toBe(false);
    expect(unwrapToolOutput({ data: 1 })).toEqual({ data: { data: 1 } });
    expect(unwrapToolOutput(undefined)).toEqual({ data: undefined });
  });

  it('JSON 序列化時不洩漏品牌', () => {
    expect(JSON.stringify(toolOutput(1))).toBe('{"data":1}');
  });
});
