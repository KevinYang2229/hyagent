import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SolutionsView, type SolutionsViewProps } from './SolutionsView';

const metrics = { frame: { x: 0, y: 0, width: 1194, height: 834 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function view(props: Partial<SolutionsViewProps> = {}) {
  const all: SolutionsViewProps = {
    wide: true, query: '', searchOpen: false,
    onQuery: jest.fn(), onToggleSearch: jest.fn(), onOpen: jest.fn(), onAsk: jest.fn(),
    ...props,
  };
  return { props: all, ui: <SafeAreaProvider initialMetrics={metrics}><SolutionsView {...all} /></SafeAreaProvider> };
}

it('列出四個方案且沒有分類標籤，點卡片開詳細', async () => {
  const { props, ui } = view();
  await render(ui);
  for (const name of ['圖書館空間管理', 'OfficeMe 智慧辦公空間', '智慧環控方案', '專業顧問服務']) expect(screen.getByLabelText(name)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('OfficeMe 智慧辦公空間'));
  expect(props.onOpen).toHaveBeenCalledWith('office');
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});

it('搜不到時可以把關鍵字丟給 AI 顧問', async () => {
  const { props, ui } = view({ searchOpen: true, query: '停車場' });
  await render(ui);
  expect(screen.getByText('找不到「停車場」相關的方案。')).toBeTruthy();
  await fireEvent.press(screen.getByText('問 AI 產品顧問'));
  expect(props.onAsk).toHaveBeenCalledWith('我想了解 SpaceMe 有沒有關於「停車場」的方案');
});
