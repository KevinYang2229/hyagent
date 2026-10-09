/**
 * 產品比較的起始畫面（還沒選滿 2 項時）：
 * - 上方三個比較格位：已選的產品照、還沒選的虛線格，一眼看出「還差幾項」
 * - 三步驟說明：到產品探索 → 按「比較」勾選 → 回來並排比較、請 HyAgent 分析
 * - 推薦比較組合：點一下直接帶入兩項產品開始比較
 * - 或直接問 HyAgent
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { lib } from '@/brand/theme';
import { COMPARE_PRESETS, MAX_COMPARE } from './agentBridge';
import { getProduct, type Product } from './catalog';
import { ProductArt } from './ProductArt';

export interface CompareEmptyViewProps {
  /** 目前已選的產品（0～1 項） */
  selected: Product[];
  wide: boolean;
  onBrowse(): void;
  onPreset(ids: string[]): void;
  onRemove(id: string): void;
  onAsk(): void;
}

const STEPS = [
  { icon: 'grid-outline', title: '到產品探索', short: '探索', text: '瀏覽 LIB ONE 各類設備' },
  { icon: 'add-circle-outline', title: '按「比較」勾選', short: '勾選', text: '同時選 2～3 項產品' },
  { icon: 'git-compare-outline', title: '並排比較', short: '比較', text: '差異自動標示，可請 HyAgent 分析' },
] as const;

