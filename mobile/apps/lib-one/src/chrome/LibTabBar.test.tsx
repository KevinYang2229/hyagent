import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LibTabBar, TABS } from './LibTabBar';
import { pageTitle } from './TopBar';

it('底部導覽五格補齊，HyAgent 在正中間', () => {
  expect(TABS).toHaveLength(5);
  expect(TABS[Math.floor(TABS.length / 2)].name).toBe('chat');
});

it('點分頁回傳路由名稱，選中的分頁標成 selected', async () => {
  const onPress = jest.fn();
  await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 1024, height: 768 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><LibTabBar active="compare" onPress={onPress} /></SafeAreaProvider>);
  await fireEvent.press(screen.getByLabelText('HyAgent AI 助理'));
  expect(onPress).toHaveBeenCalledWith('chat');
  expect(screen.getByLabelText('產品比較').props.accessibilityState).toEqual({ selected: true });
});

it('品牌列標題依路徑決定', () => {
  expect(pageTitle('/')).toBeUndefined();
  expect(pageTitle('/chat')).toBeUndefined();
  expect(pageTitle('/products')).toBe('產品探索');
  expect(pageTitle('/products/kiosk')).toBe('產品詳細');
  expect(pageTitle('/compare')).toBe('產品比較');
});
