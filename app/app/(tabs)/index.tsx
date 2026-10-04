/** 首頁（稿 4）：問候、三個入口、常用情境；寬版右欄今日重點。 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';
import { SCENARIOS } from '@/home/scenarios';
import { formatMonthDay, greeting, summaryCards, type SummaryCard } from '@/home/summaryCards';
import { TodayPanel } from '@/home/TodayPanel';
import { useTodaySummary } from '@/home/useTodaySummary';
import { useIsWide } from '@/layout/useIsWide';
import { chatRoute } from '@/navigation/chatRoute';
import { colors, font, radius, shadow, space } from '@/theme/tokens';

export default function Home() {
  const wide = useIsWide();
  const summary = useTodaySummary();
  const now = new Date();

  const onCard = (c: SummaryCard) => {
    if (c.action.kind === 'tasks') router.navigate('/tasks');
    else router.navigate(chatRoute({ q: c.action.q }));
  };

  const today = (
    <TodayPanel
      cards={summary.data ? summaryCards(summary.data) : undefined}
      loading={summary.isLoading}
      error={summary.isError}
      onRetry={() => void summary.refetch()}
      onPress={onCard}
      dateLabel={formatMonthDay(now)}
    />
  );

  const main = (
    <View style={{ gap: space.lg }}>
      <View style={styles.hero}>
        <Mascot pose="wave" size={wide ? 200 : 120} />
        <View style={styles.bubble}>
          <Text style={styles.hello}>{`${greeting(now.getHours())}！\n今天需要我幫你做什麼？`}</Text>
          <Text style={styles.helloSub}>可以用語音、拍照或文字告訴我，我會幫你查詢、分析並執行任務！</Text>
        </View>
      </View>
      <View style={[styles.entries, !wide && { flexWrap: 'wrap' }]}>
        <Entry primary icon="mic" title="語音對話" sub="直接說出你的需求" onPress={() => router.navigate(chatRoute({ voice: '1' }))} />
        <Entry icon="camera" title="拍照問 AI" sub="拍貨架、優惠券" onPress={() => router.push({ pathname: '/camera', params: { mode: 'shelf' } })} />
        <Entry icon="keypad" title="輸入文字" sub="用打字詢問" onPress={() => router.navigate(chatRoute({ focus: '1' }))} />
      </View>
      {!wide ? today : null}
      <View style={{ gap: space.sm }}>
        <Text style={styles.section}>常用情境</Text>
        <View style={styles.scenarios}>
          {SCENARIOS.map((s) => (
            <Pressable key={s.label} style={styles.scenario} onPress={() => router.navigate(chatRoute({ q: s.q }))} accessibilityRole="button" accessibilityLabel={s.label}>
              <Ionicons name={s.icon} size={28} color={s.color} />
              <Text style={styles.scenarioText}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.page}>
      {wide ? (
        <View style={{ flexDirection: 'row', gap: space.lg }}>
          <View style={{ flex: 1 }}>{main}</View>
          <View style={{ width: 340 }}>{today}</View>
        </View>
      ) : (
        main
      )}
    </ScrollView>
  );
}

function Entry({ icon, title, sub, onPress, primary }: { icon: 'mic' | 'camera' | 'keypad'; title: string; sub: string; onPress(): void; primary?: boolean }) {
  return (
    <Pressable style={[styles.entry, primary && { backgroundColor: colors.primary }]} onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      <View style={[styles.entryIcon, primary && { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
        <Ionicons name={icon} size={28} color={primary ? '#fff' : colors.info} />
      </View>
      <Text style={[styles.entryTitle, primary && { color: '#fff' }]}>{title}</Text>
      <Text style={[styles.entrySub, primary && { color: 'rgba(255,255,255,0.85)' }]}>{sub}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg },
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  bubble: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.xl, padding: space.lg, ...shadow.card },
  hello: { fontSize: font.xxl, fontWeight: '800', color: colors.text },
  helloSub: { fontSize: font.md, color: colors.textMuted, marginTop: space.sm },
  entries: { flexDirection: 'row', gap: space.md },
  entry: { flex: 1, minWidth: 150, alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: radius.xl, paddingVertical: space.xl, ...shadow.card },
  entryIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.infoSoft, alignItems: 'center', justifyContent: 'center' },
  entryTitle: { fontSize: font.xl, fontWeight: '800', color: colors.text },
  entrySub: { fontSize: font.sm, color: colors.textMuted },
  section: { fontSize: font.lg, fontWeight: '700', color: colors.text },
  scenarios: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  scenario: { width: 120, alignItems: 'center', gap: space.sm, backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: space.lg, ...shadow.card },
  scenarioText: { fontSize: font.sm, color: colors.text },
});
