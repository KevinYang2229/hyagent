import { Stack } from 'expo-router';

// 結果頁（貨架／優惠券）底下一定要有對話（index），返回才回得到對話
export const unstable_settings = { initialRouteName: 'index' };

export default function ChatLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
