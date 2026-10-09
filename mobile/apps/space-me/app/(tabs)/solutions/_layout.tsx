import { Stack } from 'expo-router';

// 從首頁直接進方案詳細時，底下也要有列表（index），返回才回得到解決方案
export const unstable_settings = { initialRouteName: 'index' };

export default function SolutionsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
