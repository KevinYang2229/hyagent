/**
 * 開場轉導頁（取代登入）：字標淡入、HyAgent 星芒光球呼吸、光點環繞、背景弧線緩轉，
 * 同時在背景取得訪客 Session。動畫至少播 MIN_INTRO_MS，連上後自動進首頁；
 * 連線失敗時顯示原因、重新連線，並可修改伺服器位址（區網 Demo 用）。
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { LibOneLogo } from '@/brand/Brand';
import { lib } from '@/brand/theme';

/** 開場動畫至少播放的時間 */
export const MIN_INTRO_MS = 1800;

export interface IntroViewProps {
  /** 已取得訪客身分 */
  connected: boolean;
  /** 連線失敗的原因；null＝連線中或成功 */
  error: string | null;
  serverUrl: string;
  onRetry(serverUrl: string): void;
  /** 動畫播完且已連上時呼叫一次 */
  onDone(): void;
}

export function IntroView({ connected, error, serverUrl, onRetry, onDone }: IntroViewProps) {
  const { width } = useWindowDimensions();
  const [minElapsed, setMinElapsed] = useState(false);
  const [server, setServer] = useState(serverUrl);
  const [showServer, setShowServer] = useState(!serverUrl);
  const done = useRef(false);

  const enter = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), MIN_INTRO_MS);
    Animated.timing(enter, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loops = [
      Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])),
      Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.cubic), useNativeDriver: true })),
    ];
    loops.forEach((l) => l.start());
    return () => {
      clearTimeout(timer);
      loops.forEach((l) => l.stop());
    };
  }, [enter, pulse, orbit, progress]);

  useEffect(() => {
    if (connected && minElapsed && !done.current) {
      done.current = true;
      onDone();
    }
  }, [connected, minElapsed, onDone]);

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });
  const orbScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.55] });
  const spin = orbit.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const spinBack = orbit.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });
  const barTravel = progress.interpolate({ inputRange: [0, 1], outputRange: [-90, 220] });
  const ring = Math.max(width, 700) * 1.1;

  return (
    <View style={styles.page}>
      <LinearGradient colors={['#FFFFFF', lib.greenMist, '#DDEEE1']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {/* 背景：兩道緩慢反向旋轉的大弧線 */}
      <Animated.View pointerEvents="none" style={[styles.ring, { width: ring, height: ring, borderRadius: ring / 2, top: -ring * 0.62, right: -ring * 0.42, transform: [{ rotate: spin }] }]} />
      <Animated.View pointerEvents="none" style={[styles.ring, styles.ringThin, { width: ring * 0.7, height: ring * 0.7, borderRadius: ring * 0.35, bottom: -ring * 0.45, left: -ring * 0.3, transform: [{ rotate: spinBack }] }]} />

      <Animated.View style={[styles.center, { opacity: enter, transform: [{ translateY: rise }] }]}>
        <LibOneLogo size={56} />
        <Text style={styles.headline}>
          ONE LIBRARY, <Text style={{ color: lib.greenBright }}>ONE EXPERIENCE</Text>
        </Text>

        {/* HyAgent 光球：呼吸光暈＋環繞光點 */}
        <View style={styles.orbWrap} accessibilityLabel="HyAgent">
          <Animated.View style={[styles.glow, { opacity: glow, transform: [{ scale: orbScale }] }]} />
          <Animated.View style={[styles.orbit, { transform: [{ rotate: spin }] }]}>
            <View style={[styles.spark, { top: 0, left: 66 }]} />
            <View style={[styles.spark, styles.sparkSmall, { bottom: 10, right: 12 }]} />
            <View style={[styles.spark, styles.sparkSmall, { bottom: 18, left: 8 }]} />
          </Animated.View>
          <Animated.View style={[styles.orb, { transform: [{ scale: orbScale }] }]}>
            <MaterialCommunityIcons name="star-four-points" size={46} color="#FFFFFF" />
          </Animated.View>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText} accessibilityRole="alert">{error}</Text>
            {showServer ? (
              <TextInput
                style={styles.input}
                value={server}
                onChangeText={setServer}
                placeholder="伺服器位址，例如 http://192.168.1.10:3000"
                placeholderTextColor={lib.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel="伺服器位址"
              />
            ) : (
              <Pressable onPress={() => setShowServer(true)} accessibilityRole="button"><Text style={styles.link}>伺服器設定</Text></Pressable>
            )}
            <Pressable onPress={() => onRetry(server)} style={({ pressed }) => [styles.retry, pressed && { opacity: 0.85 }]} accessibilityRole="button">
              <Text style={styles.retryText}>重新連線</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.status}>
            <Text style={styles.statusText}>{connected ? '準備就緒' : '正在為你連線 HyAgent'}</Text>
            <View style={styles.track}>
              <Animated.View style={[styles.bar, { transform: [{ translateX: barTravel }] }]} />
            </View>
          </View>
        )}
      </Animated.View>

      <Animated.Text style={[styles.footer, { opacity: enter }]}>用 AI 探索 LIB ONE 產品與服務</Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: lib.greenMist },
  ring: { position: 'absolute', borderWidth: 4, borderColor: 'rgba(61,170,92,0.22)', borderLeftColor: 'rgba(61,170,92,0.05)' },
  ringThin: { borderWidth: 2, borderColor: 'rgba(61,170,92,0.18)', borderRightColor: 'transparent' },
  center: { alignItems: 'center', gap: 22, paddingHorizontal: 24, width: '100%', maxWidth: 520 },
  headline: { fontSize: 20, fontWeight: '900', color: lib.ink, letterSpacing: 0.5, textAlign: 'center' },
  orbWrap: { width: 160, height: 160, alignItems: 'center', justifyContent: 'center', marginVertical: 8 },
  glow: { position: 'absolute', width: 160, height: 160, borderRadius: 80, backgroundColor: lib.greenBright },
  orbit: { position: 'absolute', width: 150, height: 150 },
  spark: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: lib.greenBright, borderWidth: 3, borderColor: '#FFFFFF' },
  sparkSmall: { width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  orb: { width: 96, height: 96, borderRadius: 48, backgroundColor: lib.greenDark, alignItems: 'center', justifyContent: 'center', borderWidth: 5, borderColor: '#FFFFFF', shadowColor: lib.greenDark, shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  status: { alignItems: 'center', gap: 12 },
  statusText: { fontSize: 18, fontWeight: '700', color: lib.inkSoft },
  track: { width: 220, height: 6, borderRadius: 3, backgroundColor: 'rgba(30,107,58,0.12)', overflow: 'hidden' },
  bar: { width: 90, height: 6, borderRadius: 3, backgroundColor: lib.green },
  errorBox: { alignSelf: 'stretch', alignItems: 'center', gap: 12, padding: 20, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.92)' },
  errorText: { fontSize: 17, lineHeight: 25, color: '#B3261E', textAlign: 'center' },
  input: { alignSelf: 'stretch', borderWidth: 1, borderColor: lib.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17, color: lib.ink, backgroundColor: '#FFFFFF' },
  link: { fontSize: 16, color: lib.greenDark },
  retry: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 14, borderRadius: 999, backgroundColor: lib.greenDark },
  retryText: { fontSize: 18, fontWeight: '800', color: '#FFFFFF' },
  footer: { position: 'absolute', bottom: 48, fontSize: 17, fontWeight: '700', color: lib.inkSoft },
});
