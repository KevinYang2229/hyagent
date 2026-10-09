/** 分頁：首頁、產品探索、HyAgent（中央凸起）、產品比較、聯絡我們；品牌列與確認彈窗跨分頁共用。 */
import { Tabs, router, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { ConfirmModalHost } from '@hyagent/app-core/confirm/ConfirmModalHost';
import { useSettings } from '@hyagent/app-core/settings/SettingsProvider';
import { lib } from '@/brand/theme';
import { NavigationTabBar } from '@/chrome/LibTabBar';
import { TopBar } from '@/chrome/TopBar';

export default function TabsLayout() {
  const pathname = usePathname();
  const chat = useChat();
  const { speakEnabled, setSpeakEnabled } = useSettings();
  return (
    <View style={styles.page}>
      <TopBar
        pathname={pathname}
        onBack={() => (router.canGoBack() ? router.back() : router.navigate('/'))}
        onSettings={() => router.push('/settings')}
        chatTools={{ speak: speakEnabled, onToggleSpeak: () => void setSpeakEnabled(!speakEnabled), onNew: chat.newConversation }}
      />
      <Tabs tabBar={(props) => <NavigationTabBar {...props} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: 'transparent' } }}>
        <Tabs.Screen name="index" options={{ title: '首頁' }} />
        <Tabs.Screen name="products" options={{ title: '產品探索' }} />
        <Tabs.Screen name="chat" options={{ title: 'HyAgent' }} />
        <Tabs.Screen name="compare" options={{ title: '產品比較' }} />
        <Tabs.Screen name="contact" options={{ title: '聯絡我們' }} />
      </Tabs>
      <ConfirmModalHost />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: lib.greenMist },
});
