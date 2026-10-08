/** 獨立視覺預覽入口：僅供 Metro 手動載入，不是 App 的公開路由。 */
import { registerRootComponent } from 'expo';
import { useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HomeBackdrop } from '../src/chrome/HomeBackdrop';
import { StoreHeaderView } from '../src/chrome/TopBar';
import { StoreTabBar } from '../src/chrome/StoreTabBar';
import { HomeView } from '../src/home/HomeView';
import { summaryCards } from '../src/home/summaryCards';

const cards = summaryCards({
  lowStock: { count: 3, names: ['御飯糰', '三明治', '沙拉'] },
  expiring: { count: 2, names: [] },
  equipmentAlerts: { count: 1, items: [{ name: '咖啡機', issue: '顯示紅燈' }] },
  replenishmentsToday: { count: 4 },
});
const noop = () => {};
function Preview() {
  const wide = useWindowDimensions().width >= 900;
  return <SafeAreaProvider>
    <HomeBackdrop>
      <StoreHeaderView wide={wide} home name="李小明" role="店員" unread={3} />
      <HomeView wide={wide} cards={cards} loading={false} error={false} dateLabel="9/15（一）" hour={9} onRetry={noop} onSummary={noop} onAll={noop} onVoice={noop} onPhoto={noop} onText={noop} onScenario={noop} />
      <StoreTabBar active="index" badge={1} onPress={noop} />
    </HomeBackdrop>
  </SafeAreaProvider>;
}
registerRootComponent(Preview);
