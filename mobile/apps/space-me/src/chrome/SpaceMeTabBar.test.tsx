import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));

import { ADVISOR_SLOT, AdvisorOrb, SpaceMeTabBar, TABS, tabPath } from './SpaceMeTabBar';

const metrics = { frame: { x: 0, y: 0, width: 1194, height: 834 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

it('底部導覽五格，AI 對話在正中間', () => {
  expect(TABS).toHaveLength(5);
  expect(TABS[2].name).toBe(ADVISOR_SLOT);
});

it('點分頁回傳路由名稱，選中的分頁標成 selected；中間格留給 AI 對話按鈕', async () => {
  const onPress = jest.fn();
  await render(<SafeAreaProvider initialMetrics={metrics}><SpaceMeTabBar active="features" onPress={onPress} /></SafeAreaProvider>);
  expect(screen.getByLabelText('產品特色').props.accessibilityState).toEqual({ selected: true });
  await fireEvent.press(screen.getByLabelText('解決方案'));
  expect(onPress).toHaveBeenCalledWith('solutions');
  expect(screen.queryByLabelText('AI 對話')).toBeNull();
});

it('AI 對話按鈕：點了呼叫 onPress，開啟狀態標成 expanded', async () => {
  const onPress = jest.fn();
  await render(<AdvisorOrb open onPress={onPress} />);
  await fireEvent.press(screen.getByLabelText('AI 對話'));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('AI 對話').props.accessibilityState).toMatchObject({ expanded: true });
});

it('分頁根路徑：再點目前分頁時回到這裡', () => {
  expect(tabPath('index')).toBe('/');
  expect(tabPath('solutions')).toBe('/solutions');
});
