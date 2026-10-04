import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ShelfResult } from '@/api/types';
import { ShelfResultView } from './ShelfResultView';

const photo = { uri: 'file:///p.jpg', width: 1600, height: 1200 };
const result: ShelfResult = {
  mode: 'shelf',
  findings: [
    { name: '鮭魚御飯糰', status: 'out_of_stock', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, suggestedQty: 24 },
    { name: '沙拉－和風雞肉', status: 'expiring', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, expiryDate: '2026-10-05' },
    { name: '關東煮－蘿蔔', status: 'misplaced', box: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } },
    { name: '鮪魚御飯糰', status: 'ok', box: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } },
  ],
  counts: { outOfStock: 1, expiring: 1, misplaced: 1 },
  replenishment: { toolId: 'mcp.store-demo.replenishment_create', input: { items: [{ productId: 'P001' }] } },
};

describe('ShelfResultView', () => {
  it('顯示需處理數與分組，按建立補貨單呼叫 onCreate', async () => {
    const onCreate = jest.fn().mockResolvedValue(undefined);
    await render(<ShelfResultView photo={photo} result={result} today="2026-10-04" wide creating={false} error={null} onRetake={jest.fn()} onCreate={onCreate} />);
    expect(screen.getByText('我看到 3 個需要處理的項目：')).toBeTruthy();
    expect(screen.getByText('缺貨（1）')).toBeTruthy();
    expect(screen.getByText('即期品（1）')).toBeTruthy();
    expect(screen.getByText('擺放錯誤（1）')).toBeTruthy();
    expect(screen.getByText('有效期限：2026/10/05（剩 1 天）')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('建立補貨單（1 項）')); });
    expect(onCreate).toHaveBeenCalled();
  });

  it('沒有補貨提議 → 按鈕停用', async () => {
    const onCreate = jest.fn();
    await render(<ShelfResultView photo={photo} result={{ ...result, replenishment: undefined }} today="2026-10-04" wide={false} creating={false} error={null} onRetake={jest.fn()} onCreate={onCreate} />);
    await act(async () => { fireEvent.press(screen.getByLabelText('建立補貨單（0 項）')); });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('全部正常 → 顯示沒有需要處理的項目', async () => {
    await render(<ShelfResultView photo={photo} result={{ ...result, findings: [result.findings[3]], replenishment: undefined }} today="2026-10-04" wide creating={false} error={null} onRetake={jest.fn()} onCreate={jest.fn()} />);
    expect(screen.getByText('這排貨架看起來都沒問題！')).toBeTruthy();
  });

  it('同一個 tick 連按兩次建立補貨單，只呼叫一次 onCreate', async () => {
    let finish: () => void = () => {};
    const onCreate = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(<ShelfResultView photo={photo} result={result} today="2026-10-04" wide creating={false} error={null} onRetake={jest.fn()} onCreate={onCreate} />);
    const btn = screen.getByLabelText('建立補貨單（1 項）');
    await act(async () => {
      // 直接在同一個 tick 內觸發兩次 onPress（fireEvent 在 v14 各自包 act，不能重疊）
      const onPress = btn.props.onClick ?? btn.props.onPress;
      onPress({ nativeEvent: {}, stopPropagation() {}, preventDefault() {} });
      onPress({ nativeEvent: {}, stopPropagation() {}, preventDefault() {} });
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await act(async () => { fireEvent.press(btn); });
    expect(onCreate).toHaveBeenCalledTimes(2);
    await act(async () => { finish(); });
  });
});
