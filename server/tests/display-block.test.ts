/** 顯示提示 → 表格區塊：合法解析、限制、壞輸入一律不產生區塊或該格為 null。 */
import { buildDisplayBlock, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from '@/modules/display/display-block';

const display = {
  type: 'table',
  title: '御飯糰庫存',
  rows: 'items',
  columns: [
    { key: 'name', label: '商品名稱', image: 'image' },
    { key: 'stock', label: '目前庫存', unit: '個' },
    { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
    { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success', 怪: 'rainbow' } },
  ],
};
const data = {
  items: [
    { name: '鮭魚御飯糰', image: 'https://cdn.example.com/a.png', stock: 6, suggested: 24, status: '庫存偏低' },
    { name: '鮪魚', image: 'javascript:alert(1)', stock: 12, suggested: 0, status: '正常', extra: 'x' },
  ],
};

describe('buildDisplayBlock', () => {
  it('合法 → 表格區塊；只保留欄位與圖片鍵；不合法色調被丟掉', () => {
    const b = buildDisplayBlock(display, data)!;
    expect(b.type).toBe('table');
    expect(b.title).toBe('御飯糰庫存');
    expect(b.columns.map((c) => c.key)).toEqual(['name', 'stock', 'suggested', 'status']);
    expect(b.columns[3].badge).toEqual({ 庫存偏低: 'danger', 正常: 'success' });
    expect(b.rows[0]).toEqual({ name: '鮭魚御飯糰', image: 'https://cdn.example.com/a.png', stock: 6, suggested: 24, status: '庫存偏低' });
    expect(b.rows[1].image).toBeNull(); // 非 http(s) 的圖片網址
    expect(b.rows[1]).not.toHaveProperty('extra');
  });

  it('巢狀物件與布林值 → 該格 null，表格照常產生', () => {
    const b = buildDisplayBlock(
      { type: 'table', rows: 'items', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      { items: [{ a: { nested: 1 }, b: true }] },
    )!;
    expect(b.rows).toEqual([{ a: null, b: null }]);
  });

  it('超過列數上限只取前 50 列', () => {
    const items = Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, i) => ({ n: i }));
    const b = buildDisplayBlock({ type: 'table', rows: 'items', columns: [{ key: 'n', label: 'N' }] }, { items })!;
    expect(b.rows).toHaveLength(MAX_TABLE_ROWS);
  });

  it.each([
    ['非物件', 'table'],
    ['type 不是 table', { ...display, type: 'chart' }],
    ['rows 指向不存在的屬性', { ...display, rows: 'nope' }],
    ['rows 指向非陣列', { ...display, rows: 'title' }],
    ['沒有欄位', { ...display, columns: [] }],
    ['欄位過多', { ...display, columns: Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, i) => ({ key: `k${i}`, label: 'x' })) }],
    ['欄位缺 label', { ...display, columns: [{ key: 'name' }] }],
  ])('%s → undefined', (_name, d) => {
    expect(buildDisplayBlock(d, { ...data, title: 'x' })).toBeUndefined();
  });

  it('format 不合法 → 視為 text；未給 → 不出現', () => {
    const b = buildDisplayBlock({ type: 'table', rows: 'items', columns: [{ key: 'n', label: 'N', format: 'weird' }] }, { items: [{ n: 1 }] })!;
    expect(b.columns[0].format).toBe('text');
  });

  it('資料不是物件 → undefined', () => {
    expect(buildDisplayBlock(display, 'text result')).toBeUndefined();
  });
});
