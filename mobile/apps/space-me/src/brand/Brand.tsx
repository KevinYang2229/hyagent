/**
 * 品牌元件：SpaceMe 字標、HyAgent 機器人（頭像與半身）。
 * 機器人用 View＋漸層組成（造型照設計稿），任何尺寸都清晰；App 圖示（scripts/make-icons.mjs）是同一造型的平面版。
 */
import { useEffect, useRef } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Animated, Easing, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { MascotPose } from '@hyagent/app-core/branding/AppBranding';
import { sm } from './theme';

export function SpaceMeLogo({ size = 28, color = sm.ink }: { size?: number; color?: string }) {
  const ring = size * 0.62;
  const stroke = Math.max(3, size * 0.16);
  return (
    <View style={styles.logo} accessibilityRole="header" accessibilityLabel="SpaceMe">
      <View style={{ width: ring * 1.7, height: ring }}>
        <View style={[styles.ring, { width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke, left: 0 }]} />
        <View style={[styles.ring, { width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke, left: ring * 0.7, borderColor: '#5B8CFF' }]} />
      </View>
      <Text style={{ fontSize: size * 0.82, fontWeight: '800', color, letterSpacing: 0.2 }}>SpaceMe</Text>
    </View>
  );
}

/** 依畫布比例擺放的方塊 */
function box(size: number, x0: number, y0: number, x1: number, y1: number, r: number): ViewStyle {
  return { position: 'absolute', left: size * x0, top: size * y0, width: size * (x1 - x0), height: size * (y1 - y0), borderRadius: size * r, overflow: 'hidden' };
}

/** 白色烤漆的立體感：左上亮、右下帶一點藍灰 */
const SHELL = ['#FFFFFF', '#F3F6FC', '#D5DEEC'] as const;

function Shell({ style, colors = SHELL }: { style: ViewStyle; colors?: readonly [string, string, ...string[]] }) {
  return (
    <View style={style}>
      <LinearGradient colors={colors} start={{ x: 0.2, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
    </View>
  );
}

/**
 * 機器人頭像（照設計稿）：圓頂頭盔、深色亮面面罩、圓形發光藍眼、面罩下方小嘴、臉部微笑、兩側白色耳盤。
 * animated 時會眨眼。
 */
export function RobotHead({ size, animated = false }: { size: number; animated?: boolean }) {
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!animated) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(2600),
      Animated.timing(blink, { toValue: 0.1, duration: 90, useNativeDriver: true }),
      Animated.timing(blink, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [animated, blink]);
  const eye = (cx: number): ViewStyle => box(size, cx - 0.068, 0.375, cx + 0.068, 0.515, 0.068);
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* 耳盤 */}
      <Shell style={box(size, 0.0, 0.33, 0.16, 0.6, 0.08)} />
      <Shell style={box(size, 0.84, 0.33, 1.0, 0.6, 0.08)} />
      {/* 頭盔 */}
      <Shell style={{ ...box(size, 0.07, 0.04, 0.93, 0.86, 0.42), borderWidth: Math.max(1, size * 0.008), borderColor: '#E1E8F4' }} />
      {/* 面罩：深藍漸層＋左上反光 */}
      <View style={box(size, 0.17, 0.25, 0.83, 0.64, 0.18)}>
        <LinearGradient colors={['#2B3A68', '#0D1634', '#050A1E']} start={{ x: 0.1, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: size * 0.05, top: size * 0.025, width: size * 0.3, height: size * 0.05, borderRadius: size * 0.03, backgroundColor: 'rgba(255,255,255,0.14)', transform: [{ rotate: '-8deg' }] }} />
      </View>
      {/* 眼睛：發光圓眼＋高光 */}
      {[0.375, 0.625].map((cx) => (
        <Animated.View key={cx} style={[eye(cx), styles.eyeGlow, { transform: [{ scaleY: blink }] }]}>
          <LinearGradient colors={['#8CC8FF', '#2F7BFF', '#1747D6']} start={{ x: 0.3, y: 0 }} end={{ x: 0.7, y: 1 }} style={StyleSheet.absoluteFill} />
          <View style={{ position: 'absolute', left: size * 0.03, top: size * 0.022, width: size * 0.035, height: size * 0.035, borderRadius: size * 0.02, backgroundColor: 'rgba(255,255,255,0.85)' }} />
        </Animated.View>
      ))}
      {/* 面罩內的小嘴、臉上的微笑 */}
      <View style={[box(size, 0.46, 0.565, 0.54, 0.58, 0.01), { backgroundColor: 'rgba(170,190,230,0.55)' }]} />
      <View style={[box(size, 0.43, 0.66, 0.57, 0.71, 0.07), { overflow: 'visible', borderBottomWidth: Math.max(1, size * 0.012), borderColor: '#B8C4D8', borderTopLeftRadius: 0, borderTopRightRadius: 0 }]} />
    </View>
  );
}

