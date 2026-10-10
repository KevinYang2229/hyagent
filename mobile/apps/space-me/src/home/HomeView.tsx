import { BrandHeader } from '@/chrome/BrandHeader';
import { pageTypography } from '@/brand/typography';
/** 首頁（稿 4）：主視覺標語、探索按鈕、揮手的 HyAgent 機器人，下方四張情境入口卡。 */
import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { HOME_PHOTOS, PHOTOS } from '@/brand/assets';
import { RobotFigure } from '@/brand/Brand';
import { shadow, sm } from '@/brand/theme';
import { ArrowDot, Page, useLandscapeLayout } from '@/chrome/Page';

/** 首頁入口是「訪客會問的問題」，跟解決方案分頁的目錄卡區隔：問題交給 AI 顧問，展示預約導到聯絡頁。 */
export type HomeEntry =
  | { kind: 'ask'; question: string }
  | { kind: 'contact' };

interface HomeCard {
  title: string;
  desc: string;
  photo: keyof typeof HOME_PHOTOS;
  entry: HomeEntry;
}

export const HOME_CARDS: HomeCard[] = [
  { title: '我是圖書館', desc: '討論室、自習座位總是被佔用，該怎麼管？', photo: 'library', entry: { kind: 'ask', question: '我是圖書館，討論室與自習座位常被佔用又難以管理，SpaceMe 可以怎麼協助？' } },
  { title: '我是企業', desc: '想導入彈性座位與會議室預約', photo: 'office', entry: { kind: 'ask', question: '我們公司想導入彈性座位與會議室預約，OfficeMe 可以怎麼規劃？導入大概需要多久？' } },
  { title: '成功案例', desc: '眾多單位的選擇，見證 SpaceMe 的價值', photo: 'success', entry: { kind: 'ask', question: '有哪些單位使用 SpaceMe？請介紹成功案例' } },
  { title: '預約產品展示', desc: '由顧問團隊依您的場域實際示範', photo: 'demo', entry: { kind: 'contact' } },
];

export function HomeView({ wide, onExplore, onEntry, onSettings }: { wide: boolean; onSettings(): void; onExplore(): void; onEntry(entry: HomeEntry): void }) {
  const landscape = useLandscapeLayout();
  const { width, height } = useWindowDimensions();
  const robot = wide ? Math.min(landscape ? height * 0.3 : 290, width * 0.23) : Math.min(150, width * 0.34);
  return (
    <Page wide={wide} photo={PHOTOS.hero} photoHeight={wide ? 520 : 300}>
      <BrandHeader wide={wide}>
        <Pressable onPress={onSettings} style={styles.settings} accessibilityRole="button" accessibilityLabel="App 設定">
          <Ionicons name="settings-outline" size={22} color={sm.inkSoft} />
        </Pressable>
      </BrandHeader>
      <View style={[styles.hero, wide && styles.heroWide, landscape && { minHeight: 0, marginTop: 16 }]}>
        <View style={{ flex: 1, gap: landscape ? 10 : wide ? 18 : 12, maxWidth: wide ? 720 : 560, paddingRight: wide ? 0 : robot * 0.75 }}>
          <Text style={pageTypography(wide).title}>智慧空間，{'\n'}讓學習與工作更美好</Text>
          <Text style={[pageTypography(wide).description, { maxWidth: wide ? Math.min(460, (width - 64) * 0.38) : '100%' }]}>
            SpaceMe 提供圖書館與辦公空間的智慧管理解決方案，{'\n'}結合數位化與智慧化，打造更高效率、更友善的使用體驗。
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
                <Image source={HOME_PHOTOS[card.photo]} style={styles.photoWide} resizeMode="cover" accessible={false} />
              </View>
            ) : (
              <Image source={HOME_PHOTOS[card.photo]} style={styles.photoNarrow} resizeMode="cover" accessible={false} />
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
  settings: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hero: { marginTop: 28, gap: 16 },
  heroWide: { flexDirection: 'row', alignItems: 'center', minHeight: 280, marginTop: 28 },
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
  photoWide: { position: 'absolute', width: '100%', height: '100%', top: 0, left: 0, backgroundColor: sm.blueSoft },
  photoNarrow: { width: 96, height: 76, borderRadius: 14, flexShrink: 0, backgroundColor: sm.blueSoft },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: sm.ink },
  cardDesc: { fontSize: 14, lineHeight: 21, color: sm.inkSoft },
});
