import { act, render, screen } from '@testing-library/react-native';
import { LaunchView, LAUNCH_ICON_MS } from './LaunchView';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('先顯示 App icon，再進入轉導頁且只進入一次', async () => {
  const onDone = jest.fn();
  await render(<LaunchView onDone={onDone} />);
  expect(screen.getByLabelText('SpaceMe App 圖示')).toBeTruthy();
  await act(() => { jest.advanceTimersByTime(LAUNCH_ICON_MS - 1); });
  expect(onDone).not.toHaveBeenCalled();
  await act(() => { jest.advanceTimersByTime(1); });
  expect(onDone).toHaveBeenCalledTimes(1);
  await act(() => { jest.advanceTimersByTime(LAUNCH_ICON_MS); });
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('離開啟動畫面後不再觸發轉導', async () => {
  const onDone = jest.fn();
  const view = await render(<LaunchView onDone={onDone} />);
  await view.unmount();
  await act(() => { jest.advanceTimersByTime(LAUNCH_ICON_MS); });
  expect(onDone).not.toHaveBeenCalled();
});
