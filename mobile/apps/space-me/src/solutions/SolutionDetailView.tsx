/** 方案詳細（稿 2 左半）：標題、標語、介紹與各空間類型卡；每張卡都能一鍵請 AI 顧問說明。 */
import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { PHOTOS } from '@/brand/assets';
import { shadow, sm } from '@/brand/theme';
import { ArrowDot, Page } from '@/chrome/Page';
import type { Solution } from '@/content/solutions';

export function itemQuestion(solution: Solution, title: string): string {
  return `請介紹${solution.name}的「${title}」`;
}

export function SolutionDetailView({ solution, wide, onBack, onAsk }: { solution: Solution; wide: boolean; onBack(): void; onAsk(question: string): void }) {
  return (
    <Page wide={wide} photo={PHOTOS[solution.photo]} photoHeight={wide ? 420 : 260}>
      <Pressable onPress={onBack} style={styles.back} hitSlop={8} accessibilityRole="button" accessibilityLabel="返回解決方案">
        <Ionicons name="chevron-back" size={22} color={sm.blue} />
        <Text style={styles.backText}>解決方案</Text>
      </Pressable>
      <View style={{ maxWidth: 560, gap: 10, marginTop: wide ? 48 : 24 }}>
        <Text style={[styles.title, { fontSize: wide ? 42 : 30 }]}>{solution.name}</Text>
        <Text style={[styles.headline, { fontSize: wide ? 24 : 19 }]}>{solution.headline}</Text>
        <Text style={styles.intro}>{solution.intro}</Text>
        <Pressable onPress={() => onAsk(`${solution.name}有哪些功能？`)} style={({ pressed }) => [styles.ask, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Ionicons name="chatbubbles-outline" size={18} color="#FFFFFF" />
          <Text style={styles.askText}>問 AI 產品顧問</Text>
        </Pressable>
      </View>

      <View style={[styles.items, { flexDirection: wide ? 'row' : 'column' }]}>
        {solution.items.map((item) => (
          <Pressable
            key={item.title}
            onPress={() => onAsk(itemQuestion(solution, item.title))}
            style={({ pressed }) => [styles.item, wide && { flex: 1, maxWidth: 300 }, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}：${item.desc}`}
          >
            <Image source={PHOTOS[item.photo]} style={[styles.photo, { height: wide ? 140 : 160 }]} resizeMode="cover" />
            <View style={styles.itemBody}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.itemDesc}>{item.desc}</Text>
              <ArrowDot size={26} />
            </View>
          </Pressable>
        ))}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', paddingVertical: 6, paddingRight: 12, paddingLeft: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.9)' },
  backText: { fontSize: 16, fontWeight: '700', color: sm.blue },
  title: { fontWeight: '900', color: sm.ink },
  headline: { fontWeight: '800', color: sm.ink },
  intro: { fontSize: 17, lineHeight: 28, color: sm.inkSoft, fontWeight: '500' },
  ask: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', backgroundColor: sm.blue, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999, marginTop: 6 },
  askText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  items: { gap: 16, marginTop: 32 },
  item: { backgroundColor: sm.card, borderRadius: 20, overflow: 'hidden', ...shadow.card },
  photo: { width: '100%' },
  itemBody: { padding: 16, gap: 6 },
  itemTitle: { fontSize: 20, fontWeight: '800', color: sm.ink },
  itemDesc: { fontSize: 15, lineHeight: 22, color: sm.inkSoft, marginBottom: 6 },
});
