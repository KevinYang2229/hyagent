import { fireEvent, render, screen } from '@testing-library/react-native';
import { TodayPanel } from './TodayPanel';
import { summaryCards } from './summaryCards';

const cards = summaryCards({
  lowStock: { count: 3, names: ['鮭魚御飯糰'] },
  expiring: { count: 2, names: [] },
  equipmentAlerts: { count: 1, items: [{ name: '咖啡機', issue: '紅燈閃爍' }] },
  replenishmentsToday: { count: 0 },
});

describe('TodayPanel', () => {
  it('顯示數量並可點擊', async () => {
    const onPress = jest.fn();
    await render(<TodayPanel cards={cards} loading={false} error={false} onRetry={jest.fn()} onPress={onPress} dateLabel="10/4（日）" />);
    expect(screen.getByText('今日重點')).toBeTruthy();
    expect(screen.getByText('3 項')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('商品庫存偏低 3 項'));
    expect(onPress).toHaveBeenCalledWith(cards[0]);
  });

  it('取資料失敗 → 顯示暫時無法取得與重試', async () => {
    const onRetry = jest.fn();
    await render(<TodayPanel loading={false} error onRetry={onRetry} onPress={jest.fn()} dateLabel="10/4（日）" />);
    expect(screen.getByText('暫時無法取得')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('重試'));
    expect(onRetry).toHaveBeenCalled();
  });
});
