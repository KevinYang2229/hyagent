import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useIsWide } from '@/layout/useIsWide';
import { OrdersView } from '@/tasks/OrdersView';
import { useTaskBadge } from '@/tasks/TaskBadge';
import { useReplenishments } from '@/tasks/useReplenishments';
import { colors, font, space } from '@/theme/tokens';

export default function Tasks() {
  const wide = useIsWide();
  const q = useReplenishments();
  const { clear } = useTaskBadge();
  const { refetch } = q;

  useFocusEffect(
    useCallback(() => {
      clear();
      void refetch();
    }, [clear, refetch]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Text style={{ fontSize: font.xl, fontWeight: '800', color: colors.text, paddingHorizontal: space.lg, paddingTop: space.lg }}>我的補貨單</Text>
      <OrdersView orders={q.data} loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} wide={wide} />
    </View>
  );
}
