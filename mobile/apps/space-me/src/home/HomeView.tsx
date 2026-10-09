/** 首頁（稿 4）：主視覺標語、探索按鈕、揮手的 HyAgent 機器人，下方四張入口卡。 */
import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { PHOTOS, type PhotoKey } from '@/brand/assets';
import { RobotFigure, SpaceMeLogo } from '@/brand/Brand';
import { shadow, sm, type Tint } from '@/brand/theme';
import { ArrowDot, IconBadge, Page, useLandscapeLayout } from '@/chrome/Page';

export type HomeEntry =
  | { kind: 'solution'; id: string }
  | { kind: 'ask'; question: string };

interface HomeCard {
  title: string;
  desc: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: Tint;
  photo: PhotoKey;
  entry: HomeEntry;
}

export const HOME_CARDS: HomeCard[] = [
  { title: '圖書館空間管理', desc: '討論室、研究小間、自習室、視聽座位、電腦座位', icon: 'book-outline', tint: 'purple', photo: 'library', entry: { kind: 'solution', id: 'library' } },
  { title: 'OfficeMe 智慧辦公空間', desc: '彈性辦公、會議室、共享空間', icon: 'business-outline', tint: 'blue', photo: 'office', entry: { kind: 'solution', id: 'office' } },
  { title: '智慧環控與數據分析', desc: '提升空間體驗，優化使用價值', icon: 'leaf-outline', tint: 'green', photo: 'environment', entry: { kind: 'solution', id: 'environment' } },
  { title: '成功案例', desc: '眾多單位的選擇，見證 SpaceMe 的價值', icon: 'trophy-outline', tint: 'orange', photo: 'roomReading', entry: { kind: 'ask', question: '有哪些單位使用 SpaceMe？請介紹成功案例' } },
];

export function HomeView({ wide, onExplore, onEntry, onSettings }: { wide: boolean; onSettings(): void; onExplore(): void; onEntry(entry: HomeEntry): void }) {
  const landscape = useLandscapeLayout();
  const { width, height } = useWindowDimensions();
  const robot = wide ? Math.min(landscape ? height * 0.3 : 290, width * 0.23) : Math.min(150, width * 0.34);
  return (
    <Page wide={wide} photo={PHOTOS.hero} photoHeight={wide ? 520 : 300}>
      <View style={styles.topBar}>
        <SpaceMeLogo size={wide ? 30 : 24} />
        <Pressable onPress={onSettings} style={styles.settings} accessibilityRole="button" accessibilityLabel="App 設定">
          <Ionicons name="settings-outline" size={22} color={sm.inkSoft} />
        </Pressable>
      </View>
      <View style={[styles.hero, wide && styles.heroWide, landscape && { minHeight: 0, marginTop: 16 }]}>
        <View style={{ flex: 1, gap: landscape ? 10 : wide ? 18 : 12, maxWidth: 560, paddingRight: wide ? 0 : robot * 0.75 }}>
          <Text style={[styles.headline, { fontSize: landscape ? 36 : wide ? 44 : 28, lineHeight: landscape ? 46 : wide ? 58 : 38 }]}>智慧空間，{'\n'}讓學習與工作更美好</Text>
          <Text style={[styles.intro, { fontSize: wide ? 18 : 15 }]}>
            SpaceMe 提供圖書館與辦公空間的智慧管理解決方案，結合數位化與智慧化，打造更高效率、更友善的使用體驗。
          </Text>
          <Pressable onPress={onExplore} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            <Text style={styles.ctaText}>探索 SpaceMe</Text>
            <Ionicons name="arrow-forward" size={20} color="#FFFFFF" />
          </Pressable>
        </View>
        <View style={wide ? styles.robotWide : styles.robotNarrow}><RobotFigure width={robot} /></View>
      </View>

      <View style={[styles.cards, { flexDirection: wide ? 'row' : 'column', marginTop: landscape ? 20 : 32 }, wide && { flexGrow: 1 }]}>
        {HOME_CARDS.map((card) => (
          <Pressable
            key={card.title}
            onPress={() => onEntry(card.entry)}
            style={({ pressed }) => [styles.card, wide ? styles.cardWide : styles.cardNarrow, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={card.title}
          >
            {wide ? (
              <View style={styles.cardTop}>
                <Image source={PHOTOS[card.photo]} style={styles.thumb} resizeMode="cover" />
                <View style={styles.wideBadge}><IconBadge name={card.icon} tint={card.tint} size={44} /></View>
              </View>
            ) : (
              // 手機寬度有限：只放照片，圖示疊在照片角落，讓標題完整顯示
              <View>
                <Image source={PHOTOS[card.photo]} style={styles.thumbNarrow} resizeMode="cover" />
                <View style={styles.badgeOnPhoto}><IconBadge name={card.icon} tint={card.tint} size={34} /></View>
              </View>
            )}
            <View style={[styles.cardBody, wide ? styles.cardBodyWide : { flex: 1 }]}>
              <View style={styles.titleRow}>
                <Text style={[styles.cardTitle, wide && { fontSize: 18, lineHeight: 24 }]} numberOfLines={2}>{card.title}</Text>
                <ArrowDot size={wide ? 28 : 24} />
              </View>
              <Text style={[styles.cardDesc, wide && { fontSize: 15, lineHeight: 23 }]} numberOfLines={2}>{card.desc}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settings: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hero: { marginTop: 28, gap: 16 },
  heroWide: { flexDirection: 'row', alignItems: 'flex-end', minHeight: 360, marginTop: 40 },
  headline: { fontWeight: '900', color: sm.ink },
  intro: { lineHeight: 28, color: sm.inkSoft, fontWeight: '500' },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start', backgroundColor: sm.blue, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 999, marginTop: 6, ...shadow.card },
  ctaText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  robotWide: { marginLeft: 'auto', marginRight: 8, marginBottom: -20 },
  robotNarrow: { position: 'absolute', right: -8, top: -10 },
  cards: { gap: 16, marginTop: 32 },
  card: { backgroundColor: sm.card, borderRadius: 22, padding: 16, gap: 14, ...shadow.card },
  cardNarrow: { flexDirection: 'row', alignItems: 'center' },
  cardWide: { flex: 1, padding: 0, gap: 0, minHeight: 240, overflow: 'hidden' },
  cardBody: { gap: 8 },
  cardBodyWide: { padding: 16, minHeight: 128, flexShrink: 0 },
  cardTop: { flexGrow: 1, minHeight: 112 },
  wideBadge: { position: 'absolute', left: 12, bottom: 10, borderRadius: 16, borderWidth: 3, borderColor: '#FFFFFF', ...shadow.card },
  thumb: { position: 'absolute', width: '100%', height: '100%', top: 0, left: 0 },
  thumbNarrow: { width: 96, height: 76, borderRadius: 14 },
  badgeOnPhoto: { position: 'absolute', left: -6, bottom: -6, borderRadius: 12, borderWidth: 2, borderColor: '#FFFFFF' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: sm.ink },
  cardDesc: { fontSize: 14, lineHeight: 21, color: sm.inkSoft },
});
