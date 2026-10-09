/**
 * 聯絡我們畫面：上方插畫橫幅與諮詢服務，下方分成「HyAgent 幫你整理需求＋諮詢流程」與「聯絡窗口」兩塊，
 * 平板左右並排、手機上下排，區塊撐滿畫面不留空。路由在 app/(tabs)/contact.tsx。
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { lib } from '@/brand/theme';
import type { Product } from '@/catalog/catalog';
import type { ContactChannel } from './contact';

const ICON: Record<ContactChannel['kind'], keyof typeof Ionicons.glyphMap> = { phone: 'call-outline', email: 'mail-outline', website: 'globe-outline' };
const STAFF = require('../../assets/scene/staff.png');

const SERVICES = [
  { icon: 'clipboard-text-outline', title: '導入規劃', text: '依館舍規模建議設備組合' },
  { icon: 'cash-multiple', title: '報價諮詢', text: '設備、安裝與維運費用' },
  { icon: 'presentation', title: '產品展示', text: '安排實機展示或線上說明' },
  { icon: 'tools', title: '維運支援', text: '教育訓練與後續維護' },
] as const;

const FLOW = [
  { title: '讓 HyAgent 整理需求', short: '整理需求', text: '館舍規模、借還量、想解決的問題' },
  { title: '聯絡業務窗口', short: '聯絡業務', text: '帶著整理好的需求與我們聯繫' },
  { title: '安排展示或場勘', short: '展示場勘', text: '實機展示、評估現場配置' },
];

/** 聯絡前常見的問題：點了直接問 HyAgent */
export const CONTACT_FAQ = ['導入 LIB ONE 大概需要多久？', '可以和現有的圖書館系統整合嗎？', '設備有哪些維運與保固服務？', '可以先安排實機展示嗎？'];

export interface ContactViewProps {
  wide: boolean;
  product?: Product;
  channels: ContactChannel[];
  onPrepare(): void;
  onClearProduct(): void;
  onAsk(question: string): void;
}

