import { BrandHeader } from '@/chrome/BrandHeader';
import { pageTypography } from '@/brand/typography';
/** 解決方案（稿 3）：搜尋、方案大卡（照片＋圖示＋適用空間）。 */
import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PHOTOS } from '@/brand/assets';
import { shadow, sm } from '@/brand/theme';
import { ArrowDot, IconBadge, Page, useLandscapeLayout } from '@/chrome/Page';
import { SOLUTIONS, filterSolutions } from '@/content/solutions';

export interface SolutionsViewProps {
  wide: boolean;
  query: string;
  searchOpen: boolean;
  onQuery(q: string): void;
  onToggleSearch(): void;
  onOpen(id: string): void;
  onAsk(question: string): void;
}

export function SolutionsView({ wide, query, searchOpen, onQuery, onToggleSearch, onOpen, onAsk }: SolutionsViewProps) {
  const landscape = useLandscapeLayout();
  const list = filterSolutions(SOLUTIONS, 'all', query);
  const rows = wide
    ? Array.from({ length: Math.ceil(list.length / 2) }, (_, index) => list.slice(index * 2, index * 2 + 2))
    : list.map((solution) => [solution]);
  return (
    <Page wide={wide} photo={PHOTOS.hero} photoHeight={wide ? 300 : 220}>
      <BrandHeader wide={wide}>
        <Pressable onPress={onToggleSearch} style={styles.search} accessibilityRole="button" accessibilityLabel={searchOpen ? '關閉搜尋' : '搜尋解決方案'}>
          <Ionicons name={searchOpen ? 'close' : 'search'} size={24} color={sm.ink} />
        </Pressable>
      </BrandHeader>
      <Text style={[styles.title, pageTypography(wide).title]}>解決方案</Text>
      <Text style={[styles.subtitle, pageTypography(wide).description]}>針對不同場域，提供最適合的智慧空間管理方案。</Text>

      {searchOpen ? (
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color={sm.muted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={onQuery}
            placeholder="搜尋方案或空間，例如：討論室"
            placeholderTextColor={sm.muted}
            autoFocus
            returnKeyType="search"
            accessibilityLabel="搜尋關鍵字"
          />
        </View>
      ) : null}



      {list.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>找不到「{query.trim()}」相關的方案。</Text>
          <Pressable onPress={() => onAsk(`我想了解 SpaceMe 有沒有關於「${query.trim()}」的方案`)} style={styles.askBtn} accessibilityRole="button">
            <Ionicons name="chatbubbles-outline" size={18} color="#FFFFFF" />
            <Text style={styles.askText}>問 AI 產品顧問</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.grid, wide && { flexGrow: 1 }]}>
          {rows.map((row, index) => (
            <View key={index} style={[styles.row, wide && { flexGrow: 1 }]}>
            {row.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => onOpen(s.id)}
              style={({ pressed }) => [styles.card, { flex: 1 }, pressed && { opacity: 0.88 }]}
              accessibilityRole="button"
              accessibilityLabel={s.name}
            >
              <Image source={PHOTOS[s.photo]} style={[styles.photo, wide ? { flexGrow: 1, flexBasis: landscape ? 100 : 150, minHeight: 100 } : { height: 130 }]} resizeMode="cover" />
              <View style={styles.cardBody}>
                <IconBadge name={s.icon} tint={s.tint} size={50} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{s.name}</Text>
                  <Text style={styles.cardTags} numberOfLines={1}>{s.tags.join('・')}</Text>
                </View>
                <ArrowDot size={34} />
              </View>
            </Pressable>
            ))}
            {wide && row.length === 1 ? <View style={{ flex: 1 }} /> : null}
            </View>
          ))}
        </View>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  search: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', ...shadow.card },
  title: { marginTop: 12 },
  subtitle: { marginTop: 6 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, paddingHorizontal: 16, borderRadius: 999, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: sm.line, maxWidth: 520 },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 12, color: sm.ink },
  grid: { gap: 18, marginTop: 20 },
  row: { flexDirection: 'row', gap: 18 },
  card: { backgroundColor: sm.card, borderRadius: 22, overflow: 'hidden', ...shadow.card },
  photo: { width: '100%', overflow: 'hidden' },
  cardBody: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: sm.card, flexShrink: 0 },
  cardTitle: { fontSize: 19, fontWeight: '800', color: sm.ink },
  cardTags: { fontSize: 14, color: sm.inkSoft },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 48 },
  emptyText: { fontSize: 17, color: sm.inkSoft },
  askBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: sm.blue, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  askText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
});
