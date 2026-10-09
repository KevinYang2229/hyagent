/**
 * 首頁（稿 01）：標語與全幅長景主視覺、問 HyAgent 的輸入框、四大產品服務入口。
 * 輸入框是首頁的主角，送出就進 HyAgent 對話；長景（HeroScene）是背景裝飾，延伸到畫面兩側。
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { lib } from '@/brand/theme';
import { CATEGORIES, getProduct, type Category, type CategoryId } from '@/catalog/catalog';
import { ProductArt } from '@/catalog/ProductArt';
import { ArrowButton } from '@/catalog/ProductCards';
import { HeroScene, type SceneId } from './HeroScene';

export interface HomeViewProps {
  wide: boolean;
  onAsk(question: string): void;
  onCategory(id: CategoryId): void;
}


/**
 * 依首頁可用高度分配版面，平板與一般手機都一屏放完、不用捲動：
 * 卡片列先取固定比例，剩下的高度給標語與插畫，標語字級與插畫大小隨之縮放。
 * 空間真的不夠（例如手機橫放）時，才退回可捲動。
 */
export function homeLayout(wide: boolean, width: number, height: number) {
  const pad = wide ? 44 : 18;
  const searchH = wide ? 76 : 62;
  const sectionH = wide ? 52 : 40;
  // 卡片：平板一列四張，手機 2×2
  const cardsH = wide ? Math.min(Math.max(height * 0.38, 210), 310) : Math.min(Math.max(height * 0.42, 250), 360);
  const cardH = wide ? cardsH : (cardsH - 10) / 2;
  const cardTextH = wide ? 94 : 50;
  const artSize = Math.max(cardH - cardTextH, wide ? 110 : 70);
  const heroH = Math.max(height - searchH - sectionH - cardsH - (wide ? 44 : 66), wide ? 220 : 160);
  const fontScale = Math.min(1, Math.max(wide ? 0.68 : 0.78, heroH / (wide ? 330 : 250)));
  // 標語在左、人物在右（平板橫放）；高度夠時改成標語在上、人物沿弧線排在下方（平板直放、手機）
  const side = wide && heroH < width * 0.42;
  const big = (wide ? 58 : 32) * fontScale;
  const headlineH = big * 2.2 + (wide ? 28 : 18) * fontScale * 1.45 + (wide ? 24 : 20) + (wide ? 24 : 12) * fontScale;
  const sceneTop = side ? 6 : headlineH + 10;
  const sceneHeight = side ? heroH - 8 : Math.max(heroH - headlineH - 14, 0);
  const scenes: SceneId[] = side ? ['space', 'staff'] : wide ? ['child', 'space', 'staff'] : ['child', 'space'];
  return {
    pad, searchH, cardsH, cardH, artSize, heroH, fontScale, big, side, headlineH, scenes,
    sceneLeft: side ? width * 0.47 : pad * 0.6,
    sceneTop,
    sceneHeight,
    showScenes: sceneHeight >= 90,
    flowTop: side ? heroH * 0.3 : sceneTop + sceneHeight * 0.12,
  };
}

