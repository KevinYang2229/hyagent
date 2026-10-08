import { render, screen } from '@testing-library/react-native';
import { TableBlockView } from './TableBlockView';

it('畫出標題、欄名與格式化後的儲存格', async () => {
  await render(
    <TableBlockView
      block={{
        type: 'table',
        title: '商品庫存',
        columns: [
          { key: 'name', label: '商品名稱', image: 'image' },
          { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
          { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger' } },
        ],
        rows: [
          { name: '鮭魚御飯糰', image: 'https://s/P001.png', suggested: 24, status: '庫存偏低' },
          { name: '鮪魚御飯糰', image: null, suggested: 0, status: '正常' },
        ],
      }}
    />,
  );
  expect(screen.getByText('商品庫存')).toBeTruthy();
  expect(screen.getByText('建議補貨')).toBeTruthy();
  expect(screen.getByText('+24 個')).toBeTruthy();
  expect(screen.getByText('–')).toBeTruthy();
  expect(screen.getByText('庫存偏低')).toBeTruthy();
});
