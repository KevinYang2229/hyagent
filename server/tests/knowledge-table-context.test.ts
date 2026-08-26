const listTableCatalog = jest.fn();
const loadTable = jest.fn();

jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: (...args: unknown[]) => listTableCatalog(...args),
  loadTable: (...args: unknown[]) => loadTable(...args),
  searchTableCatalog: jest.fn().mockResolvedValue([]),
}));

import { loadTableContext } from '@/modules/knowledge/knowledge.agent-service';

describe('知識庫問答的多年度表格內容', () => {
  it('將兩個展覽最近三年全數送入回答脈絡', async () => {
    const entries = ['CC', 'TM'].flatMap((show) => [2023, 2024, 2025].map((year) => ({
      id: `${show}-${year}`,
      source: 'exhibitions.xlsx',
      sheet: `${show}-參展商家數`,
      caption: `展覽年度:${year}`,
      headers: ['年度', '參展總家數'],
      rowCount: 1,
    })));
    listTableCatalog.mockResolvedValue(entries);
    loadTable.mockImplementation(async (_principal: unknown, id: string) => {
      const entry = entries.find((item) => item.id === id);
      return entry ? { ...entry, rows: [[id.slice(-4), id]] } : null;
    });

    const context = await loadTableContext(
      { tenantId: 'tenant', userId: 'user' },
      '臺北國際自行車展與工具機展最近三年參展商家數',
    );

    for (const show of ['CC', 'TM']) {
      for (const year of [2023, 2024, 2025]) expect(context).toContain(`${show}-${year}`);
    }
  });
});
