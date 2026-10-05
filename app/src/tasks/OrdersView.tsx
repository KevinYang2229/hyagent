/** 我的補貨單：卡片列表；寬版明細顯示在右側，窄版以彈出面板顯示。 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ReplenishmentOrder } from '@/api/types';
import { Mascot } from '@/brand/Mascot';
import { colors, font, radius, shadow, space } from '@/theme/tokens';
import { formatArrival, formatCreatedAt } from './orders';

export function OrdersView({
  orders, loading, error, onRetry, wide,
}: {
  orders?: ReplenishmentOrder[];
  loading: boolean;
  error: boolean;
  onRetry(): void;
  wide: boolean;
}) {
  const [selected, setSelected] = useState<ReplenishmentOrder | null>(null);

  if (loading && !orders) return <ActivityIndicator color={colors.primary} style={{ marginTop: space.xxl }} />;
  if (error && !orders) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>暫時無法取得補貨單</Text>
        <Pressable onPress={onRetry} accessibilityLabel="重試" accessibilityRole="button" style={styles.retry}>
          <Text style={{ color: colors.primaryDark, fontWeight: '600' }}>重試</Text>
        </Pressable>
      </View>
    );
  }
  if (!orders || orders.length === 0) {
    return (
      <View style={styles.center}>
        <Mascot pose="idle" size={120} />
        <Text style={styles.emptyTitle}>還沒有補貨單</Text>
        <Text style={styles.muted}>可以跟 Open醬說「幫我建立補貨單」，或拍一張貨架照片。</Text>
      </View>
    );
  }

  const detail = selected ? <OrderDetail order={selected} onClose={() => setSelected(null)} /> : null;

  return (
    <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.grid, wide && { flexDirection: 'row', flexWrap: 'wrap' }]}>
        {orders.map((o) => (
          <Pressable
            key={o.id}
            style={[styles.card, wide && { width: '48%' }, selected?.id === o.id && { borderColor: colors.primary }]}
            onPress={() => setSelected(o)}
            accessibilityRole="button"
            accessibilityLabel={`補貨單 ${o.id}`}
          >
            <View style={styles.cardHead}>
              <Text style={styles.orderId}>{o.id}</Text>
              <Text style={styles.status}>已送出</Text>
            </View>
            <Text style={styles.meta}>{`${o.itemCount} 項・到貨 ${formatArrival(o.arrivalDate)}・${formatCreatedAt(o.createdAt)}`}</Text>
            <Text style={styles.summary}>{o.summary}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {wide ? (
        detail ? <View style={styles.side}>{detail}</View> : null
      ) : (
        <Modal visible={Boolean(selected)} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
          <View style={styles.sheetWrap}>
            <View style={styles.sheet}>{detail}</View>
          </View>
        </Modal>
      )}
    </View>
  );
}

export function OrderDetail({ order, onClose }: { order: ReplenishmentOrder; onClose(): void }) {
  return (
    <View style={{ gap: space.md }}>
      <View style={styles.cardHead}>
        <Text style={styles.orderId}>{order.id}</Text>
        <Pressable onPress={onClose} accessibilityLabel="關閉明細" accessibilityRole="button" hitSlop={8}>
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>
      <Text style={styles.meta}>{`預計到貨 ${formatArrival(order.arrivalDate)}・建立於 ${formatCreatedAt(order.createdAt)}`}</Text>
      {order.items.map((i) => (
        <View key={i.productId} style={styles.itemRow}>
          <Text style={styles.itemName}>{i.name}</Text>
          <Text style={styles.itemQty}>{`${i.quantity} 個`}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  muted: { color: colors.textMuted, fontSize: font.md, textAlign: 'center' },
  emptyTitle: { fontSize: font.xl, fontWeight: '800', color: colors.text },
  retry: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  grid: { padding: space.lg, gap: space.md },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: 6, borderLeftWidth: 5, borderLeftColor: colors.primary, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  orderId: { fontSize: font.lg, fontWeight: '800', color: colors.text },
  status: { fontSize: font.sm, color: colors.primaryDark, backgroundColor: colors.primarySoft, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden', fontWeight: '700' },
  meta: { fontSize: font.sm, color: colors.textMuted },
  summary: { fontSize: font.md, color: colors.text },
  side: { width: 380, backgroundColor: colors.surface, padding: space.lg, borderLeftWidth: 1, borderLeftColor: colors.border },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  itemName: { fontSize: font.md, color: colors.text },
  itemQty: { fontSize: font.md, fontWeight: '700', color: colors.text },
});
