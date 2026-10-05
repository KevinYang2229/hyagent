/** 今日重點（稿 4 右欄）。 */
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, shadow, space } from '@/theme/tokens';
import type { SummaryCard } from './summaryCards';

const TONE: Record<SummaryCard['tone'], { fg: string; bg: string; icon: string }> = {
  danger: { fg: '#F2222A', bg: '#FFF0F1', icon: '#FF222C' },
  warning: { fg: '#FF9600', bg: '#FFF8EE', icon: '#FFA000' },
  equipment: { fg: '#087B64', bg: '#F2F7F0', icon: '#009779' },
  info: { fg: '#007CFF', bg: '#EAF6FF', icon: '#007DFF' },
};

export function TodayPanel({
  cards, loading, error, onRetry, onPress, onAll, dateLabel, scale = 1,
}: {
  cards?: SummaryCard[];
  loading: boolean;
  error: boolean;
  onRetry(): void;
  onPress(card: SummaryCard): void;
  dateLabel: string;
  onAll?(): void;
  scale?: number;
}) {
  return (
    <View style={[styles.panel, { padding: 16 * scale, gap: 6 * scale }]}>
      <View style={[styles.head, { marginBottom: 2 * scale }]}>
        <Text style={[styles.title, { fontSize: 18 * scale }]}>今日重點</Text>
        <Text style={[styles.date, { fontSize: 13 * scale }]}>{dateLabel}</Text>
        <View style={{ flex: 1 }} />
        {onAll ? <Pressable onPress={onAll} accessibilityRole="button" accessibilityLabel="查看全部任務"><Text style={[styles.all, { fontSize: 13 * scale }]}>查看全部 ›</Text></Pressable> : null}
      </View>
      {loading && !cards ? <ActivityIndicator color={colors.primary} style={{ marginVertical: space.xl }} /> : null}
      {error && !cards ? (
        <View style={styles.error}>
          <Text style={styles.errorText}>暫時無法取得</Text>
          <Pressable onPress={onRetry} accessibilityLabel="重試" accessibilityRole="button" style={styles.retry}>
            <Text style={{ color: colors.primaryDark, fontWeight: '600' }}>重試</Text>
          </Pressable>
        </View>
      ) : null}
      {cards?.map((c) => {
        const t = TONE[c.tone];
        return (
          <Pressable
            key={c.key}
            style={[styles.card, { backgroundColor: t.bg, minHeight: 90 * scale, padding: 12 * scale, gap: 12 * scale }]}
            onPress={() => onPress(c)}
            accessibilityRole="button"
            accessibilityLabel={`${c.title} ${c.count} 項`}
          >
            <View style={[styles.icon, { backgroundColor: t.icon, width: 46 * scale, height: 46 * scale }]}>
              <Ionicons name={c.icon} size={28 * scale} color="#fff" />
            </View>
            <View style={{ flex: 1, gap: 2 * scale }}>
              <Text style={[styles.count, { color: t.fg, fontSize: 21 * scale, lineHeight: 24 * scale }]}>{`${c.count} ${c.key === 'replenishments' ? '張' : '項'}`}</Text>
              <Text style={[styles.cardTitle, { fontSize: 15 * scale, lineHeight: 19 * scale }]}>{c.title}</Text>
              <Text style={[styles.detail, { fontSize: 14 * scale, lineHeight: 18 * scale }]} numberOfLines={1}>{c.detail}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 26, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 26 },
  title: { fontWeight: '800', color: '#132544' },
  all: { color: '#26947E', fontWeight: '800' },
  date: { color: '#7B899B', fontWeight: '600' },
  card: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.lg, padding: space.md },
  icon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  count: { fontSize: font.xl, fontWeight: '800' },
  cardTitle: { color: '#3E506F', fontWeight: '700' },
  detail: { color: '#7B8799', fontWeight: '500' },
  error: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  errorText: { color: colors.textMuted },
  retry: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
});
