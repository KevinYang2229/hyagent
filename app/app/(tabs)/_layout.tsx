import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { ConfirmModalHost } from '@/confirm/ConfirmModalHost';
import { TopBar } from '@/chrome/TopBar';
import { useTaskBadge } from '@/tasks/TaskBadge';
import { colors } from '@/theme/tokens';

type IconName = keyof typeof Ionicons.glyphMap;
const icon = (name: IconName) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />;

export default function TabsLayout() {
  const { count } = useTaskBadge();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primaryDark,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: { height: 64, paddingTop: 6, backgroundColor: colors.surface },
          tabBarLabelStyle: { fontSize: 13 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: '首頁', tabBarIcon: icon('home-outline') }} />
        <Tabs.Screen name="chat" options={{ title: 'AI 對話', tabBarIcon: icon('chatbubble-ellipses-outline') }} />
        <Tabs.Screen name="tasks" options={{ title: '任務', tabBarIcon: icon('clipboard-outline'), tabBarBadge: count > 0 ? count : undefined }} />
        <Tabs.Screen name="me" options={{ title: '我的', tabBarIcon: icon('person-outline') }} />
      </Tabs>
      <ConfirmModalHost />
    </View>
  );
}
