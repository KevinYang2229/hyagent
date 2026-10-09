import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { IntroView, MIN_INTRO_MS } from './IntroView';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('動畫播完且已連上才進首頁，只呼叫一次', async () => {
  const onDone = jest.fn();
  const view = await render(<IntroView connected={false} error={null} serverUrl="http://h" onRetry={jest.fn()} onDone={onDone} />);
  expect(screen.getByText('正在為你連線 HyAgent')).toBeTruthy();

  await act(() => { jest.advanceTimersByTime(MIN_INTRO_MS); });
  expect(onDone).not.toHaveBeenCalled();

  await view.rerender(<IntroView connected error={null} serverUrl="http://h" onRetry={jest.fn()} onDone={onDone} />);
  expect(onDone).toHaveBeenCalledTimes(1);
  await view.rerender(<IntroView connected error={null} serverUrl="http://h" onRetry={jest.fn()} onDone={onDone} />);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('很快就連上也要等動畫播完', async () => {
  const onDone = jest.fn();
  await render(<IntroView connected error={null} serverUrl="http://h" onRetry={jest.fn()} onDone={onDone} />);
  expect(onDone).not.toHaveBeenCalled();
  await act(() => { jest.advanceTimersByTime(MIN_INTRO_MS); });
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('連線失敗顯示原因，可改伺服器位址後重新連線', async () => {
  const onRetry = jest.fn();
  await render(<IntroView connected={false} error="無法連線到伺服器，請檢查網路" serverUrl="http://old" onRetry={onRetry} onDone={jest.fn()} />);
  expect(screen.getByText('無法連線到伺服器，請檢查網路')).toBeTruthy();

  await fireEvent.press(screen.getByText('伺服器設定'));
  await fireEvent.changeText(screen.getByLabelText('伺服器位址'), 'http://new');
  await fireEvent.press(screen.getByText('重新連線'));
  expect(onRetry).toHaveBeenCalledWith('http://new');
});
