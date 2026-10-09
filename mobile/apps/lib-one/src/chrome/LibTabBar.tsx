/** 底部導覽（稿 01）：首頁、產品探索、凸起的 HyAgent、產品比較、聯絡我們。五格平均分配，HyAgent 在正中間，是整個 App 的主角。 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lib } from '@/brand/theme';

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

export const TABS = [
  { name: 'index', label: '首頁', icon: 'home-outline', activeIcon: 'home' },
  { name: 'products', label: '產品探索', icon: 'grid-outline', activeIcon: 'grid' },
  { name: 'chat', label: 'HyAgent', icon: 'sparkles-outline', activeIcon: 'sparkles' },
  { name: 'compare', label: '產品比較', icon: 'git-compare-outline', activeIcon: 'git-compare' },
  { name: 'contact', label: '聯絡我們', icon: 'mail-outline', activeIcon: 'mail' },
] as const;

export function LibTabBar({ active, onPress }: { active: string; onPress(name: string): void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom - 6, 4) }]}>
      {TABS.map((tab) => {
        const selected = active === tab.name;
        const color = selected ? lib.greenDark : lib.muted;
        if (tab.name === 'chat') {
          return (
            <Pressable key={tab.name} style={styles.slot} onPress={() => onPress(tab.name)} accessibilityRole="tab" accessibilityLabel="HyAgent AI 助理" accessibilityState={{ selected }}>
              <View style={[styles.agent, selected && styles.agentOn]}>
                <MaterialCommunityIcons name="star-four-points" size={30} color="#FFFFFF" />
              </View>
              <Text style={[styles.label, styles.agentLabel]}>HyAgent</Text>
            </Pressable>
          );
        }
        return (
          <Pressable key={tab.name} style={styles.slot} onPress={() => onPress(tab.name)} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }}>
            <Ionicons name={selected ? tab.activeIcon : tab.icon} size={24} color={color} />
            <Text style={[styles.label, { color, fontWeight: selected ? '800' : '600' }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function NavigationTabBar({ state, navigation }: BottomTabBarProps) {
  return <LibTabBar active={state.routes[state.index].name} onPress={(name) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!event.defaultPrevented) navigation.navigate(route.name, route.params);
  }} />;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'flex-end', paddingTop: 8, backgroundColor: 'rgba(255,255,255,0.98)', borderTopWidth: 1, borderTopColor: lib.line },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 3, minHeight: 52 },
  label: { fontSize: 14, color: lib.muted },
  agent: { width: 62, height: 62, borderRadius: 31, marginTop: -30, backgroundColor: lib.green, alignItems: 'center', justifyContent: 'center', borderWidth: 4, borderColor: '#FFFFFF', shadowColor: lib.greenDark, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  agentOn: { backgroundColor: lib.greenDark },
  agentLabel: { color: lib.greenDark, fontWeight: '800', fontSize: 15 },
});