export function CompareEmptyView({ selected, wide, onBrowse, onPreset, onRemove, onAsk }: CompareEmptyViewProps) {
  const remaining = 2 - selected.length;
  const slots = Array.from({ length: MAX_COMPARE }, (_, i) => selected[i]);
  // 比較格位撐滿其餘區塊以外的高度：量到格位實際高度後，產品照依它縮放
  const [slotH, setSlotH] = useState(0);
  const artSize = Math.max(slotH, 60);

  return (
    <View style={[styles.page, wide && styles.pageWide]}>
      {/* 比較格位 */}
      <View style={[styles.hero, { flex: 1 }]}>
        <View style={{ gap: 4 }}>
          <Text style={[styles.title, !wide && { fontSize: 22 }]}>{selected.length === 0 ? '選 2～3 項產品來比較' : `再選 ${remaining} 項就能開始比較`}</Text>
          <Text style={[styles.subtitle, !wide && { fontSize: 15 }]}>並排看規格差異，還能請 HyAgent 依館舍需求給建議</Text>
        </View>
        <View style={[styles.slots, { gap: wide ? 16 : 10, flex: 1 }]}>
          {slots.map((p, i) => p ? (
            <View key={p.id} style={styles.slot}>
              <View style={{ flex: 1 }} onLayout={i === 0 ? (e) => setSlotH(Math.round(e.nativeEvent.layout.height)) : undefined}>
                <ProductArt icon={p.icon} image={p.image} size={artSize} label={p.name} fill={0.84} style={{ alignSelf: 'stretch', flex: 1, height: '100%', borderRadius: 14 }} />
              </View>
              <Text style={[styles.slotName, !wide && { fontSize: 13 }]} numberOfLines={1}>{p.name}</Text>
              <Pressable onPress={() => onRemove(p.id)} hitSlop={8} style={styles.remove} accessibilityRole="button" accessibilityLabel={`移除 ${p.name}`}>
                <Ionicons name="close" size={14} color={lib.inkSoft} />
              </Pressable>
            </View>
          ) : (
            <Pressable key={i} onPress={onBrowse} style={({ pressed }) => [styles.slot, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={`選擇第 ${i + 1} 項產品`}>
              <View style={[styles.emptySlot, { flex: 1 }]} onLayout={i === 0 ? (e) => setSlotH(Math.round(e.nativeEvent.layout.height)) : undefined}>
                <Ionicons name="add" size={wide ? 34 : 26} color={lib.green} />
                {wide ? <Text style={styles.emptySlotText}>{i < 2 ? '選擇產品' : '可再加一項'}</Text> : null}
              </View>
              <Text style={[styles.slotName, styles.slotPlaceholder, !wide && { fontSize: 13 }]} numberOfLines={1}>第 {i + 1} 項{i === 2 ? '（選填）' : ''}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* 三步驟 */}
      <View style={[styles.steps, !wide && { gap: 8 }]}>
        {STEPS.map((s, i) => (
          <View key={s.title} style={[styles.step, !wide && styles.stepNarrow]}>
            <View style={styles.stepNo}><Text style={styles.stepNoText}>{i + 1}</Text></View>
            {wide ? <Ionicons name={s.icon} size={26} color={lib.greenDark} /> : null}
            <View style={{ flex: 1 }}>
              <Text style={[styles.stepTitle, !wide && { fontSize: 14 }]} numberOfLines={1}>{wide ? s.title : s.short}</Text>
              {wide ? <Text style={styles.stepText} numberOfLines={1}>{s.text}</Text> : null}
            </View>
          </View>
        ))}
      </View>

      {/* 推薦組合 */}
      <View style={{ gap: 10 }}>
        <Text style={[styles.section, !wide && { fontSize: 17 }]}>熱門比較組合</Text>
        <View style={styles.presets}>
          {COMPARE_PRESETS.map((preset) => {
            const [a, b] = preset.ids.map((id) => getProduct(id)).filter((p): p is Product => !!p);
            return (
              <Pressable key={preset.title} onPress={() => onPreset(preset.ids)} style={({ pressed }) => [styles.preset, { width: wide ? '48.8%' : '48.5%' }, !wide && styles.presetNarrow, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={`比較 ${preset.title}`}>
                <View style={styles.pair}>
                  {[a, b].map((p) => p ? <ProductArt key={p.id} icon={p.icon} image={p.image} size={wide ? 60 : 44} label={p.name} fill={0.86} style={{ width: wide ? 60 : 44, borderRadius: 10 }} /> : null)}
                </View>
                <View style={{ flex: wide ? 1 : 0, gap: 2 }}>
                  <Text style={[styles.presetTitle, !wide && { fontSize: 14, lineHeight: 19 }]} numberOfLines={wide ? 1 : 2}>{preset.title}</Text>
                  {wide ? <Text style={styles.presetHint} numberOfLines={1}>{preset.hint}</Text> : null}
                </View>
                {wide ? <Ionicons name="chevron-forward" size={20} color={lib.greenDark} /> : null}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 行動按鈕 */}
      <View style={[styles.actions, !wide && { gap: 8 }]}>
        <Pressable onPress={onBrowse} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Ionicons name="grid-outline" size={20} color="#FFFFFF" />
          <Text style={[styles.primaryText, !wide && { fontSize: 16 }]}>{wide ? '前往產品探索選擇' : '去產品探索'}</Text>
        </Pressable>
        <Pressable onPress={onAsk} style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <MaterialCommunityIcons name="star-four-points" size={18} color={lib.greenDark} />
          <Text style={[styles.secondaryText, !wide && { fontSize: 15 }]}>{wide ? '不確定選哪些？問 HyAgent' : '問 HyAgent'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const card = { backgroundColor: '#FFFFFF', borderRadius: 18, shadowColor: lib.greenDark, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 };

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  pageWide: { paddingHorizontal: 24, paddingVertical: 16, gap: 18 },
  hero: { ...card, padding: 18, gap: 14, minHeight: 180 },
  title: { fontSize: 26, fontWeight: '900', color: lib.ink },
  subtitle: { fontSize: 17, color: lib.inkSoft },
  slots: { flexDirection: 'row' },
  slot: { flex: 1, gap: 6 },
  emptySlot: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 14, borderWidth: 2, borderStyle: 'dashed', borderColor: '#BFE0C8', backgroundColor: lib.greenMist },
  emptySlotText: { fontSize: 15, fontWeight: '800', color: lib.greenDark },
  slotName: { fontSize: 16, fontWeight: '800', color: lib.ink, textAlign: 'center' },
  slotPlaceholder: { color: lib.muted, fontWeight: '600' },
  remove: { position: 'absolute', top: 6, right: 6, width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: lib.line },
  steps: { flexDirection: 'row', gap: 12 },
  step: { ...card, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  stepNarrow: { paddingHorizontal: 8, paddingVertical: 10, gap: 6 },
  stepNo: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenDark },
  stepNoText: { fontSize: 14, fontWeight: '900', color: '#FFFFFF' },
  stepTitle: { fontSize: 17, fontWeight: '900', color: lib.ink },
  stepText: { fontSize: 15, color: lib.inkSoft },
  section: { fontSize: 20, fontWeight: '900', color: lib.ink },
  presets: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  preset: { ...card, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  presetNarrow: { flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: 10 },
  pair: { flexDirection: 'row', gap: 4 },
  presetTitle: { fontSize: 17, fontWeight: '800', color: lib.ink },
  presetHint: { fontSize: 14, color: lib.muted },
  actions: { flexDirection: 'row', gap: 12 },
  primary: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15, borderRadius: 999, backgroundColor: lib.greenDark },
  primaryText: { fontSize: 19, fontWeight: '800', color: '#FFFFFF' },
  secondary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 999, borderWidth: 1.5, borderColor: '#CFE8D6', backgroundColor: '#FFFFFF' },
  secondaryText: { fontSize: 17, fontWeight: '800', color: lib.greenDark },
});
