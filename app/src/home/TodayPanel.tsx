/** 今日重點（稿 4 右欄）。 */
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, shadow, space } from '@/theme/tokens';
import type { SummaryCard } from './summaryCards';

const TONE: Record<SummaryCard['tone'], { fg: string; bg: string; icon: string }> = {
  danger: { fg: colors.danger, bg: colors.dangerSoft, icon: colors.danger },
  warning: { fg: colors.warning, bg: colors.warningSoft, icon: colors.warning },
  equipment: { fg: colors.primaryDark, bg: colors.primarySoft, icon: colors.primaryDark },
  info: { fg: colors.info, bg: colors.infoSoft, icon: colors.info },
};

export function TodayPanel({
  cards, loading, error, onRetry, onPress, dateLabel,
}: {
  cards?: SummaryCard[];
  loading: boolean;
  error: boolean;
  onRetry(): void;
  onPress(card: SummaryCard): void;
  dateLabel: string;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.title}>今日重點</Text>
        <Text style={styles.date}>{dateLabel}</Text>
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
            style={[styles.card, { backgroundColor: t.bg }]}
            onPress={() => onPress(c)}
            accessibilityRole="button"
            accessibilityLabel={`${c.title} ${c.count} 項`}
          >
            <View style={[styles.icon, { backgroundColor: t.icon }]}>
              <Ionicons name={c.icon} size={24} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.count, { color: t.fg }]}>{`${c.count} ${c.key === 'replenishments' ? '張' : '項'}`}</Text>
              <Text style={styles.cardTitle}>{c.title}</Text>
              <Text style={styles.detail} numberOfLines={1}>{c.detail}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  title: { fontSize: font.lg, fontWeight: '800', color: colors.text },
  date: { fontSize: font.sm, color: colors.textMuted },
  card: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.lg, padding: space.md },
  icon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  count: { fontSize: font.xl, fontWeight: '800' },
  cardTitle: { fontSize: font.md, color: colors.text, fontWeight: '600' },
  detail: { fontSize: font.sm, color: colors.textMuted },
  error: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  errorText: { color: colors.textMuted },
  retry: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
});