/** 首頁的半身機器人（稿 4）：圓頂頭、白色身體、藍色領巾，舉起左手揮手。 */
export function RobotFigure({ width }: { width: number }) {
  const wave = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loops = [
      Animated.loop(Animated.sequence([
        Animated.timing(wave, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(wave, { toValue: 0, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.delay(1600),
      ])),
      Animated.loop(Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])),
    ];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [wave, float]);
  const rotate = wave.interpolate({ inputRange: [0, 1], outputRange: ['-26deg', '-42deg'] });
  const translateY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -width * 0.025] });
  const w = width;
  return (
    <Animated.View style={{ width: w, height: w * 1.32, transform: [{ translateY }] }} accessibilityLabel="HyAgent 機器人">
      {/* 右手（觀看者右側）自然下垂 */}
      <Shell style={box(w, 0.74, 0.86, 0.9, 1.22, 0.08)} />
      {/* 身體 */}
      <Shell style={{ ...box(w, 0.2, 0.74, 0.8, 1.32, 0.26), borderWidth: 1, borderColor: '#E1E8F4' }} />
      <View style={[box(w, 0.66, 1.1, 0.74, 1.2, 0.04), { backgroundColor: '#2F6BFF' }]} />
      {/* 藍色領巾 */}
      <View style={box(w, 0.34, 0.76, 0.66, 0.88, 0.06)}>
        <LinearGradient colors={['#5B8CFF', '#2F6BFF', '#1F4FD8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      <View style={[box(w, 0.4, 0.84, 0.5, 0.94, 0.05), { backgroundColor: '#2F6BFF' }]} />
      {/* 左手舉起揮手：以肩膀為軸擺動 */}
      <Animated.View style={{ position: 'absolute', left: w * 0.1, top: w * 0.48, width: w * 0.2, height: w * 0.42, transform: [{ translateY: w * 0.21 }, { rotate }, { translateY: -w * 0.21 }] }}>
        <Shell style={box(w, 0.03, 0.12, 0.17, 0.42, 0.07)} />
        <Shell style={{ ...box(w, 0.0, 0.0, 0.2, 0.18, 0.09), borderWidth: 1, borderColor: '#E1E8F4' }} />
      </Animated.View>
      <View style={{ position: 'absolute', top: 0, left: 0 }}><RobotHead size={w} animated /></View>
    </Animated.View>
  );
}

/** 給共用對話元件的角色：一律顯示機器人頭像 */
export function HyAgentMascot({ size }: { pose: MascotPose; size: number }) {
  return <RobotAvatar size={size} />;
}

/** 圓形柔和藍色漸層的機器人頭像（對話泡泡、顧問面板標頭） */
export function RobotAvatar({ size }: { size: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: size / 2, overflow: 'hidden' }]}>
        <LinearGradient colors={['#C3DDFF', '#8BB8F0']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      <RobotHead size={size * 0.84} />
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { backgroundColor: '#A8CCF8', alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderWidth: 2, borderColor: '#FFFFFF', shadowColor: '#507CB5', shadowOpacity: 0.18, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  logo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ring: { position: 'absolute', top: 0, borderColor: sm.blue },
  eyeGlow: { shadowColor: '#3D8BFF', shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
});
