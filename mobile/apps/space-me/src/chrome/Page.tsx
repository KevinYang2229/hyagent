/** 各頁共用：右上照片淡入白底的背景（隨頁面捲動）、可捲動的頁面框、圖示徽章與箭頭鈕。 */
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Image, ScrollView, StyleSheet, View, useWindowDimensions, type ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sm, tints, type Tint } from '@/brand/theme';

export const PAGE_TOP_SPACE = { phone: 32, tablet: 40, landscape: 24 } as const;

export function useLandscapeLayout() {
  const { width, height } = useWindowDimensions();
  return width >= 700 && width > height;
}

export function Page({ photo, photoHeight = 360, wide, children }: { photo?: ImageSourcePropType; photoHeight?: number; wide: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const landscape = useLandscapeLayout();
  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + (landscape ? PAGE_TOP_SPACE.landscape : wide ? PAGE_TOP_SPACE.tablet : PAGE_TOP_SPACE.phone), paddingLeft: Math.max(insets.left, wide ? 32 : 18), paddingRight: Math.max(insets.right, wide ? 32 : 18), paddingBottom: wide ? 42 : 32 }]} keyboardShouldPersistTaps="handled">
        {photo ? (
          <View pointerEvents="none" style={[styles.photoWrap, { height: photoHeight, width: wide ? '62%' : '100%' }]}>
            <Image source={photo} style={styles.photo} resizeMode="cover" />
            <LinearGradient colors={[sm.blueMist, 'rgba(245,248,255,0.55)', 'rgba(245,248,255,0)']} locations={[0, 0.2, 0.42]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
            <LinearGradient colors={['rgba(245,248,255,0)', sm.blueMist]} start={{ x: 0.5, y: 0.62 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
          </View>
        ) : null}
        {children}
      </ScrollView>
    </View>
  );
}

export function IconBadge({ name, tint, size = 56 }: { name: keyof typeof Ionicons.glyphMap; tint: Tint; size?: number }) {
  const c = tints[tint];
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={size * 0.52} color={c.fg} />
    </View>
  );
}

export function ArrowDot({ size = 28 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: sm.blueSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="arrow-forward" size={size * 0.55} color={sm.blue} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: sm.blueMist },
  photoWrap: { position: 'absolute', top: 0, right: 0 },
  // 網頁版 Image 沒有明確寬高會用原圖尺寸，absoluteFill 撐不開
  photo: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  // 底部留白讓出中央凸起的「AI 對話」按鈕
  content: { paddingBottom: 96, flexGrow: 1 },
});
