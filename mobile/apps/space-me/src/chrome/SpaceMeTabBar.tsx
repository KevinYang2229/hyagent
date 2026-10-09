/**
 * 底部導覽（各稿底部）：首頁、解決方案、凸起的「AI 對話」、產品特色、聯絡我們。
 * 「AI 對話」不是分頁：它打開覆蓋在目前頁面上的顧問面板，所以目前分頁的選取狀態不變；
 * 按鈕本身是 AdvisorOrb，由分頁版面疊在最上層。
 */
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, type Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RobotHead } from '@/brand/Brand';
import { sm } from '@/brand/theme';

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

export const ADVISOR_SLOT = 'advisor';

export const TABS = [
  { name: 'index', label: '首頁', icon: 'home-outline', activeIcon: 'home' },
  { name: 'solutions', label: '解決方案', icon: 'grid-outline', activeIcon: 'grid' },
  { name: ADVISOR_SLOT, label: 'AI 對話', icon: 'chatbubbles-outline', activeIcon: 'chatbubbles' },
  { name: 'features', label: '產品特色', icon: 'briefcase-outline', activeIcon: 'briefcase' },
  { name: 'contact', label: '聯絡我們', icon: 'call-outline', activeIcon: 'call' },
] as const;

/** 分頁的根路徑：index 是首頁 */
export function tabPath(name: string): '/' | `/${string}` {
  return name === 'index' ? '/' : `/${name}`;
}

/** 中央「AI 對話」按鈕的直徑 */
export function orbSize(width: number): number {
  return width >= 700 ? 96 : 72;
}

/** 分頁列底部的留白（安全區） */
export function barBottomPadding(insetBottom: number): number {
  return Math.max(insetBottom - 6, 4);
}

/**
 * 中央凸起的「AI 對話」按鈕。由分頁版面浮在最上層（不放在分頁列裡），
 * 對話開啟後隱藏按鈕，以免遮擋整頁對話的輸入列。
 */
export function AdvisorOrb({ open, onPress }: { open: boolean; onPress(): void }) {
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const orb = orbSize(width);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.orb, { width: orb, height: orb, borderRadius: orb / 2 }, (pressed || open) && { transform: [{ scale: 0.96 }] }]}
      accessibilityRole="button"
      accessibilityLabel="AI 對話"
      accessibilityState={{ expanded: open }}
    >
      <View style={[StyleSheet.absoluteFill, { borderRadius: orb / 2, overflow: 'hidden' }]}>
        <LinearGradient
          colors={open ? ['#B8D8FF', '#80B6FF', '#2F6BFF', '#1F4FD8'] : ['#EAF3FF', '#A8CEFF', '#4D96FF', '#0874FF', '#1F55E6']}
          locations={open ? [0, 0.18, 0.5, 1] : [0, 0.1, 0.34, 0.65, 1]}
          start={{ x: 0.35, y: 0 }} end={{ x: 0.65, y: 1 }} style={StyleSheet.absoluteFill}
        />
        <LinearGradient colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 0.65, y: 0.65 }} style={StyleSheet.absoluteFill} />
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', top: orb * 0.04, alignSelf: 'center', transform: [{ scaleY: 0.82 }] }}><RobotHead size={orb * 0.68} animated /></View>
      <Text style={[styles.orbLabel, { fontSize: wide ? 14 : 11, bottom: orb * 0.1 }]}>AI 對話</Text>
    </Pressable>
  );
}

export function SpaceMeTabBar({ active, onPress }: { active: string; onPress(name: string): void }) {
  const insets = useSafeAreaInsets();
  const wide = useWindowDimensions().width >= 700;
  return (
    <View style={[styles.bar, { paddingBottom: barBottomPadding(insets.bottom) }]}>
      {TABS.map((tab) => {
        // 中間留給浮在上層的 AdvisorOrb
        if (tab.name === ADVISOR_SLOT) return <View key={tab.name} style={styles.slot} />;
        const selected = active === tab.name;
        const color = selected ? sm.blue : sm.inkSoft;
        return (
          <Pressable key={tab.name} style={styles.slot} onPress={() => onPress(tab.name)} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }}>
            <Ionicons name={selected ? tab.activeIcon : tab.icon} size={wide ? 28 : 24} color={color} />
            <Text style={[styles.label, { color, fontSize: wide ? 16 : 12, fontWeight: selected ? '800' : '600' }]}>{tab.label}</Text>
            <View style={[styles.underline, selected && { backgroundColor: sm.blue }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

export function NavigationTabBar({ state, navigation, onTab }: BottomTabBarProps & { onTab(): void }) {
  return <SpaceMeTabBar active={state.routes[state.index].name} onPress={(name) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    onTab();
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (event.defaultPrevented) return;
    // 再點一次目前的分頁：分頁內有堆疊（例如方案詳細）就回到最上層
    if (state.routes[state.index].key === route.key) router.navigate(tabPath(route.name));
    else navigation.navigate(route.name, route.params);
  }} />;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'flex-end', paddingTop: 8, backgroundColor: 'rgba(255,255,255,0.98)', borderTopWidth: 1, borderTopColor: sm.line, zIndex: 30 },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4, minHeight: 56 },
  label: { color: sm.inkSoft },
  underline: { width: 64, height: 3, borderRadius: 2, marginTop: 2, backgroundColor: 'transparent' },
  orb: {
    alignItems: 'center', justifyContent: 'center', backgroundColor: sm.blue, borderWidth: 2, borderColor: '#C7D8F5',
    shadowColor: sm.blue, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 10,
  },
  orbLabel: { position: 'absolute', color: '#FFFFFF', fontWeight: '800', textShadowColor: 'rgba(15,65,170,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
});
