/**
 * 分頁：首頁、解決方案、產品特色、聯絡我們；中央「AI 對話」打開整頁顧問對話。
 * 對話覆蓋整個頁面與導覽列，返回後顯示原本的分頁。
 */
import { Tabs, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConfirmModalHost } from '@hyagent/app-core/confirm/ConfirmModalHost';
import { AdvisorPanel } from '@/advisor/AdvisorPanel';
import { useAdvisor } from '@/advisor/AdvisorProvider';
import { sm } from '@/brand/theme';
import { AdvisorOrb, NavigationTabBar, barBottomPadding } from '@/chrome/SpaceMeTabBar';

export default function TabsLayout() {
  const pathname = usePathname();
  const advisor = useAdvisor();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.page}>
      <View style={{ flex: 1 }} accessibilityElementsHidden={advisor.open} importantForAccessibility={advisor.open ? 'no-hide-descendants' : 'auto'}>
        <Tabs
          tabBar={(props) => (
            <NavigationTabBar {...props} onTab={advisor.hide} />
          )}
          screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: sm.blueMist } }}
        >
          <Tabs.Screen name="index" options={{ title: '首頁' }} />
          <Tabs.Screen name="solutions" options={{ title: '解決方案' }} />
          <Tabs.Screen name="features" options={{ title: '產品特色' }} />
          <Tabs.Screen name="contact" options={{ title: '聯絡我們' }} />
        </Tabs>
      </View>
      <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.advisor]}>
        <AdvisorPanel pathname={pathname} />
      </View>
      {/* 對話開啟時隱藏中央按鈕，讓輸入列使用完整空間 */}
      {!advisor.open ? (
        <View pointerEvents="box-none" style={[styles.orb, { bottom: barBottomPadding(insets.bottom) + 2 }]}>
          <AdvisorOrb open={false} onPress={() => advisor.show()} />
        </View>
      ) : null}
      <ConfirmModalHost />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: sm.blueMist },
  advisor: { zIndex: 200, elevation: 40 },
  orb: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 100, elevation: 30 },
});
