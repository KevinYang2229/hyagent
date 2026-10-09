/**
 * 產品探索畫面（稿 03／04）：分類膠囊篩選、產品格狀卡、勾選比較。
 * 欄數與圖大小依可用空間計算（gridFit），盡量一屏放完；路由在 app/(tabs)/products/index.tsx。
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { lib } from '@/brand/theme';
import { MAX_COMPARE } from './agentBridge';
import { CATEGORIES, getCategory, productsIn, type CategoryId } from './catalog';
import { useCompare } from './CompareStore';
import { GRID_SIDE_PADDING, fitGrid, tabletCard } from './gridFit';
import { ProductGridCard } from './ProductCards';

/** 平板卡片尺寸以項目最多的分類為準：換分類、轉方向，卡片都一樣大 */
const SIZING_COUNT = Math.max(...CATEGORIES.map((c) => productsIn(c.id).length));

export interface ProductsViewProps {
  category?: CategoryId;
  onSelectCategory(id?: CategoryId): void;
  onOpenProduct(id: string): void;
  onCompare(): void;
}

export function ProductsView({ category: categoryId, onSelectCategory: select, onOpenProduct, onCompare }: ProductsViewProps) {
  const category = getCategory(categoryId);
  const products = productsIn(category?.id);
  const compare = useCompare();
  const [notice, setNotice] = useState('');
  const { width, height: windowH } = useWindowDimensions();
  const [area, setArea] = useState({ width: 0, height: 0 });
  // 平板卡寬固定、橫放三欄直放兩欄；圖片高度依可用高度調整，盡量一屏放完。比較列出現時扣掉它的高度
  const listH = (area.height || windowH - 230) - 8;
  const fit = fitGrid({
    count: products.length,
    width: (area.width || width) - GRID_SIDE_PADDING,
    height: listH - (compare.ids.length > 0 ? 92 : 0),
    wide: Math.min(width, windowH) >= 700,
    landscape: width > windowH,
    // 清單以外的高度（品牌列、分類列、導覽列）兩個方向相同，用目前方向量到的值推算另一個方向
    card: tabletCard({ sizingCount: SIZING_COUNT, screenW: width, screenH: windowH, chromeH: windowH - listH }),
  });
  const toggle = (id: string) => setNotice(compare.toggle(id) ? '' : `最多比較 ${MAX_COMPARE} 項，請先取消其他產品`);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsBar} contentContainerStyle={styles.chips}>
        <Chip label="全部" selected={!category} onPress={() => select()} />
        {CATEGORIES.map((c) => <Chip key={c.id} label={`${c.no} ${c.title}`} selected={category?.id === c.id} onPress={() => select(c.id)} />)}
      </ScrollView>
      <ScrollView
        onLayout={(e) => setArea({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
        scrollEnabled={!fit.fits}
        alwaysBounceVertical={false}
        contentContainerStyle={[styles.page, compare.ids.length > 0 && { paddingBottom: 110 }]}
      >
        <View style={[styles.grid, fit.cellWidth ? { width: fit.cellWidth * fit.columns } : null]}>
          {products.map((p) => (
            <View key={p.id} style={{ width: fit.cellWidth ?? `${100 / fit.columns}%`, padding: 9 }}>
              <ProductGridCard
                product={p}
                selected={compare.has(p.id)}
                onOpen={() => onOpenProduct(p.id)}
                onToggleCompare={() => toggle(p.id)}
                artSize={fit.artSize}
                compact={fit.compact}
              />
            </View>
          ))}
        </View>
      </ScrollView>
      {compare.ids.length > 0 ? (
        <View style={styles.compareBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.compareTitle}>已選 {compare.ids.length} 項產品</Text>
            <Text style={styles.compareHint}>{notice || (compare.ids.length < 2 ? '再選一項即可比較' : `最多 ${MAX_COMPARE} 項`)}</Text>
          </View>
          <Pressable onPress={compare.clear} style={styles.clear} accessibilityRole="button"><Text style={styles.clearText}>清除</Text></Pressable>
          <Pressable
            disabled={compare.ids.length < 2}
            onPress={onCompare}
            style={[styles.go, compare.ids.length < 2 && { opacity: 0.45 }]}
            accessibilityRole="button"
            accessibilityState={{ disabled: compare.ids.length < 2 }}
          >
            <Ionicons name="git-compare-outline" size={18} color="#FFFFFF" />
            <Text style={styles.goText}>開始比較</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipOn]} accessibilityRole="tab" accessibilityState={{ selected }}>
      <Text style={[styles.chipText, selected && { color: '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chipsBar: { flexGrow: 0, flexShrink: 0 },
  chips: { gap: 10, paddingHorizontal: 24, paddingVertical: 12 },
  chip: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: lib.line },
  chipOn: { backgroundColor: lib.greenDark, borderColor: lib.greenDark },
  chipText: { fontSize: 17, fontWeight: '700', color: lib.inkSoft },
  page: { paddingHorizontal: 15, paddingTop: 2, paddingBottom: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  compareBar: { position: 'absolute', left: 16, right: 16, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, paddingLeft: 18, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: lib.line, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  compareTitle: { fontSize: 17, fontWeight: '800', color: lib.ink },
  compareHint: { fontSize: 14, color: lib.muted, marginTop: 2 },
  clear: { paddingHorizontal: 12, paddingVertical: 10 },
  clearText: { fontSize: 16, fontWeight: '700', color: lib.inkSoft },
  go: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 999, backgroundColor: lib.greenDark },
  goText: { fontSize: 17, fontWeight: '800', color: '#FFFFFF' },
});