export function HomeView({ wide: wideProp, onAsk, onCategory }: HomeViewProps) {
  const [draft, setDraft] = useState('');
  const { width, height: windowH } = useWindowDimensions();
  // iPad 直放（寬 700 以上）也用平板版面：大標語、四張分類卡一列
  const wide = wideProp || width >= 700;
  const [areaH, setAreaH] = useState(0);
  const submit = () => {
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    onAsk(q);
  };
  // 還沒量到高度前，先用視窗高度扣掉品牌列與導覽列估計
  const L = homeLayout(wide, width, areaH || windowH - 150);
  const big = L.big;

  const headline = (
    <View style={{ gap: (wide ? 12 : 6) * L.fontScale }}>
      <View>
        <Text style={[styles.headline, { fontSize: big, lineHeight: big * 1.1 }]}>ONE LIBRARY,</Text>
        <Text style={[styles.headline, { fontSize: big, lineHeight: big * 1.1 }]}>
          ONE <Text style={{ color: lib.greenBright }}>EXPERIENCE</Text>
        </Text>
      </View>
      <Text style={[styles.tagline, { fontSize: (wide ? 30 : 20) * L.fontScale }]}>用 AI 探索 LIB ONE 產品與服務</Text>
      <View style={[styles.subRow, !wide && { gap: 14 }]}>
        <Text style={[styles.sub, { fontSize: (wide ? 18 : 15) * Math.max(L.fontScale, 0.85) }]}>設備 × 空間 × 整合服務</Text>
        <Text style={[styles.sub, { fontSize: (wide ? 18 : 15) * Math.max(L.fontScale, 0.85) }]}>串聯智慧圖書館體驗</Text>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}>
      {/* 背景：全幅長景（圖書館線稿、綠色弧線、人物），延伸到畫面兩側 */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <HeroScene
          width={width}
          height={L.heroH + L.searchH * 0.7}
          scenes={L.showScenes ? L.scenes : []}
          sceneLeft={L.sceneLeft}
          sceneTop={L.sceneTop}
          sceneHeight={L.sceneHeight}
          flowTop={L.flowTop}
          readableLeft={L.side ? width * 0.5 : 0}
        />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.page, { paddingHorizontal: L.pad, minHeight: areaH || undefined }]}
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ height: L.heroH, justifyContent: L.side ? 'center' : 'flex-start', paddingTop: L.side ? 0 : 6, paddingRight: L.side ? width * 0.5 : 0 }}>
          {headline}
        </View>

        <View style={[styles.askWrap, { marginTop: wide ? 0 : 10 }]}>
          <View pointerEvents="none" style={styles.askArc} />
          <View style={styles.askBox}>
            <MaterialCommunityIcons name="star-four-points-outline" size={wide ? 30 : 22} color={lib.green} />
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              returnKeyType="send"
              placeholder={wide ? '請輸入問題，例如：有哪些自助借還書設備？' : '問 HyAgent 產品問題'}
              placeholderTextColor={lib.muted}
              style={[styles.askInput, { fontSize: wide ? 21 : 18, minHeight: wide ? 48 : 40 }]}
              accessibilityLabel="問 HyAgent"
            />
            <Pressable onPress={submit} accessibilityRole="button" accessibilityLabel="送出問題" style={[styles.send, { width: wide ? 60 : 46, height: wide ? 60 : 46 }]}>
              <Ionicons name="arrow-forward" size={wide ? 26 : 21} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>

        <Text style={[styles.section, { fontSize: wide ? 24 : 19, marginTop: wide ? 18 : 12, marginBottom: wide ? 12 : 8 }]}>探索 LIB ONE 產品服務</Text>
        <View style={[styles.cards, !wide && styles.cardsPhone]}>
          {CATEGORIES.map((c) => <CategoryCard key={c.id} category={c} wide={wide} artSize={L.artSize} onPress={() => onCategory(c.id)} />)}
        </View>
      </ScrollView>
    </View>
  );
}

function CategoryCard({ category, wide, artSize, onPress }: { category: Category; wide: boolean; artSize: number; onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, wide ? { flex: 1 } : { width: '48.5%' }, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={`${category.no} ${category.title}`}>
      <View style={{ paddingHorizontal: wide ? 18 : 12, paddingTop: wide ? 16 : 10, gap: 4 }}>
        <Text style={[styles.cardTitle, { fontSize: wide ? 24 : 17 }]} numberOfLines={1}>
          <Text style={styles.cardNo}>{category.no}  </Text>{category.title}
        </Text>
        {/* 手機只留第一行說明，把高度讓給產品圖 */}
        {(wide ? category.lines : category.lines.slice(0, 1)).map((l) => <Text key={l} style={[styles.cardLine, { fontSize: wide ? 16 : 13 }]} numberOfLines={1}>{l}</Text>)}
      </View>
      <View>
        <ProductArt icon={category.icon} image={getProduct(category.cover)?.image} size={artSize} label={category.title} fill={0.82} style={[styles.cardArt, { marginTop: wide ? 10 : 6 }]} />
        <View style={[styles.cardArrow, !wide && { left: 10, bottom: 10 }]}><ArrowButton size={wide ? 42 : 28} /></View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 0, paddingBottom: 12 },
  headline: { fontWeight: '900', color: lib.ink, letterSpacing: -0.5 },
  tagline: { fontWeight: '800', color: lib.ink },
  subRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 36 },
  sub: { fontSize: 18, fontWeight: '600', color: lib.inkSoft },
  askWrap: { position: 'relative' },
  askArc: { position: 'absolute', left: -70, top: -60, width: 200, height: 200, borderRadius: 100, borderWidth: 3, borderColor: 'rgba(61,170,92,0.28)' },
  askBox: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 24, paddingRight: 8, paddingVertical: 8, borderRadius: 999, backgroundColor: '#FFFFFF', shadowColor: lib.greenDark, shadowOpacity: 0.14, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  askInput: { flex: 1, color: lib.ink },
  send: { borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenDark },
  section: { fontWeight: '900', color: lib.ink },
  cards: { flexDirection: 'row', gap: 14, justifyContent: 'space-between' },
  // 手機 2×2：寬度各 48.5%，不用 gap，避免第二張被擠到下一列
  cardsPhone: { flexWrap: 'wrap', gap: 0, rowGap: 10 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 22, overflow: 'hidden', shadowColor: lib.greenDark, shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  cardTitle: { fontWeight: '900', color: lib.ink },
  cardNo: { color: lib.green },
  cardLine: { color: lib.inkSoft, lineHeight: 22 },
  cardArt: { borderRadius: 0 },
  cardArrow: { position: 'absolute', left: 14, bottom: 14 },
});
