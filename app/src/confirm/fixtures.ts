import type { ConfirmField } from '@hyagent/shared';

export const FIELDS: ConfirmField[] = [
  {
    kind: 'table', key: 'items', label: '補貨品項', selectable: true,
    columns: [
      { key: 'name', label: '商品名稱', kind: 'text', editable: false, image: 'image' },
      { key: 'stock', label: '目前庫存', kind: 'number', editable: false, unit: '個' },
      { key: 'quantity', label: '建議補貨數量', kind: 'number', editable: true, unit: '個', min: 1, max: 200 },
    ],
    rows: [
      { productId: 'P001', image: 'https://s/P001.png', name: '鮭魚御飯糰', stock: 6, quantity: 24 },
      { productId: 'P003', name: '明太子御飯糰', stock: 3, quantity: 24 },
    ],
  },
  { kind: 'date', key: 'arrivalDate', label: '預計到貨日期', value: '2026-10-05', editable: true },
  { kind: 'text', key: 'note', label: '備註', value: '<b>x</b>', editable: false },
];
