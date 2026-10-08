import { fireEvent, render, screen } from '@testing-library/react-native';
import { CouponResultView } from './CouponResultView';

describe('CouponResultView', () => {
  it('可使用：顯示狀態與細節，可問 AI', async () => {
    const onAskAi = jest.fn();
    await render(
      <CouponResultView
        view={{ code: 'COFFEE50', title: '咖啡折 5 元', status: 'valid', reason: '可使用', applicableTo: '咖啡', validPeriod: '2026-09-29 ~ 2026-10-14', conditions: '限中杯以上' }}
        wide onRetake={jest.fn()} onBarcode={jest.fn()} onAskAi={onAskAi}
      />,
    );
    expect(screen.getByText('這張優惠券可以使用！')).toBeTruthy();
    expect(screen.getByText('可使用')).toBeTruthy();
    expect(screen.getByText('限中杯以上')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('問 AI 這張券的細節'));
    expect(onAskAi).toHaveBeenCalled();
  });

  it('讀不到券號：提示改用掃條碼，問 AI 停用', async () => {
    const onBarcode = jest.fn();
    const onAskAi = jest.fn();
    await render(<CouponResultView view={{ status: 'unknown', reason: '讀不到券號' }} wide={false} onRetake={jest.fn()} onBarcode={onBarcode} onAskAi={onAskAi} />);
    await fireEvent.press(screen.getByLabelText('改用掃條碼'));
    expect(onBarcode).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('問 AI 這張券的細節'));
    expect(onAskAi).not.toHaveBeenCalled();
  });
});
