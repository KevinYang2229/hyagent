/** 轉導動畫前的 App 啟動畫面，原生與網頁使用同一張 App icon。 */
import { useEffect } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { SpaceMeLogo } from '@/brand/Brand';
import { sm } from '@/brand/theme';

export const LAUNCH_ICON_MS = 800;

export function LaunchView({ onDone }: { onDone(): void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, LAUNCH_ICON_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <View style={styles.page} accessibilityLabel="SpaceMe 啟動中">
      <Image source={require('../../assets/icon.png')} style={styles.icon} accessibilityLabel="SpaceMe App 圖示" />
      <SpaceMeLogo size={26} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: sm.blueMist, alignItems: 'center', justifyContent: 'center', gap: 24 },
  icon: { width: 112, height: 112, borderRadius: 26 },
});
