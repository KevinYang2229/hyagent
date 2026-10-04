import type { TableColumn } from '@hyagent/shared';
import { cellTone, formatCell, imageUri } from './tableFormat';

const stock: TableColumn = { key: 'stock', label: '庫存', unit: '個' };
const delta: TableColumn = { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' };
const status: TableColumn = { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success' } };
const name: TableColumn = { key: 'name', label: '商品', image: 'image' };

describe('formatCell', () => {
  it('一般值加單位；空值顯示 –', () => {
    expect(formatCell(stock, 6)).toBe('6 個');
    expect(formatCell(stock, null)).toBe('–');
    expect(formatCell(stock, '')).toBe('–');
    expect(formatCell(name, '鮭魚御飯糰')).toBe('鮭魚御飯糰');
  });

  it('delta：正數顯示 +N 單位，0、負數、非數字顯示 –', () => {
    expect(formatCell(delta, 24)).toBe('+24 個');
    expect(formatCell(delta, 0)).toBe('–');
    expect(formatCell(delta, -3)).toBe('–');
    expect(formatCell(delta, 'x')).toBe('–');
  });
});

describe('cellTone', () => {
  it('badge 依值取色，未列出的值為 neutral；delta 正數為 danger；其他沒有色調', () => {
    expect(cellTone(status, '庫存偏低')).toBe('danger');
    expect(cellTone(status, '其他')).toBe('neutral');
    expect(cellTone(delta, 24)).toBe('danger');
    expect(cellTone(delta, 0)).toBeNull();
    expect(cellTone(stock, 6)).toBeNull();
  });
});

describe('imageUri', () => {
  it('只接受 http(s)', () => {
    expect(imageUri({ image: 'https://s/a.png' }, name)).toBe('https://s/a.png');
    expect(imageUri({ image: 'javascript:alert(1)' }, name)).toBeNull();
    expect(imageUri({ image: 'https://s/a.png' }, stock)).toBeNull();
  });
});
