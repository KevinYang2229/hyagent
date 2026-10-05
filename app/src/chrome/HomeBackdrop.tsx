/** 門市背景在下半部淡出成薄荷色，供首頁與視覺預覽共用。 */
import type { ReactNode } from 'react';
import { ImageBackground, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { APP_IMAGES } from '@/brand/assets';

export function HomeBackdrop({ children, fade = true }: { children: ReactNode; fade?: boolean }) {
  return <ImageBackground source={APP_IMAGES.storeBackground} style={styles.backdrop} resizeMode="cover">
    {fade ? <LinearGradient pointerEvents="none" colors={['rgba(236,252,248,0)', 'rgba(236,252,248,0.25)', 'rgba(236,252,248,0.94)', '#ECFCF8']} locations={[0, 0.5, 0.76, 1]} style={StyleSheet.absoluteFill} /> : null}
    {children}
  </ImageBackground>;
}
const styles = StyleSheet.create({ backdrop: { flex: 1, minWidth: 0, overflow: 'hidden', backgroundColor: '#ECFCF8' } });
