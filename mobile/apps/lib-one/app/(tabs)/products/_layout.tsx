import { Stack } from 'expo-router';

// 詳細頁、比較頁底下一定要有產品列表（index），返回才回得到列表
export const unstable_settings = { initialRouteName: 'index' };

export default function ProductsLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />;
}
