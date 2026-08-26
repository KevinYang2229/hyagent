/**
 * report.compose.ts 的圖表產製函式（autoChart/buildExactChart 等）對外仍收 tenantId，
 * userId 是可選的第三個尾參數；composeSection 會傳，但這些函式本身是 export，未來任何
 * 省略 userId 的新呼叫端都能通過型別檢查。
 *
 * 省略 userId 時內部的 principalOf 退回以 tenantId 頂替 userId。acl=off/shadow（預設）
 * 不受影響；acl=on 時 resolveScopes(tenantId, tenantId) 幾乎必解析成 []，SQL 的
 * `visibility_scopes && ARRAY[]::text[]` 對任何列都是 NULL/false——不是「只看不受限的
 * 表」，是看到零張表，且沒有任何錯誤——圖表全部靜默消失。這裡守住「至少留下痕跡」：
 * 這個組合下 logger.warn 必須被呼叫，off/shadow 則不應該有這個噪音。
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

import { logger } from '@/lib/logger';
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

describe('省略 userId 時的 principal 退化', () => {
  it('acl=on 且未傳 userId：warn 被呼叫，訊息點出可見範圍解析為空、圖表會消失', async () => {
    const t = tenantStore.createTenant('report-principal-fallback-on');
    tenantStore.updateTenant(t.id, { knowledgeAcl: 'on' });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await buildExactChart(t.id, { table: 'tbl-1', label: '國家', value: '人數' });

    expect(warnSpy).toHaveBeenCalled();
    const [meta, msg] = warnSpy.mock.calls[warnSpy.mock.calls.length - 1] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta).toMatchObject({ tenantId: t.id });
    expect(msg).toMatch(/empty/);
    expect(msg).toMatch(/charts drop|全部/i);

    warnSpy.mockRestore();
  });

  it('acl=off（預設）且未傳 userId：不 warn——既有呼叫端不該被噪音淹沒', async () => {
    const t = tenantStore.createTenant('report-principal-fallback-off');
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await buildExactChart(t.id, { table: 'tbl-1', label: '國家', value: '人數' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('acl=on 但有傳 userId：不 warn——這是正常的生產路徑', async () => {
    const t = tenantStore.createTenant('report-principal-fallback-with-user');
    tenantStore.updateTenant(t.id, { knowledgeAcl: 'on' });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await buildExactChart(t.id, { table: 'tbl-1', label: '國家', value: '人數' }, 'real-user');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
