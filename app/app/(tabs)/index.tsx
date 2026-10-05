/** 首頁：資料與導航接到平板／手機共用版面。 */
import { router } from 'expo-router';
import { HomeView } from '@/home/HomeView';
import { formatMonthDay, summaryCards, type SummaryCard } from '@/home/summaryCards';
import { useTodaySummary } from '@/home/useTodaySummary';
import { useIsWide } from '@/layout/useIsWide';
import { chatRoute } from '@/navigation/chatRoute';

export default function Home() {
  const wide = useIsWide();
  const summary = useTodaySummary();
  const now = new Date();
  const onCard = (card: SummaryCard) => {
    if (card.action.kind === 'tasks') router.navigate('/tasks');
    else router.navigate(chatRoute({ q: card.action.q }));
  };
  return <HomeView
    wide={wide}
    cards={summary.data ? summaryCards(summary.data) : undefined}
    loading={summary.isLoading}
    error={summary.isError}
    dateLabel={formatMonthDay(now)}
    hour={now.getHours()}
    onRetry={() => void summary.refetch()}
    onSummary={onCard}
    onAll={() => router.navigate('/tasks')}
    onVoice={() => router.navigate(chatRoute({ voice: '1' }))}
    onPhoto={() => router.push({ pathname: '/camera', params: { mode: 'shelf' } })}
    onText={() => router.navigate(chatRoute({ focus: '1' }))}
    onScenario={(q) => router.navigate(chatRoute({ q }))}
  />;
}
