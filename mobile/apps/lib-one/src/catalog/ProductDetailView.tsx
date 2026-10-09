/**
 * 產品詳細頁畫面（稿 06）：左側同系列產品縮圖、大展示圖；右側名稱、說明、四格亮點、聯絡諮詢。
 * 下方再列官網功能條列，並提供「問 HyAgent」「加入比較」。路由在 app/(tabs)/products/[id].tsx。
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { lib } from '@/brand/theme';
import { getCategory, productsIn, type Product } from './catalog';
import { ProductArt } from './ProductArt';

export interface ProductDetailViewProps {
  product: Product;
  wide: boolean;
  width: number;
  /** 視窗高度：量到實際可用高度前用來估計 */
  height?: number;
  inCompare: boolean;
  onOpen(p: Product): void;
  onContact(): void;
  onAsk(): void;
  onToggleCompare(): void;
}

export function ProductDetailView({ product, wide, width, height = 800, inCompare: selected, onOpen: open, onContact, onAsk, onToggleCompare }: ProductDetailViewProps) {
  const siblings = productsIn(product.category);
  const category = getCategory(product.category);
  const [areaH, setAreaH] = useState(0);
  // 展示圖區實際量到的高度：縮圖大小以它為上限
  const [stageBoxH, setStageBoxH] = useState(0);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const available = areaH || height - 150;
  // iPad 直放（寬 700 以上、未達平板橫放）：產品特色排兩欄、直接展開
  const tablet = !wide && width >= 700;
  const phone = !wide && !tablet;
  const stageH = wide ? Math.max(available - 48, 320) : stageBoxH || 260;
  // 縮圖由上往下排，大小以放得進展示圖高度為上限（每張外框與間距約 20）
  const thumbSize = Math.max(44, Math.min(wide ? 132 : tablet ? 110 : 64, Math.floor(stageH / Math.max(siblings.length, 1)) - 20));

  const thumbs = siblings.length > 1 ? (
    <View style={[styles.thumbs, wide ? { height: stageH } : { height: '100%' }]}>
      {siblings.map((p) => (
        <Pressable key={p.id} onPress={() => open(p)} style={[styles.thumb, p.id === product.id && styles.thumbOn]} accessibilityRole="tab" accessibilityState={{ selected: p.id === product.id }} accessibilityLabel={p.name}>
          <ProductArt icon={p.icon} image={p.image} size={thumbSize} label={p.name} fill={0.86} style={{ width: thumbSize, borderRadius: 12 }} />
        </Pressable>
      ))}
    </View>
  ) : null;

  const info = (
    <View style={{ gap: phone ? 12 : 16 }}>
      <View>
        {category ? <Text style={[styles.eyebrow, phone && { fontSize: 14 }]}>{category.no}  {category.title}</Text> : null}
        <Text style={[styles.name, { fontSize: wide ? 34 : phone ? 25 : 30 }]}>{product.name}</Text>
        <Text style={[styles.nameEn, phone && { fontSize: 17, marginTop: 2 }]}>{product.nameEn}</Text>
      </View>
      <Text style={[styles.summary, phone && { fontSize: 16, lineHeight: 24 }]} numberOfLines={phone ? 2 : undefined}>{product.summary}</Text>
      <View style={styles.highlights}>
        {product.highlights.slice(0, 4).map((h) => (
          <View key={h.label} style={[styles.highlight, phone && { paddingVertical: 10, gap: 6 }]}>
            <View style={[styles.highlightIcon, phone && { width: 40, height: 40, borderRadius: 12 }]}><MaterialCommunityIcons name={h.icon} size={phone ? 22 : 28} color={lib.greenDark} /></View>
            <Text style={[styles.highlightText, phone && { fontSize: 14 }]}>{h.label}</Text>
          </View>
        ))}
      </View>
      <Pressable onPress={onContact} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]} accessibilityRole="button">
        <Text style={styles.primaryText}>聯絡諮詢</Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable onPress={onAsk} style={styles.secondary} accessibilityRole="button">
          <MaterialCommunityIcons name="star-four-points" size={18} color={lib.greenDark} />
          <Text style={styles.secondaryText}>問 HyAgent</Text>
        </Pressable>
        <Pressable onPress={onToggleCompare} style={[styles.secondary, selected && styles.secondaryOn]} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}>
          <Ionicons name={selected ? 'checkmark' : 'git-compare-outline'} size={18} color={selected ? '#FFFFFF' : lib.greenDark} />
          <Text style={[styles.secondaryText, selected && { color: '#FFFFFF' }]}>{selected ? '已加入比較' : '加入比較'}</Text>
        </Pressable>
      </View>
    </View>
  );

  // 平板：產品特色兩欄，卡片撐滿剩下的高度、各列平均分配，不留空洞
  const features = (
    <View style={[styles.features, { flex: 1 }]}>
      <Text style={styles.featuresTitle}>產品特色</Text>
      <View style={styles.featureGrid}>
        {product.features.map((f) => (
          <View key={f} style={[styles.feature, styles.featureCell]}>
            <Ionicons name="checkmark-circle" size={22} color={lib.green} />
            <Text style={[styles.featureText, wide && { fontSize: 17, lineHeight: 23 }]} numberOfLines={2}>{f}</Text>
          </View>
        ))}
      </View>
    </View>
  );

  if (wide) {
    const stageW = Math.min(width * 0.32, stageH * 0.9, 440);
    return (
      <ScrollView onLayout={(e) => setAreaH(e.nativeEvent.layout.height)} alwaysBounceVertical={false} contentContainerStyle={styles.pageWide}>
        <View style={{ flexDirection: 'row', gap: 24, height: stageH }}>
          {thumbs}
          <ProductArt icon={product.icon} image={product.image} size={stageH} label={product.name} fill={0.86} style={{ width: stageW, borderRadius: 24 }} />
          <View style={{ flex: 1, gap: 14 }}>
            {info}
            {features}
          </View>
        </View>
      </ScrollView>
    );
  }
  // iPad 直放與手機：資訊與產品特色排在下方，展示圖（含左側縮圖）撐滿剩下的高度，不留空。
  // 手機的產品特色預設收起，點開才展開（展開後可捲動）。
  const phoneFeatures = (
    <View style={styles.features}>
      <Pressable onPress={() => setFeaturesOpen(!featuresOpen)} style={styles.featuresToggle} accessibilityRole="button" accessibilityState={{ expanded: featuresOpen }}>
        <Text style={styles.featuresTitle}>產品特色（{product.features.length} 項）</Text>
        <Ionicons name={featuresOpen ? 'chevron-up' : 'chevron-down'} size={20} color={lib.inkSoft} />
      </Pressable>
      {featuresOpen ? product.features.map((f) => (
        <View key={f} style={styles.feature}>
          <Ionicons name="checkmark-circle" size={22} color={lib.green} />
          <Text style={styles.featureText}>{f}</Text>
        </View>
      )) : null}
    </View>
  );
  return (
    <ScrollView
      onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}
      alwaysBounceVertical={false}
      contentContainerStyle={[styles.page, phone && styles.pagePhone, { minHeight: available }]}
    >
      <View style={{ flexDirection: 'row', gap: 10, flex: 1, minHeight: phone ? 120 : 240 }} onLayout={(e) => setStageBoxH(Math.round(e.nativeEvent.layout.height))}>
        {thumbs}
        <ProductArt icon={product.icon} image={product.image} size={stageH} label={product.name} fill={0.88} style={{ flex: 1, height: '100%', borderRadius: 24 }} />
      </View>
      {info}
      {phone ? phoneFeatures : <View style={{ minHeight: 150 }}>{features}</View>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 18, gap: 16, paddingBottom: 24 },
  pagePhone: { paddingVertical: 12, gap: 12 },
  pageWide: { paddingHorizontal: 32, paddingVertical: 24 },
  thumbs: { justifyContent: 'flex-start', gap: 12 },
  thumb: { borderRadius: 14, borderWidth: 2, borderColor: 'transparent', padding: 2 },
  thumbOn: { borderColor: lib.green },
  eyebrow: { fontSize: 15, fontWeight: '800', color: lib.green, marginBottom: 4, letterSpacing: 0.5 },
  name: { fontWeight: '900', color: lib.ink },
  nameEn: { fontSize: 21, color: lib.inkSoft, marginTop: 8 },
  summary: { fontSize: 19, lineHeight: 29, color: lib.inkSoft },
  highlights: { flexDirection: 'row', gap: 12 },
  highlight: { flex: 1, alignItems: 'center', gap: 10, paddingVertical: 16, paddingHorizontal: 6, borderRadius: 18, backgroundColor: '#FFFFFF', shadowColor: lib.greenDark, shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  highlightIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenSoft },
  highlightText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: lib.ink, textAlign: 'center' },
  primary: { alignItems: 'center', paddingVertical: 17, borderRadius: 999, backgroundColor: lib.greenDark, shadowColor: lib.greenDark, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  primaryText: { fontSize: 21, fontWeight: '800', color: '#FFFFFF', letterSpacing: 2 },
  row: { flexDirection: 'row', gap: 10 },
  secondary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 999, borderWidth: 1.5, borderColor: '#CFE8D6', backgroundColor: '#FFFFFF' },
  secondaryOn: { backgroundColor: lib.greenDark, borderColor: lib.greenDark },
  secondaryText: { fontSize: 17, fontWeight: '800', color: lib.greenDark },
  features: { gap: 10, paddingHorizontal: 20, paddingVertical: 16, borderRadius: 20, backgroundColor: '#FFFFFF' },
  featuresToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  featuresTitle: { fontSize: 21, fontWeight: '900', color: lib.ink, marginBottom: 4 },
  featureGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  featureCell: { width: '50%', paddingRight: 10 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  featureText: { flexShrink: 1, fontSize: 19, lineHeight: 26, fontWeight: '700', color: lib.ink },
});
