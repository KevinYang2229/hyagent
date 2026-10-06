/** 與首頁原稿一致的橫向導覽與薄荷色選取膠囊。 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const TABS = [
  { name: 'index', label: '首頁', icon: 'home-outline', activeIcon: 'home' },
  { name: 'chat', label: 'AI 對話', icon: 'chatbubble-ellipses-outline', activeIcon: 'chatbubble-ellipses' },
  { name: 'tasks', label: '任務', icon: 'clipboard-outline', activeIcon: 'clipboard' },
  { name: 'me', label: '設定', icon: 'settings-outline', activeIcon: 'settings' },
] as const;

export function StoreTabBar({ active, badge, onPress, onLongPress }: { active: string; badge: number; onPress(name: string): void; onLongPress?(name: string): void }) {
  const insets = useSafeAreaInsets();
  const wide = useWindowDimensions().width >= 900;
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom - 8, 0) }]}>
      <View style={styles.buttons}>
      {TABS.map((tab) => {
        const selected = active === tab.name;
        const color = selected ? '#00866B' : '#465875';
        return <Pressable key={tab.name} style={styles.slot} onPress={() => onPress(tab.name)} onLongPress={() => onLongPress?.(tab.name)} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }}>
          <View style={[styles.pill, { paddingHorizontal: wide ? 28 : 8, gap: wide ? 12 : 6 }, selected && styles.selected]}>
            <View><Ionicons name={selected ? tab.activeIcon : tab.icon} size={26} color={color} />
              {tab.name === 'tasks' && badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text></View> : null}
            </View>
            <Text numberOfLines={1} style={[styles.label, { color, fontSize: wide ? 17 : 13, fontWeight: selected ? '800' : '600' }]}>{tab.label}</Text>
          </View>
        </Pressable>;
      })}
      </View>
    </View>
  );
}

export function NavigationTabBar({ state, navigation, badge = 0 }: BottomTabBarProps & { badge?: number }) {
  return <StoreTabBar active={state.routes[state.index].name} badge={badge} onPress={(name) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!event.defaultPrevented && state.routes[state.index].key !== route.key) navigation.navigate(route.name, route.params);
  }} onLongPress={(name) => {
    const route = state.routes.find((r) => r.name === name);
    if (route) navigation.emit({ type: 'tabLongPress', target: route.key });
  }} />;
}

const styles = StyleSheet.create({
  bar: { backgroundColor: 'rgba(255,255,255,0.98)', borderTopWidth: 1, borderTopColor: '#EFF8F5' },
  buttons: { height: 72, flexDirection: 'row', alignItems: 'stretch', paddingVertical: 8 },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 28, height: 50, borderRadius: 28 },
  selected: { backgroundColor: '#DAF7EF' },
  label: { fontSize: 17 },
  badge: { position: 'absolute', top: -5, right: -7, minWidth: 15, height: 15, paddingHorizontal: 3, borderRadius: 8, backgroundColor: '#FF262B', alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
});
