/**
 * 產品卡：
 * - ProductFeatureCard：HyAgent 回覆下方的產品卡（名稱、展示圖、重點、查看產品），稿 02
 * - ProductGridCard：產品探索的格狀卡（大展示圖、名稱、說明、右下箭頭），可加入比較，稿 03／04
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { lib } from '@/brand/theme';
import type { Product } from './catalog';
import { ProductArt } from './ProductArt';

export function ArrowButton({ size = 36, onPress, label }: { size?: number; onPress?(): void; label?: string }) {
  const circle = <View style={[styles.arrow, { width: size, height: size, borderRadius: size / 2 }]}><Ionicons name="arrow-forward" size={size * 0.5} color="#FFFFFF" /></View>;
  if (!onPress) return circle;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>{circle}</Pressable>;
}

export function ProductFeatureCard({ product, onOpen, width }: { product: Product; onOpen(): void; width?: number }) {
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.feature, width ? { width } : { flex: 1 }, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`查看產品 ${product.name}`}>
      <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>
        <Text style={styles.featureName} numberOfLines={1}>{product.name}</Text>
        <Text style={styles.featureEn} numberOfLines={1}>{product.nameEn}</Text>
      </View>
      <ProductArt icon={product.icon} image={product.image} size={170} label={product.name} fill={0.86} style={styles.featureArt} />
      <View style={{ gap: 4, flex: 1, paddingHorizontal: 20, paddingTop: 12 }}>
        {product.features.slice(0, 4).map((f) => (
          <View key={f} style={styles.bulletRow}>
            <View style={styles.dot} />
            <Text style={styles.bullet}>{f}</Text>
          </View>
        ))}
      </View>
      <View style={styles.openRow}>
        <ArrowButton size={40} />
        <Text style={styles.openText}>查看產品</Text>
      </View>
    </Pressable>
  );
}

export function ProductGridCard({ product, selected, onOpen, onToggleCompare, artSize = 210, compact = false }: { product: Product; selected: boolean; onOpen(): void; onToggleCompare(): void; artSize?: number; compact?: boolean }) {
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.grid, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={product.name}>
      <ProductArt icon={product.icon} image={product.image} size={artSize} label={product.name} fill={0.84} style={{ borderRadius: 0 }} />
      <Pressable
        onPress={onToggleCompare}
        hitSlop={6}
        style={[styles.compare, selected && styles.compareOn]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={`${selected ? '取消比較' : '加入比較'} ${product.name}`}
      >
        <Ionicons name={selected ? 'checkmark' : 'add'} size={14} color={selected ? '#FFFFFF' : lib.greenDark} />
        <Text style={[styles.compareText, selected && { color: '#FFFFFF' }]}>比較</Text>
      </Pressable>
      <View style={[styles.gridBody, compact && styles.gridBodyCompact]}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[styles.gridName, compact && { fontSize: 17, lineHeight: 22 }]} numberOfLines={compact ? 2 : 1}>{product.name}</Text>
          <Text style={[styles.gridEn, compact && { fontSize: 14 }]} numberOfLines={1}>{product.nameEn}</Text>
          {compact ? null : <Text style={styles.summary} numberOfLines={2}>{product.summary}</Text>}
        </View>
        <View style={{ alignSelf: 'flex-end' }}><ArrowButton size={compact ? 30 : 36} /></View>
      </View>
    </Pressable>
  );
}

const card = { backgroundColor: lib.card, borderRadius: 22, overflow: 'hidden' as const, shadowColor: lib.greenDark, shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 3 };

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  arrow: { backgroundColor: lib.greenDark, alignItems: 'center', justifyContent: 'center' },
  feature: { ...card },
  featureName: { fontSize: 24, fontWeight: '900', color: lib.ink },
  featureEn: { fontSize: 17, color: lib.inkSoft, marginTop: 4 },
  featureArt: { marginTop: 12, borderRadius: 0 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: lib.inkSoft, marginTop: 9 },
  bullet: { flex: 1, fontSize: 17, lineHeight: 25, color: lib.inkSoft },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  openText: { fontSize: 20, fontWeight: '800', color: lib.greenDark },
  grid: { ...card, flex: 1 },
  gridBody: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16 },
  gridBodyCompact: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 },
  gridName: { fontSize: 20, fontWeight: '900', color: lib.ink },
  gridEn: { fontSize: 16, color: lib.inkSoft },
  summary: { fontSize: 15, lineHeight: 21, color: lib.muted, marginTop: 4 },
  compare: { position: 'absolute', top: 14, right: 14, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 1, borderColor: '#CFE8D6' },
  compareOn: { backgroundColor: lib.greenDark, borderColor: lib.greenDark },
  compareText: { fontSize: 14, fontWeight: '700', color: lib.greenDark },
});
