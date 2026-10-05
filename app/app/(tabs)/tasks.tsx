import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { TaskCenterView } from '@/tasks/TaskCenterView';
import { useTodaySummary } from '@/home/useTodaySummary';
import { formatMonthDay } from '@/home/summaryCards';
import { chatRoute } from '@/navigation/chatRoute';
import { useTaskBadge } from '@/tasks/TaskBadge';
import { useReplenishments } from '@/tasks/useReplenishments';

export default function Tasks() {
  const summary = useTodaySummary();
  const q = useReplenishments();
  const { clear } = useTaskBadge();
  const { refetch } = q;
  const { refetch: refetchSummary } = summary;

  useFocusEffect(
    useCallback(() => {
      clear();
      void refetch();
      void refetchSummary();
    }, [clear, refetch, refetchSummary]),
  );

  return (
    <TaskCenterView summary={summary.data} orders={q.data} summaryLoading={summary.isLoading} ordersLoading={q.isLoading} summaryError={summary.isError} ordersError={q.isError} dateLabel={formatMonthDay(new Date())} onRetry={() => { void q.refetch(); void summary.refetch(); }} onAsk={(question) => router.navigate(chatRoute({ q: question }))} />
  );
}
