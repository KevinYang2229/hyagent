/** 任務中心獨立預覽；固定資料不會呼叫後端。 */
import { registerRootComponent } from 'expo';
import { useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HomeBackdrop } from '../src/chrome/HomeBackdrop';
import { StoreHeaderView } from '../src/chrome/TopBar';
import { StoreTabBar } from '../src/chrome/StoreTabBar';
import { TaskCenterView } from '../src/tasks/TaskCenterView';

function Preview() {
  const wide = useWindowDimensions().width >= 768;
  return <SafeAreaProvider><HomeBackdrop>
    <StoreHeaderView wide={wide} home={false} name="李小明" role="店長" unread={3} />
    <TaskCenterView summary={{ lowStock: { count: 3, names: ['鮭魚御飯糰', '三明治－火腿蛋', '沙拉－和風雞肉'] }, expiring: { count: 2, names: ['鮮奶', '茶葉蛋'] }, equipmentAlerts: { count: 1, items: [{ name: '咖啡機', issue: '無法出水' }] }, replenishmentsToday: { count: 2 } }} orders={[{ id: 'R001', summary: '鮭魚御飯糰、火腿蛋三明治', itemCount: 2, createdAt: '2026-10-05T02:30:00Z', arrivalDate: '2026-10-06', items: [{ productId: 'P001', name: '鮭魚御飯糰', quantity: 24 }, { productId: 'P005', name: '三明治－火腿蛋', quantity: 20 }] }]} summaryLoading={false} ordersLoading={false} summaryError={false} ordersError={false} dateLabel="10/5（一）" onRetry={() => {}} onAsk={() => {}} />
    <StoreTabBar active="tasks" badge={0} onPress={() => {}} />
  </HomeBackdrop></SafeAreaProvider>;
}
registerRootComponent(Preview);
