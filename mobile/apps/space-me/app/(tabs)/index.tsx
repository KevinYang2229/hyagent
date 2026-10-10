/** 首頁：情境入口卡直接請 AI 顧問回答，預約展示導到聯絡頁。 */
import { router } from 'expo-router';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useAdvisor } from '@/advisor/AdvisorProvider';
import { HomeView } from '@/home/HomeView';

export default function Home() {
  const wide = useIsWide();
  const advisor = useAdvisor();
  return (
    <HomeView
      wide={wide}
      onSettings={() => router.push('/settings')}
      onExplore={() => router.navigate('/solutions')}
      onEntry={(entry) => (entry.kind === 'contact' ? router.navigate('/contact') : advisor.show(entry.question))}
    />
  );
}
