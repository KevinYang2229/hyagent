import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { CONTACT_FAQ, ContactView } from './ContactView';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 })),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/brand/Brand', () => ({ RobotAvatar: () => null }));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const channel = { kind: 'phone' as const, label: '電話', value: '(02) 1234-5678', url: 'tel:0212345678' };

afterEach(() => jest.restoreAllMocks());

it('無法開啟聯絡方式時提供複製替代操作', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('unavailable'));
  await render(<SafeAreaProvider initialMetrics={metrics}><ContactView wide={false} channels={[channel]} onAsk={jest.fn()} /></SafeAreaProvider>);
  await fireEvent.press(screen.getByLabelText('電話 (02) 1234-5678'));
  await fireEvent.press(await screen.findByText('複製聯絡資訊'));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(channel.value);
  expect(await screen.findByText('已複製聯絡資訊')).toBeTruthy();
});

it('手機完整顯示流程說明，QA 明確提示並開啟顧問', async () => {
  const onAsk = jest.fn();
  await render(<SafeAreaProvider initialMetrics={metrics}><ContactView wide={false} channels={[]} onAsk={onAsk} /></SafeAreaProvider>);
  expect(screen.getByText('實機展示、評估現場配置')).toBeTruthy();
  expect(screen.getByText('點選問題，由 AI 顧問解答。')).toBeTruthy();
  for (const question of CONTACT_FAQ) expect(screen.getByText(question)).toBeTruthy();
  await fireEvent.press(screen.getByText('如何評估適合的方案與費用？'));
  expect(onAsk).toHaveBeenCalledWith('如何評估適合的方案與費用？');
});

it.each([
  { height: 680, fontScale: 1, count: 3 },
  { height: 834, fontScale: 1, count: 5 },
  { height: 1024, fontScale: 1, count: 6 },
  { height: 834, fontScale: 1.3, count: 3 },
])('橫向高度 $height、字體倍率 $fontScale 時顯示 $count 題且不捲動', async ({ height, fontScale, count }) => {
  jest.mocked(useWindowDimensions).mockReturnValueOnce({ width: 1366, height, scale: 1, fontScale });
  await render(<SafeAreaProvider initialMetrics={metrics}><ContactView wide channels={[channel]} onAsk={jest.fn()} /></SafeAreaProvider>);
  expect(screen.getByTestId('contact-landscape')).toBeTruthy();
  expect(screen.queryByTestId('contact-scroll')).toBeNull();
  for (const question of CONTACT_FAQ.slice(0, count)) expect(screen.getByText(question)).toBeTruthy();
  for (const question of CONTACT_FAQ.slice(count)) expect(screen.queryByText(question)).toBeNull();
});
