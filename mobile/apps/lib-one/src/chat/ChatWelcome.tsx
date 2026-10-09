/**
 * HyAgent 對話的起始畫面（還沒有任何訊息時）：大頭像問候，加上六張「你可以這樣問」問題卡，
 * 卡片撐滿畫面（平板三欄、手機兩欄），點一下就送出。有訊息後只留精簡的問候列。
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { HyAgentAvatar } from '@/brand/Brand';
import { lib } from '@/brand/theme';
import { CATEGORIES } from '@/catalog/catalog';

export const GREETING = '你好，我是 HyAgent！我可以介紹 LIB ONE 的設備與服務、比較不同產品，也能依你的館舍規模推薦方案。';

type PromptIcon = 'turnstile-outline' | 'book-arrow-left' | 'seat' | 'desktop-tower-monitor' | 'lightbulb-on-outline' | 'compare-horizontal';

export const WELCOME_PROMPTS: { label: string; icon: PromptIcon; q: string }[] = [
  ...CATEGORIES.map((c) => ({ label: `${c.no} ${c.title}`, icon: c.icon as PromptIcon, q: c.question })),
  { label: '方案推薦', icon: 'lightbulb-on-outline', q: '中小型圖書館適合導入哪些 LIB ONE 設備？' },
  { label: '產品比較', icon: 'compare-horizontal', q: '直立式與桌上型自助借還書機差在哪？各適合哪種圖書館？' },
];

export function ChatWelcome({ full, wide, onAsk }: { full: boolean; wide: boolean; onAsk(q: string): void }) {
  const { width, height } = useWindowDimensions();
  if (!full) {
    return (
      <View style={styles.compact}>
        <HyAgentAvatar size={40} />
        <Text style={styles.compactText}>{GREETING}</Text>
      </View>
    );
  }
  // 平板直放：兩欄三列、字放大，卡片不會又高又空
  const portraitTablet = wide && height > width;
  const cols = wide && !portraitTablet ? 3 : 2;
  return (
    <View style={styles.full}>
      <View style={styles.hero}>
        <HyAgentAvatar size={wide ? 84 : 60} />
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={[styles.heroTitle, !wide && { fontSize: 22 }]}>你好，我是 HyAgent</Text>
          <Text style={[styles.heroText, !wide && { fontSize: 15, lineHeight: 22 }]}>
            介紹 LIB ONE 設備與服務、比較產品、依館舍規模推薦方案。直接輸入問題、按麥克風說話，或從下面挑一個開始。
          </Text>
        </View>
      </View>
      <Text style={[styles.section, !wide && { fontSize: 17 }]}>你可以這樣問</Text>
      {/* 依欄數切成列，列與列、卡與卡之間都固定 GAP，卡片仍平均撐滿高度 */}
      <View style={styles.grid}>
        {Array.from({ length: Math.ceil(WELCOME_PROMPTS.length / cols) }, (_, r) => WELCOME_PROMPTS.slice(r * cols, r * cols + cols)).map((row, r) => (
        <View key={r} style={styles.gridRow}>
        {row.map((p) => (
          <Pressable
            key={p.label}
            onPress={() => onAsk(p.q)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={p.q}
          >
            <View style={styles.cardHead}>
              <View style={[styles.icon, !wide && { width: 36, height: 36, borderRadius: 10 }]}>
                <MaterialCommunityIcons name={p.icon} size={wide ? 26 : 20} color={lib.greenDark} />
              </View>
              <Text style={[styles.cardLabel, !wide && { fontSize: 13 }]} numberOfLines={1}>{p.label}</Text>
            </View>
            <Text style={[styles.cardQ, !wide && { fontSize: 15, lineHeight: 21 }, portraitTablet && { fontSize: 22, lineHeight: 31 }]} numberOfLines={3}>{p.q}</Text>
            <View style={styles.ask}>
              <MaterialCommunityIcons name="star-four-points" size={14} color={lib.green} />
              <Text style={styles.askText}>問 HyAgent</Text>
            </View>
          </Pressable>
        ))}
        </View>
        ))}
      </View>
    </View>
  );
}

/** 卡片之間的間距 */
const GAP = 12;

const card = { backgroundColor: '#FFFFFF', borderRadius: 18, shadowColor: lib.greenDark, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 };

const styles = StyleSheet.create({
  compact: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: lib.line, maxWidth: 760, marginBottom: 12 },
  compactText: { flex: 1, fontSize: 17, lineHeight: 27, color: lib.ink },
  full: { flex: 1, gap: 14, paddingBottom: 4 },
  hero: { ...card, flexDirection: 'row', alignItems: 'center', gap: 18, padding: 20, backgroundColor: lib.greenSoft },
  heroTitle: { fontSize: 28, fontWeight: '900', color: lib.ink },
  heroText: { fontSize: 18, lineHeight: 27, color: lib.inkSoft },
  section: { fontSize: 20, fontWeight: '900', color: lib.ink },
  grid: { flex: 1, gap: GAP },
  gridRow: { flex: 1, flexDirection: 'row', gap: GAP },
  card: { ...card, flex: 1, minHeight: 120, padding: 16, gap: 12, justifyContent: 'center' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenSoft },
  cardLabel: { flex: 1, fontSize: 15, fontWeight: '800', color: lib.green },
  cardQ: { fontSize: 18, lineHeight: 26, fontWeight: '800', color: lib.ink },
  ask: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  askText: { fontSize: 14, fontWeight: '800', color: lib.green },
});
