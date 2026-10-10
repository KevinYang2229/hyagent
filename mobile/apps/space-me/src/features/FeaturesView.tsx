import { BrandHeader } from '@/chrome/BrandHeader';
import { pageTypography } from '@/brand/typography';
/** 產品特色（稿 1）：標題、介紹與八張特色卡；點卡片請 AI 顧問介紹該特色。 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PHOTOS } from '@/brand/assets';
import { shadow, sm } from '@/brand/theme';
import { ArrowDot, IconBadge, Page, useLandscapeLayout } from '@/chrome/Page';
import { FEATURES, featureQuestion } from '@/content/features';

export function FeaturesView({ wide, onAsk }: { wide: boolean; onAsk(question: string): void }) {
  const landscape = useLandscapeLayout();
  const rows = wide
    ? Array.from({ length: Math.ceil(FEATURES.length / 2) }, (_, index) => FEATURES.slice(index * 2, index * 2 + 2))
    : FEATURES.map((feature) => [feature]);
  return (
    <Page wide={wide} photo={PHOTOS.hero} photoHeight={wide ? 360 : 240}>
      <BrandHeader wide={wide} />
      <View style={{ maxWidth: 560, gap: 10, marginTop: landscape ? 16 : wide ? 40 : 24 }}>
        <Text style={pageTypography(wide).title}>產品特色</Text>
        <Text style={pageTypography(wide).subtitle}>以科技打造更智慧的空間使用體驗</Text>
        <Text style={pageTypography(wide).description}>SpaceMe 結合多項創新技術，從空間管理、環境控制到數據分析，全方位提升空間價值。</Text>
      </View>
      <View style={[styles.grid, { marginTop: landscape ? 36 : wide ? 52 : 40 }]}>
        {rows.map((row, index) => (
          <View key={index} style={styles.row}>
          {row.map((f) => (
          <Pressable
            key={f.title}
            onPress={() => onAsk(featureQuestion(f))}
            style={({ pressed }) => [styles.card, { flex: 1, padding: wide ? 18 : 16, gap: 14, minHeight: wide ? 112 : 100 }, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={`${f.title}：${f.desc}`}
          >
            <IconBadge name={f.icon} tint={f.tint} size={52} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.cardTitle}>{f.title}</Text>
              <Text style={styles.cardDesc}>{f.desc}</Text>
            </View>
            <ArrowDot size={24} />
          </Pressable>
          ))}
          </View>
        ))}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 14 },
  row: { flexDirection: 'row', gap: 14 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 18, minHeight: 116, backgroundColor: sm.card, borderRadius: 18, ...shadow.card },
  cardTitle: { fontSize: 20, lineHeight: 28, fontWeight: '800', color: sm.ink },
  cardDesc: { fontSize: 16, lineHeight: 24, color: sm.inkSoft },
});
