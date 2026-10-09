/** 首頁：問題導到 HyAgent，分類卡導到產品探索。 */
import { router } from 'expo-router';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { HomeView } from '@/home/HomeView';
import { chatRoute } from '@/navigation/chatRoute';

export default function Home() {
  const wide = useIsWide();
  return (
    <HomeView
      wide={wide}
      onAsk={(q) => router.navigate(chatRoute({ q }))}
      onCategory={(category) => router.navigate({ pathname: '/products', params: { category } })}
    />
  );
}
