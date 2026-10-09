/**
 * 產品比較分頁（稿 05）：產品並排成欄、規格成列，值不同的列標示「不同」；可請 HyAgent 解讀差異。
 * 比較的是產品探索、詳細頁勾選的清單，每欄可移除。表格撐滿整頁：列高平均分配、平板不足三項時補「加入產品」欄。
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { lib } from '@/brand/theme';
import { MAX_COMPARE, askToCompare, compareCell, compareRows, parseCompareIds } from '@/catalog/agentBridge';
import { CompareEmptyView } from '@/catalog/CompareEmptyView';
import { useCompare } from '@/catalog/CompareStore';
import { ProductArt } from '@/catalog/ProductArt';
import { chatRoute } from '@/navigation/chatRoute';

export default function Compare() {
  const selected = useCompare();
  const products = parseCompareIds(selected.ids);
  const { width, height: windowH } = useWindowDimensions();
  const [areaH, setAreaH] = useState(0);
  if (products.length < 2) {
    return (
      <CompareEmptyView
        selected={products.length ? products : parseCompareIds(selected.ids)}
        wide={width >= 700}
        onBrowse={() => router.navigate('/products')}
        onPreset={(ids) => selected.replace(ids)}
        onRemove={(id) => selected.toggle(id)}
        onAsk={() => router.navigate(chatRoute({ q: '我想比較 LIB ONE 的產品，請依圖書館規模幫我挑出值得比較的設備' }))}
      />
    );
  }
  const rows = compareRows(products);
  // 平板（寬 700 以上）不足三項時，多一欄「加入產品」把寬度用滿
  const showSlot = width >= 700 && products.length < MAX_COMPARE;
  const labelW = { width: width >= 700 ? 150 : 92, paddingHorizontal: width >= 700 ? 14 : 10 };
  // 版面撐滿整頁：列高平均分配剩下的高度（至少 MIN_ROW），表頭產品圖取剩餘空間
  const MIN_ROW = 50;
  const area = areaH || windowH - 150;
  const fixedH = 24 + 12 * 2 + 58 + 22 + 104; // 上下內距、間距、按鈕、附註、表頭（名稱、英文名、內距）
  const artSize = Math.min(Math.max(area - fixedH - rows.length * MIN_ROW, 90), width >= 700 ? 260 : 150);
  const differs = (key: (typeof rows)[number]['key']) => new Set(products.map((p) => JSON.stringify(compareCell(p.specs[key])))).size > 1;
  return (
    <ScrollView onLayout={(e) => setAreaH(e.nativeEvent.layout.height)} alwaysBounceVertical={false} contentContainerStyle={[styles.page, { minHeight: area }]}>
      <View style={styles.table}>
        <View style={[styles.row, styles.headRow]}>
          <View style={[styles.labelCell, labelW, styles.headLabelCell]}>
            <Text style={[styles.headCount, width < 700 && { fontSize: 18 }]}>比較 {products.length} 項</Text>
            {width >= 700 ? <Text style={styles.headHint}>差異處以綠色標示</Text> : null}
            {products.length < MAX_COMPARE ? (
              <Pressable onPress={() => router.navigate('/products')} style={[styles.addBtn, width < 700 && styles.addBtnIcon]} accessibilityRole="button" accessibilityLabel="加入產品">
                <Ionicons name="add" size={width < 700 ? 22 : 16} color={lib.greenDark} />
                {width >= 700 ? <Text style={styles.addText}>加入產品</Text> : null}
              </Pressable>
            ) : null}
          </View>
          {products.map((p) => (
            <Pressable key={p.id} style={styles.cell} onPress={() => router.push({ pathname: '/products/[id]', params: { id: p.id } })} accessibilityRole="button" accessibilityLabel={`查看 ${p.name}`}>
              <ProductArt icon={p.icon} image={p.image} size={artSize} label={p.name} fill={0.86} style={{ alignSelf: 'stretch' }} />
              <Text style={styles.productName} numberOfLines={2}>{p.name}</Text>
              <Text style={styles.productEn} numberOfLines={1}>{p.nameEn}</Text>
              <Pressable onPress={() => selected.toggle(p.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`移除 ${p.name}`} style={styles.remove}>
                <Ionicons name="close" size={16} color={lib.inkSoft} />
              </Pressable>
            </Pressable>
          ))}
          {showSlot ? (
            <Pressable style={styles.cell} onPress={() => router.navigate('/products')} accessibilityRole="button" accessibilityLabel="加入第三項產品">
              <View style={[styles.slot, { height: artSize }]}>
                <Ionicons name="add-circle-outline" size={40} color={lib.green} />
                <Text style={styles.slotText}>加入第三項產品</Text>
              </View>
              <Text style={[styles.productName, { color: lib.muted }]}>最多比較 {MAX_COMPARE} 項</Text>
              <Text style={styles.productEn}> </Text>
            </Pressable>
          ) : null}
        </View>
        {rows.map((row, i) => {
          const diff = differs(row.key);
          return (
            <View key={row.key} style={[styles.row, styles.bodyRow, i % 2 === 1 && { backgroundColor: lib.greenMist }]}>
              <View style={[styles.labelCell, labelW]}>
                <Text style={[styles.label, width < 700 && { fontSize: 15 }]}>{row.label}</Text>
                {diff ? <Text style={styles.diffTag}>不同</Text> : null}
              </View>
              {products.map((p) => {
                const cell = compareCell(p.specs[row.key]);
                return (
                  <View key={p.id} style={styles.cell}>
                    {cell.kind === 'yes' ? <View style={styles.dotRing} accessibilityLabel="支援"><View style={styles.dot} /></View>
                      : cell.kind === 'no' ? <Text style={styles.none} accessibilityLabel="無">—</Text>
                      : <Text style={[styles.value, diff && styles.valueDiff]}>{cell.text}</Text>}
                  </View>
                );
              })}
              {showSlot ? <View style={styles.cell} /> : null}
            </View>
          );
        })}
      </View>
      <Pressable onPress={() => router.navigate(chatRoute({ q: askToCompare(products) }))} style={styles.ask} accessibilityRole="button">
        <MaterialCommunityIcons name="star-four-points" size={22} color="#FFFFFF" />
        <Text style={styles.askText}>請 HyAgent 分析差異與建議</Text>
      </Pressable>
      <Text style={styles.note}>表格為產品概要，實際規格以業務提供的型錄為準。</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  table: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: lib.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: lib.line },
  headRow: { alignItems: 'stretch', paddingVertical: 10 },
  bodyRow: { flex: 1, minHeight: 50 },
  labelCell: { width: 136, paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
  headLabelCell: { justifyContent: 'flex-end', gap: 6 },
  headCount: { fontSize: 22, fontWeight: '900', color: lib.ink },
  headHint: { fontSize: 14, color: lib.muted },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', gap: 4, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5, borderColor: '#CFE8D6', marginTop: 4 },
  addBtnIcon: { alignSelf: 'flex-start', width: 40, height: 40, paddingVertical: 0 },
  addText: { fontSize: 15, fontWeight: '800', color: lib.greenDark },
  label: { fontSize: 17, fontWeight: '800', color: lib.ink },
  diffTag: { alignSelf: 'flex-start', fontSize: 12, fontWeight: '800', color: '#FFFFFF', backgroundColor: lib.green, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 6, overflow: 'hidden' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 6, gap: 4 },
  remove: { position: 'absolute', top: 4, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: lib.line },
  productName: { fontSize: 18, fontWeight: '900', color: lib.ink, textAlign: 'center', marginTop: 4 },
  productEn: { fontSize: 14, color: lib.muted, textAlign: 'center' },
  slot: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: '#CFE8D6', backgroundColor: lib.greenMist },
  slotText: { fontSize: 16, fontWeight: '800', color: lib.greenDark },
  value: { fontSize: 17, color: lib.inkSoft, textAlign: 'center' },
  valueDiff: { color: lib.greenDark, fontWeight: '800' },
  dotRing: { width: 24, height: 24, borderRadius: 12, backgroundColor: lib.greenSoft, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: lib.green },
  none: { fontSize: 20, color: lib.muted },
  ask: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: 999, backgroundColor: lib.greenDark },
  askText: { fontSize: 19, fontWeight: '800', color: '#FFFFFF' },
  note: { fontSize: 14, color: lib.muted, textAlign: 'center' },
});
