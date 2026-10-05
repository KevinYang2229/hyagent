/** 首頁視覺：上方左右欄，常用情境跨整頁；手機改為單欄。 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { APP_IMAGES } from '@/brand/assets';
import { SCENARIOS } from './scenarios';
import { greeting, type SummaryCard } from './summaryCards';
import { TodayPanel } from './TodayPanel';

const INK = '#132544';
export interface HomeViewProps {
  wide: boolean;
  cards?: SummaryCard[];
  loading: boolean;
  error: boolean;
  errorMessage?: string;
  dateLabel: string;
  hour: number;
  onRetry(): void;
  onSummary(card: SummaryCard): void;
  onAll(): void;
  onVoice(): void;
  onPhoto(): void;
  onText(): void;
  onScenario(question: string): void;
}

export function HomeView(props: HomeViewProps) {
  const { width, height } = useWindowDimensions();
  const tabletLandscape = width > height && (props.wide || height >= 600);
  const wide = props.wide || tabletLandscape;
  const singleScenarioRow = wide;
  const [availableHeight, setAvailableHeight] = useState(0);
  // 使用扣除品牌列、導覽列與安全區後的實際高度，橫向平板整頁一次呈現。
  const heightScale = ((availableHeight || height - 136) - 30) / 578;
  const scale = wide ? Math.min(width / 1024, tabletLandscape ? heightScale : Math.max(0.72, heightScale), 1.35) : 1;
  const hero = (
    <View style={[styles.hero, { height: (wide ? 247 : 204) * scale }]}>
      <Image source={APP_IMAGES.homeHero} style={[styles.mascot, { width: (wide ? 330 : 150) * scale, height: (wide ? 250 : 190) * scale, left: (wide ? 28 : 0) * scale, bottom: (wide ? -16 : 0) * scale }]} resizeMode="contain" accessibilityLabel="Open醬揮手歡迎你" />
      <View style={[styles.bubble, { padding: (wide ? 22 : 16) * scale, paddingLeft: (wide ? 28 : 16) * scale, marginTop: 18 * scale, marginLeft: (wide ? 310 : 145) * scale, marginRight: wide ? 8 * scale : 0 }]}>
        <Text style={[styles.hello, { fontSize: (wide ? 25 : 21) * scale, lineHeight: (wide ? 36 : 29) * scale }]}>{`${greeting(props.hour)}！\n今天需要我幫你做什麼？`}</Text>
        <Text style={[styles.helloSub, { fontSize: (wide ? 17 : 13) * scale, lineHeight: (wide ? 25 : 20) * scale, marginTop: 18 * scale }]}>可以用語音、拍照或文字告訴我，{wide ? '\n' : ''}我會幫你查詢、分析並執行任務！</Text>
        <View style={styles.bubbleTail} />
        {wide ? <View pointerEvents="none" style={styles.emphasis}>
          <View style={[styles.mark, { transform: [{ rotate: '-9deg' }], top: 0, left: 0 }]} />
          <View style={[styles.mark, { transform: [{ rotate: '18deg' }], top: 6, left: 37 }]} />
          <View style={[styles.mark, { transform: [{ rotate: '45deg' }], top: 24, left: 73 }]} />
        </View> : null}
      </View>
    </View>
  );
  const entries = (
    <View style={[styles.entries, { gap: 8 * scale, height: (wide ? 176 : 144) * scale }]}>
      <Entry tone="voice" icon="mic" title="語音對話" sub="直接說出你的需求" scale={scale} wide={wide} onPress={props.onVoice} />
      <Entry tone="photo" icon="camera" title="拍照問 AI" sub="拍商品、貨架、設備" scale={scale} wide={wide} onPress={props.onPhoto} />
      <Entry tone="text" icon="keypad" title="輸入文字" sub="用打字詢問" scale={scale} wide={wide} onPress={props.onText} />
    </View>
  );
  const today = <TodayPanel cards={props.cards} loading={props.loading} error={props.error} errorMessage={props.errorMessage} onRetry={props.onRetry} onPress={props.onSummary} onAll={props.onAll} dateLabel={props.dateLabel} scale={scale} />;

  return (
    <View style={styles.viewport} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
    <ScrollView style={styles.scroll} scrollEnabled={!tabletLandscape} showsVerticalScrollIndicator={!tabletLandscape} showsHorizontalScrollIndicator={false} bounces={!tabletLandscape} contentContainerStyle={[styles.page, { paddingHorizontal: (wide ? 30 : 16) * scale, paddingTop: (wide ? 0 : 12) * scale, paddingBottom: 20 * scale, gap: (wide ? 0 : 16) * scale }]}>
      {wide ? (
        <View style={[styles.topRow, { gap: 12 * scale }]}>
          <View style={styles.main}>{hero}{entries}</View>
          <View style={{ width: '30%', paddingTop: 0 }}>{today}</View>
        </View>
      ) : <>{hero}{entries}{today}</>}
      <View style={[styles.scenarioSection, { marginTop: (wide ? 24 : 0) * scale, gap: (wide ? 4 : 8) * scale }]}>
        <Text style={[styles.section, { fontSize: 17 * scale, lineHeight: 22 * scale }]}>常用情境</Text>
        <View style={[styles.scenarios, { gap: 10 * scale, flexWrap: singleScenarioRow ? 'nowrap' : 'wrap' }]}>
          {SCENARIOS.map((s) => (
            <Pressable key={s.label} style={({ pressed }) => [styles.scenario, singleScenarioRow ? { flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0, height: 94 * scale } : { width: '30.8%', minHeight: 94 }, pressed && { opacity: 0.75 }]} onPress={() => props.onScenario(s.q)} accessibilityRole="button" accessibilityLabel={s.label}>
              <View style={[styles.scenarioIcon, { backgroundColor: s.soft }]}><Ionicons name={s.icon} size={34 * scale} color={s.color} /></View>
              <Text style={[styles.scenarioText, { fontSize: (wide ? 14 : 12) * scale }]} numberOfLines={1}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
    </View>
  );
}

function Entry({ icon, title, sub, onPress, tone, scale, wide }: { icon: 'mic' | 'camera' | 'keypad'; title: string; sub: string; onPress(): void; tone: 'voice' | 'photo' | 'text'; scale: number; wide: boolean }) {
  const primary = tone === 'voice';
  return (
    <Pressable style={({ pressed }) => [styles.entryFrame, { padding: 10 * scale }, pressed && { opacity: 0.8 }]} onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      <View style={[styles.entry, { backgroundColor: primary ? '#009579' : tone === 'photo' ? '#FFF8F0' : '#E6F5FF', paddingVertical: (wide ? 12 : 8) * scale }]}>
        <View style={[styles.entryIcon, { width: (wide ? 68 : 48) * scale, height: (wide ? 68 : 48) * scale, backgroundColor: primary ? 'rgba(0,115,88,0.28)' : tone === 'photo' ? '#F4EBF1' : '#D1EAFE' }]}>
          <MaterialCommunityIcons name={icon === "keypad" ? "keyboard" : icon === "mic" ? "microphone-outline" : "camera"} size={(wide ? 42 : 30) * scale} color={primary ? "#FFFFFF" : "#0076F6"} />
        </View>
        <Text style={[styles.entryTitle, { fontSize: (wide ? 23 : 17) * scale, lineHeight: (wide ? 28 : 22) * scale, color: primary ? '#FFFFFF' : INK }]}>{title}</Text>
        <Text style={[styles.entrySub, { fontSize: (wide ? 16 : 11) * scale, lineHeight: (wide ? 20 : 16) * scale, color: primary ? '#D6F6ED' : '#69788E' }]} numberOfLines={1}>{sub}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, minHeight: 0, overflow: 'hidden' },
  scroll: { flex: 1 },
  page: { flexGrow: 1 },
  topRow: { flexDirection: 'row', alignItems: 'flex-end' },
  main: { flex: 1, minWidth: 0 },
  hero: { flexDirection: 'row', alignItems: 'flex-start', overflow: 'visible' },
  mascot: { position: 'absolute', zIndex: 1 },
  bubble: { flex: 1, minWidth: 0, backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 30, position: 'relative' },
  bubbleTail: { position: 'absolute', bottom: -20, left: 30, width: 0, height: 0, borderTopWidth: 30, borderTopColor: '#FFFFFF', borderRightWidth: 26, borderRightColor: 'transparent' },
  hello: { fontWeight: '800', color: INK },
  helloSub: { color: '#465674', fontWeight: '600' },
  emphasis: { position: 'absolute', top: -36, left: '52%', width: 92, height: 52 },
  mark: { position: 'absolute', width: 12, height: 42, borderRadius: 8, backgroundColor: '#10AA8E' },
  entries: { flexDirection: 'row', zIndex: 1 },
  entryFrame: { flex: 1, minWidth: 0, backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 24, shadowColor: '#458B80', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  entry: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 18 },
  entryIcon: { borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  entryTitle: { fontWeight: '800' },
  entrySub: { fontWeight: '500' },
  scenarioSection: { paddingHorizontal: 8 },
  section: { color: INK, fontWeight: '800' },
  scenarios: { flexDirection: 'row', flexWrap: 'wrap' },
  scenario: { backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  scenarioIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  scenarioText: { color: '#65748A', fontWeight: '700' },
});
