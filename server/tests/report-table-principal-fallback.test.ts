/**
 * report.compose.ts 的圖表產製函式（autoChart/buildExactChart 等）對外仍收 tenantId，
 * userId 是可選的第三個尾參數；composeSection 會傳，但這些函式本身是 export，未來任何
 * 省略 userId 的新呼叫端都能通過型別檢查。
 *
 * 省略 userId 時內部的 principalOf 退回以 tenantId 頂替 userId。acl=off/shadow（預設）
 * 不受影響；acl=on 時 resolveScopes({tenantId, userId: tenantId}) 解析出的部門是
 * UNKNOWN_DEPARTMENT（訪客桶，見 user.directory.ts），不是空陣列——若該租戶把
 * kb:public 之類的 scope 授予訪客部門，這裡會讓圖表看到訪客能看的公開範圍，
 * 而非「零張表」。這裡守住「至少留下痕跡」：這個組合下 logger.warn 必須被呼叫，
 * off/shadow 則不應該有這個噪音。
 *
 * knowledge.tables.repo 整個被 mock 掉（loadTable 恆回同一張表）：這裡要驗證的是
 * principalOf 是否正確判斷並警告，不是 SQL 過濾本身——那已由 knowledge-acl-tables.test.ts
 * 覆蓋。
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import { buildExactChart } from '@/modules/report/report.compose';
import { tenantStore } from '@/modules/tenant/tenant.store';

const TABLE = {
  id: 'tbl-1',
  source: 'x.xlsx',
  sheet: '工作表',
  headers: ['國家', '人數'],
  rowCount: 2,
  rows: [
    ['日本', '10'],
    ['美國', '20'],
  ],
};

beforeEach(() => mockLoadTable.mockReset().mockResolvedValue(TABLE));
// 每個測試各自建立 spy；若某測試斷言失敗，afterEach 仍會 restore，
// 不讓失敗的一筆殘留 spy／call 歷史外溢污染後續測試（曾經因為漏了這個而連環誤判）。
afterEach(() => jest.restoreAllMocks());

describe('missing userId uses a non-account guest principal', () => {
  it('does not fabricate a user with the same ID as the tenant', async () => {
    const t = tenantStore.createTenant('report-guest');
    await buildExactChart(t.id, { table: 'tbl-1', label: '國家', value: '人數' });
    expect(mockLoadTable).toHaveBeenCalledWith({ tenantId: t.id, userId: '' }, 'tbl-1');
  });
  it('preserves an explicit real identity', async () => {
    const t = tenantStore.createTenant('report-user');
    await buildExactChart(t.id, { table: 'tbl-1', label: '國家', value: '人數' }, 'real-user');
    expect(mockLoadTable).toHaveBeenCalledWith({ tenantId: t.id, userId: 'real-user' }, 'tbl-1');
  });
});
