import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { PendingActionView } from '@hyagent/shared';
import { FIELDS } from './fixtures';
import { ConfirmModal } from './ConfirmModal';

const NOW = Date.parse('2026-10-04T02:00:00.000Z');
const action: PendingActionView = {
  id: 'a1',
  summary: { title: '建立補貨單', fields: [] },
  form: { title: '建立補貨單', fields: FIELDS.slice(0, 2) },
  expiresAt: '2026-10-04T03:00:00.000Z',
};

describe('ConfirmModal', () => {
  it('改數量、取消一列後確認 → 送出修改後的內容', async () => {
    const onConfirm = jest.fn().mockResolvedValue({ kind: 'done', ok: true });
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} now={NOW} />);
    expect(screen.getByText('我已準備好建立補貨單！')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('鮭魚御飯糰 建議補貨數量'), '36');
    await fireEvent.press(screen.getByLabelText('選取 明太子御飯糰'));
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(onConfirm).toHaveBeenCalledWith({
      items: [{ productId: 'P001', image: 'https://s/P001.png', name: '鮭魚御飯糰', stock: 6, quantity: 36 }],
      arrivalDate: '2026-10-05',
    });
  });

  it('沒改 → 不帶內容確認', async () => {
    const onConfirm = jest.fn().mockResolvedValue({ kind: 'done', ok: true });
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} now={NOW} />);
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('連點兩下確認只送一次', async () => {
    let release!: (v: unknown) => void;
    const onConfirm = jest.fn(() => new Promise((r) => { release = r; }));
    await render(<ConfirmModal action={action} onConfirm={onConfirm as never} onCancel={jest.fn()} now={NOW} />);
    // 直接觸發 Pressable 的 onPress（fireEvent 會等 handler 的 promise，而 onConfirm 此時刻意未 resolve）
    const press = () => screen.getByLabelText('確認建立補貨單').props.onClick({});
    await act(async () => {
      press();
      press();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('422 → 顯示錯誤、可修正後再送', async () => {
    const onConfirm = jest.fn().mockResolvedValueOnce({ kind: 'invalid', message: '數量超出範圍' }).mockResolvedValueOnce({ kind: 'done', ok: true });
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} now={NOW} />);
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(screen.getByText('數量超出範圍')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('onConfirm 丟出例外 → 顯示錯誤、彈窗恢復可再送', async () => {
    const onConfirm = jest.fn().mockRejectedValueOnce(new Error('網路中斷')).mockResolvedValueOnce({ kind: 'done', ok: true });
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} now={NOW} />);
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(screen.getByText('網路中斷')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('開著彈窗時逾時 → 按確認顯示逾時、不呼叫 API', async () => {
    const onConfirm = jest.fn();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} />);
    expect(screen.queryByText('這個動作已逾時，請重新提出。')).toBeNull();
    spy.mockReturnValue(Date.parse('2026-10-04T04:00:00.000Z'));
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    spy.mockRestore();
    expect(screen.getByText('這個動作已逾時，請重新提出。')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('本地檢查不通過 → 顯示原因、不呼叫 API', async () => {
    const onConfirm = jest.fn();
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} now={NOW} />);
    await fireEvent.changeText(screen.getByLabelText('鮭魚御飯糰 建議補貨數量'), '0');
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(screen.getByText('鮭魚御飯糰 的建議補貨數量需介於 1–200')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('全部取消勾選 → 確認鈕停用', async () => {
    const onConfirm = jest.fn();
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={jest.fn()} now={NOW} />);
    await fireEvent.press(screen.getByLabelText('全選'));
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('已過期 → 顯示逾時、確認鈕不能按，關閉會呼叫 onCancel', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn().mockResolvedValue(undefined);
    await render(<ConfirmModal action={action} onConfirm={onConfirm} onCancel={onCancel} now={Date.parse('2026-10-04T04:00:00.000Z')} />);
    expect(screen.getByText('這個動作已逾時，請重新提出。')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByLabelText('確認建立補貨單')); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { await fireEvent.press(screen.getByLabelText('取消')); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('沒有 action → 不顯示', async () => {
    await render(<ConfirmModal action={null} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.queryByText('取消')).toBeNull();
  });
});