export function ContactView({ wide, product, channels, onPrepare, onClearProduct, onAsk }: ContactViewProps) {
  const { width, height } = useWindowDimensions();
  // 平板橫放高度最緊：橫幅縮小、常見問題只放三題
  const landscape = wide && width > height;
  const banner = (
    <View style={[styles.banner, !wide && { padding: 14, paddingBottom: 12 }, landscape && { paddingVertical: 14 }]}>
      <View style={{ flex: 1, gap: 6, zIndex: 1 }}>
        <Text style={[styles.title, !wide && { fontSize: 24 }]}>聯絡我們</Text>
        <Text style={[styles.sub, !wide && { fontSize: 15, lineHeight: 22 }]}>想了解導入方案、報價或安排展示，我們很樂意協助。</Text>
        {product ? (
          <View style={styles.product}>
            <Text style={styles.productLabel} numberOfLines={1}>{wide ? '諮詢產品' : '諮詢'}</Text>
            <Text style={[styles.productName, !wide && { maxWidth: 130, fontSize: 15 }]} numberOfLines={1}>{product.name}</Text>
            <Pressable onPress={onClearProduct} hitSlop={8} accessibilityRole="button" accessibilityLabel="取消指定產品">
              <Ionicons name="close" size={18} color={lib.inkSoft} />
            </Pressable>
          </View>
        ) : null}
      </View>
      <Image source={STAFF} style={{ width: landscape ? 190 : wide ? 260 : 110, height: landscape ? 128 : wide ? 190 : 80, marginRight: -6, marginBottom: -16, alignSelf: 'flex-end' }} resizeMode="contain" accessibilityLabel="館員在工作站服務的插畫" />
    </View>
  );

  const services = (
    <View style={[styles.services, !wide && { flexWrap: 'wrap', gap: 0, rowGap: 8 }]}>
      {SERVICES.map((s) => (
        <View key={s.title} style={[styles.service, wide ? { flex: 1 } : { width: '48.8%', padding: 10 }]}>
          <View style={[styles.serviceIcon, !wide && { width: 34, height: 34, borderRadius: 10 }]}><MaterialCommunityIcons name={s.icon} size={wide ? 26 : 18} color={lib.greenDark} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.serviceTitle, !wide && { fontSize: 15 }]}>{s.title}</Text>
            {wide ? <Text style={styles.serviceText} numberOfLines={2}>{s.text}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );

  const prepare = (
    <View style={[styles.block, wide && { flex: 1 }]}>
      <Pressable onPress={onPrepare} style={({ pressed }) => [styles.agent, pressed && { opacity: 0.85 }]} accessibilityRole="button">
        <MaterialCommunityIcons name="star-four-points" size={28} color="#FFFFFF" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.agentTitle, !wide && { fontSize: 17 }]}>先讓 HyAgent 幫你整理需求</Text>
          {wide ? <Text style={styles.agentSub}>館舍規模、借還量、想解決的問題，整理好再聯絡更快</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={22} color="#FFFFFF" />
      </Pressable>
      <View style={[styles.card, wide && { flex: 1 }]}>
        <Text style={styles.cardTitle}>諮詢流程</Text>
        <View style={[styles.flow, wide ? { flex: 1, justifyContent: 'space-evenly' } : { flexDirection: 'row', gap: 6 }]}>
          {FLOW.map((f, i) => (
            <View key={f.title} style={[styles.flowRow, !wide && styles.flowPill]}>
              <View style={[styles.flowNo, !wide && { width: 22, height: 22 }]}><Text style={[styles.flowNoText, !wide && { fontSize: 12 }]}>{i + 1}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.flowText, !wide && { fontSize: 13 }]} numberOfLines={wide ? undefined : 2}>{wide ? f.title : f.short}</Text>
                {wide ? <Text style={styles.flowSub}>{f.text}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );

  const faq = (
    <View style={[styles.card, wide && { flex: 1 }]}>
      <Text style={styles.cardTitle}>聯絡前常見問題</Text>
      <View style={[{ gap: 8 }, wide && { flex: 1, justifyContent: 'space-evenly' }]}>
        {CONTACT_FAQ.slice(0, landscape ? 3 : CONTACT_FAQ.length).map((q) => (
          <Pressable key={q} onPress={() => onAsk(q)} style={({ pressed }) => [styles.faq, landscape && { paddingVertical: 9 }, pressed && { opacity: 0.8 }]} accessibilityRole="button">
            <MaterialCommunityIcons name="star-four-points" size={16} color={lib.green} />
            <Text style={[styles.faqText, !wide && { fontSize: 15 }]} numberOfLines={1}>{q}</Text>
            <Ionicons name="chevron-forward" size={18} color={lib.greenDark} />
          </Pressable>
        ))}
      </View>
    </View>
  );

  const contacts = (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>聯絡窗口</Text>
      <View style={{ gap: 6 }}>
        {channels.map((c) => (
          <Pressable key={c.kind} onPress={() => void Linking.openURL(c.url)} style={styles.channel} accessibilityRole="link" accessibilityLabel={`${c.label} ${c.value}`}>
            <View style={styles.channelIcon}><Ionicons name={ICON[c.kind]} size={22} color={lib.greenDark} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.channelLabel}>{c.kind === 'website' ? '官方網站' : c.label}</Text>
              <Text style={[styles.channelValue, !wide && { fontSize: 16 }]} numberOfLines={1}>{c.value.replace(/^https?:\/\//, '')}</Text>
            </View>
            <Ionicons name="open-outline" size={20} color={lib.muted} />
          </Pressable>
        ))}
        {wide && channels.every((c) => c.kind === 'website') ? (
          <Text style={styles.channelNote}>業務電話與信箱將由管理員設定；目前可先透過官網或 HyAgent 了解產品。</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <ScrollView alwaysBounceVertical={false} contentContainerStyle={[styles.page, wide && styles.pageWide]}>
      {banner}
      {services}
      {wide ? (
        <View style={styles.columns}>
          {prepare}
          <View style={{ flex: 1, gap: 12 }}>
            {contacts}
            {faq}
          </View>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {prepare}
          {contacts}
        </View>
      )}
    </ScrollView>
  );
}

const card = { backgroundColor: '#FFFFFF', borderRadius: 18, shadowColor: lib.greenDark, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 };

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 14, gap: 12 },
  pageWide: { padding: 24, gap: 16 },
  columns: { flex: 1, flexDirection: 'row', gap: 16 },
  banner: { ...card, flexDirection: 'row', alignItems: 'center', padding: 22, paddingBottom: 18, overflow: 'hidden', backgroundColor: lib.greenSoft },
  title: { fontSize: 30, fontWeight: '900', color: lib.ink },
  sub: { fontSize: 18, lineHeight: 26, color: lib.inkSoft },
  product: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 10, marginTop: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#FFFFFF' },
  productLabel: { fontSize: 14, fontWeight: '800', color: lib.green },
  productName: { fontSize: 16, fontWeight: '800', color: lib.ink, maxWidth: 260 },
  services: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  service: { ...card, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
  serviceIcon: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenSoft },
  serviceTitle: { fontSize: 17, fontWeight: '900', color: lib.ink },
  serviceText: { fontSize: 14, color: lib.inkSoft },
  block: { gap: 12 },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 20, backgroundColor: lib.greenDark },
  agentTitle: { fontSize: 19, fontWeight: '800', color: '#FFFFFF' },
  agentSub: { fontSize: 15, color: '#D7EEDD' },
  card: { ...card, gap: 10, padding: 18 },
  cardTitle: { fontSize: 19, fontWeight: '900', color: lib.ink },
  flow: { gap: 10 },
  flowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flowNo: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenDark },
  flowNoText: { fontSize: 15, fontWeight: '900', color: '#FFFFFF' },
  flowText: { fontSize: 17, fontWeight: '800', color: lib.ink },
  flowPill: { flex: 1, gap: 6, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 12, backgroundColor: lib.greenMist },
  flowSub: { fontSize: 15, color: lib.inkSoft, marginTop: 2 },
  faq: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, backgroundColor: lib.greenMist },
  faqText: { flex: 1, fontSize: 16, fontWeight: '700', color: lib.ink },
  channel: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  channelIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: lib.greenSoft },
  channelLabel: { fontSize: 14, color: lib.muted },
  channelValue: { fontSize: 18, fontWeight: '800', color: lib.ink },
  channelNote: { fontSize: 14, lineHeight: 21, color: lib.muted, marginTop: 4 },
});
