/** 獨立補貨彈窗視覺預覽，使用本機假資料，不送出 API。 */
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { HomeBackdrop } from '../src/chrome/HomeBackdrop';
import { StoreTabBar } from '../src/chrome/StoreTabBar';
import { ConfirmModal } from '../src/confirm/ConfirmModal';
import { FIELDS } from '../src/confirm/fixtures';

function Preview() {
  return <SafeAreaProvider><HomeBackdrop fade={false}>
    <View style={{ flex: 1 }} />
    <StoreTabBar active="chat" badge={1} onPress={() => {}} />
    <ConfirmModal action={{ id: 'preview', summary: { title: '建立補貨單', fields: [] }, form: { title: '建立補貨單', fields: FIELDS.slice(0, 2) }, expiresAt: '2099-01-01T00:00:00Z' }} onConfirm={async () => ({ kind: 'done', ok: true })} onCancel={async () => {}} />
  </HomeBackdrop></SafeAreaProvider>;
}
registerRootComponent(Preview);
