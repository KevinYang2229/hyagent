/** 首頁：入口卡導到方案詳細，或直接請 AI 顧問回答。 */
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
      onEntry={(entry) => (entry.kind === 'solution' ? router.navigate(`/solutions/${entry.id}`) : advisor.show(entry.question))}
    />
  );
}
