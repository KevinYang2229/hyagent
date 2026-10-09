/**
 * 開場轉導頁（取代登入）：字標淡入、機器人浮動眨眼、光環擴散、光點環繞，
 * 同時在背景取得訪客 Session。動畫至少播 MIN_INTRO_MS，連上後自動進首頁；
 * 連線失敗時顯示原因、重新連線，並可修改伺服器位址（區網 Demo 用）。
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { RobotHead, SpaceMeLogo } from '@/brand/Brand';
import { sm } from '@/brand/theme';

/** 開場動畫至少播放的時間 */
export const MIN_INTRO_MS = 2000;

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
  const [minElapsed, setMinElapsed] = useState(false);
  const [server, setServer] = useState(serverUrl);
  const [showServer, setShowServer] = useState(!serverUrl);
  const done = useRef(false);

  // 設定讀完前 serverUrl 是空字串：讀到後同步到輸入框，已有位址就收起輸入框
  useEffect(() => {
    setServer(serverUrl);
    if (serverUrl) setShowServer(false);
  }, [serverUrl]);

  const enter = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const ripple = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), MIN_INTRO_MS);
    Animated.timing(enter, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loops = [
      Animated.loop(Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])),
      Animated.loop(Animated.timing(ripple, { toValue: 1, duration: 2000, easing: Easing.out(Easing.quad), useNativeDriver: true })),
      Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 5000, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.cubic), useNativeDriver: true })),
    ];
    loops.forEach((l) => l.start());
    return () => {
      clearTimeout(timer);
      loops.forEach((l) => l.stop());
    };
  }, [enter, float, ripple, orbit, progress]);

  useEffect(() => {
    if (connected && minElapsed && !done.current) {
      done.current = true;
      onDone();
    }
  }, [connected, minElapsed, onDone]);

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });
  const bob = float.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
  const rippleScale = ripple.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.6] });
  const rippleOpacity = ripple.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  const spin = orbit.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const barTravel = progress.interpolate({ inputRange: [0, 1], outputRange: [-90, 220] });

  return (
    <View style={styles.page}>
      <LinearGradient colors={['#FFFFFF', sm.blueMist, '#DCE8FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />

      <Animated.View style={[styles.center, { opacity: enter, transform: [{ translateY: rise }] }]}>
        <SpaceMeLogo size={44} />
        <Text style={styles.headline}>智慧空間，讓學習與工作更美好</Text>

        <View style={styles.stage} accessibilityLabel="HyAgent">
          <Animated.View style={[styles.ripple, { opacity: rippleOpacity, transform: [{ scale: rippleScale }] }]} />
          <Animated.View style={[styles.orbit, { transform: [{ rotate: spin }] }]}>
            <View style={[styles.spark, { top: 0, left: 92 }]} />
            <View style={[styles.spark, styles.sparkSmall, { bottom: 16, right: 10 }]} />
            <View style={[styles.spark, styles.sparkSmall, { bottom: 24, left: 6 }]} />
          </Animated.View>
          <Animated.View style={[styles.disc, { transform: [{ translateY: bob }] }]}>
            <RobotHead size={118} animated />
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
                placeholderTextColor={sm.muted}
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
            <Text style={styles.statusText}>{connected ? '準備就緒，即將進入 SpaceMe' : '正在為您連線 AI 產品顧問'}</Text>
            <View style={styles.track}>
              <Animated.View style={[styles.bar, { transform: [{ translateX: barTravel }] }]} />
            </View>
          </View>
        )}
      </Animated.View>

      <Animated.Text style={[styles.footer, { opacity: enter }]}>Powered by HyAgent</Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: sm.blueMist },
  center: { alignItems: 'center', gap: 20, paddingHorizontal: 24, width: '100%', maxWidth: 520 },
  headline: { fontSize: 22, fontWeight: '800', color: sm.ink, textAlign: 'center' },
  stage: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center', marginVertical: 6 },
  ripple: { position: 'absolute', width: 170, height: 170, borderRadius: 85, backgroundColor: sm.blue },
  orbit: { position: 'absolute', width: 196, height: 196 },
  spark: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: '#58C7FF', borderWidth: 3, borderColor: '#FFFFFF' },
  sparkSmall: { width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  disc: {
    width: 150, height: 150, borderRadius: 75, backgroundColor: sm.blue, alignItems: 'center', justifyContent: 'center', borderWidth: 6, borderColor: '#FFFFFF',
    shadowColor: sm.blueDark, shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  status: { alignItems: 'center', gap: 12 },
  statusText: { fontSize: 18, fontWeight: '700', color: sm.inkSoft },
  track: { width: 220, height: 6, borderRadius: 3, backgroundColor: 'rgba(47,107,255,0.14)', overflow: 'hidden' },
  bar: { width: 90, height: 6, borderRadius: 3, backgroundColor: sm.blue },
  errorBox: { alignSelf: 'stretch', alignItems: 'center', gap: 12, padding: 20, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.94)' },
  errorText: { fontSize: 17, lineHeight: 25, color: '#B3261E', textAlign: 'center' },
  input: { alignSelf: 'stretch', borderWidth: 1, borderColor: sm.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17, color: sm.ink, backgroundColor: '#FFFFFF' },
  link: { fontSize: 16, color: sm.blueDark },
  retry: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 14, borderRadius: 999, backgroundColor: sm.blue },
  retryText: { fontSize: 18, fontWeight: '800', color: '#FFFFFF' },
  footer: { position: 'absolute', bottom: 40, fontSize: 15, fontWeight: '700', color: sm.muted, letterSpacing: 0.5 },
});
