import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReplenishmentOrder, StoreTodaySummary } from '@/api/storeTypes';
import { TaskCenterView } from './TaskCenterView';
import { storeTasks, filterTasks } from './taskCenter';

const summary: StoreTodaySummary = { lowStock: { count: 3, names: ['鮭魚御飯糰'] }, expiring: { count: 2, names: ['鮮奶'] }, equipmentAlerts: { count: 1, items: [{ name: '咖啡機', issue: '無法出水' }] }, replenishmentsToday: { count: 2 } };
const order: ReplenishmentOrder = { id: 'R001', createdAt: '2026-10-05T01:00:00Z', arrivalDate: '2026-10-06', summary: '補貨鮭魚御飯糰', itemCount: 1, items: [{ productId: 'P001', name: '鮭魚御飯糰', quantity: 24 }] };
const defaults = { summary, orders: [order], summaryLoading: false, ordersLoading: false, summaryError: false, ordersError: false, dateLabel: '10/5（一）', onRetry: jest.fn(), onAsk: jest.fn() };

describe('任務中心', () => {
  it('摘要只提供部分商品名稱時不虛構額外任務或完成狀態', () => {
    const tasks = storeTasks(summary, [order]);
    expect(tasks).toHaveLength(4);
    expect(filterTasks(tasks, 'submitted', null).map((task) => task.order?.id)).toEqual(['R001']);
    expect(filterTasks(tasks, 'pending', 'stock').map((task) => task.title)).toEqual(['鮭魚御飯糰']);
    expect(storeTasks({ ...summary, lowStock: { count: 3, names: [] } })[0].question).toBe('哪些商品庫存偏低？');
  });
  it('待處理任務可帶入 AI 處理', async () => {
    const onAsk = jest.fn();
    await render(<TaskCenterView {...defaults} onAsk={onAsk} />);
    await fireEvent.press(screen.getByLabelText('待處理任務'));
    expect(screen.queryByLabelText('補貨單 R001')).toBeNull();
    await fireEvent.press(screen.getByLabelText('處理 鮭魚御飯糰'));
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('建議補貨數量'));
  });
  it('已送出篩選仍可開啟補貨單明細', async () => {
    await render(<TaskCenterView {...defaults} />);
    await fireEvent.press(screen.getByLabelText('已送出任務'));
    expect(screen.queryByLabelText('處理 鮮奶')).toBeNull();
    await fireEvent.press(screen.getByLabelText('補貨單 R001'));
    expect(screen.getByText('24 個')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('關閉明細'));
    expect(screen.queryByText('24 個')).toBeNull();
  });
  it('摘要失敗仍顯示補貨單並可重試', async () => {
    const onRetry = jest.fn();
    await render(<TaskCenterView {...defaults} summary={undefined} summaryError onRetry={onRetry} />);
    expect(screen.getByLabelText('補貨單 R001')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('重試任務資料'));
    expect(onRetry).toHaveBeenCalled();
  });
  it('沒有資料顯示空狀態', async () => {
    await render(<TaskCenterView {...defaults} summary={undefined} orders={[]} />);
    expect(screen.getByText('目前沒有待處理事項或補貨單')).toBeTruthy();
  });
});
