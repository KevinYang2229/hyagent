import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReplenishmentOrder } from '@/api/types';
import { OrdersView } from './OrdersView';

const orders: ReplenishmentOrder[] = [
  {
    id: 'R-0002', createdAt: '2026-10-04T07:17:00.000Z', arrivalDate: '2026-10-05', itemCount: 3, summary: '鮭魚御飯糰、三明治－火腿蛋…',
    items: [
      { productId: 'P001', name: '鮭魚御飯糰', quantity: 24 },
      { productId: 'P005', name: '三明治－火腿蛋', quantity: 20 },
      { productId: 'P007', name: '沙拉－和風雞肉', quantity: 18 },
    ],
  },
];

describe('OrdersView', () => {
  it('列出補貨單，點開看明細', async () => {
    await render(<OrdersView orders={orders} loading={false} error={false} onRetry={jest.fn()} wide />);
    expect(screen.getByText('R-0002')).toBeTruthy();
    expect(screen.getByText('鮭魚御飯糰、三明治－火腿蛋…')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('補貨單 R-0002'));
    expect(screen.getByText('沙拉－和風雞肉')).toBeTruthy();
    expect(screen.getByText('18 個')).toBeTruthy();
  });

  it('沒有補貨單 → 空狀態說明', async () => {
    await render(<OrdersView orders={[]} loading={false} error={false} onRetry={jest.fn()} wide={false} />);
    expect(screen.getByText('還沒有補貨單')).toBeTruthy();
  });

  it('失敗 → 重試', async () => {
    const onRetry = jest.fn();
    await render(<OrdersView loading={false} error onRetry={onRetry} wide />);
    await fireEvent.press(screen.getByLabelText('重試'));
    expect(onRetry).toHaveBeenCalled();
  });
});
