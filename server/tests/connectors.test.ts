/**
 * getConnector：連接器工廠的統一入口（Phase 0 只認 'oa'）。
 */
import { getConnector } from '@/lib/connectors';

describe('getConnector', () => {
  it("getConnector('oa') 回傳具 submitForm 的 OA 連接器", () => {
    const oa = getConnector('oa');
    expect(typeof oa.submitForm).toBe('function');
    expect(typeof oa.name).toBe('string');
  });

  it('未知連接器名稱丟錯', () => {
    // @ts-expect-error 故意傳未支援名稱
    expect(() => getConnector('nope')).toThrow(/unknown connector/);
  });
});
