import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { pageTypography } from '@/brand/typography';
/**
 * 聯絡我們畫面：上方標題與服務摘要，下方依序呈現 AI 輔助、聯絡窗口、常見問題與諮詢流程。
 * 平板橫向使用固定雙欄、整頁不捲動；其他尺寸使用直向可捲動版面。路由在 app/(tabs)/contact.tsx。
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { sm } from '@/brand/theme';
import { PHOTOS } from '@/brand/assets';
import { RobotAvatar } from '@/brand/Brand';
import { FrostedBackground, PAGE_TOP_SPACE } from '@/chrome/Page';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ContactChannel } from './contact';

const ICON: Record<ContactChannel['kind'], keyof typeof Ionicons.glyphMap> = { phone: 'call-outline', email: 'mail-outline', website: 'globe-outline' };

export const SERVICES = [
  { icon: 'clipboard-text-outline', title: '導入規劃', text: '依場域規模建議空間與流程' },
  { icon: 'cash-multiple', title: '報價諮詢', text: '系統、設備與維運費用' },
  { icon: 'presentation', title: '產品展示', text: '安排實機展示或線上說明' },
  { icon: 'tools', title: '維運支援', text: '教育訓練與後續維護' },
] as const;

const FLOW = [
  { title: '讓 HyAgent 整理需求', short: '整理需求', text: '場域類型、空間數量、想解決的問題' },
  { title: '聯絡業務窗口', short: '聯絡業務', text: '帶著整理好的需求與我們聯繫' },
  { title: '安排展示或場勘', short: '展示場勘', text: '實機展示、評估現場配置' },
];

/** 聯絡前常見的問題：點了直接問 HyAgent */
export const CONTACT_FAQ = [
  '如何評估適合的方案與費用？',
  '導入 SpaceMe 大概需要多久？',
  '可以和現有的系統整合嗎？',
  'SpaceMe 有哪些維運與支援服務？',
  '可以安排產品展示或現場勘查嗎？',
  '可以依場域調整預約規則嗎？',
  '上線後有提供人員教育訓練嗎？',
];

export interface ContactViewProps {
  wide: boolean;
  channels: ContactChannel[];
  onAsk(question: string): void;
}

export const PREPARE_QUESTION = '我想導入 SpaceMe，請幫我整理聯絡業務前需要準備的需求';

export function ContactView({ wide, channels, onAsk }: ContactViewProps) {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [failedChannel, setFailedChannel] = useState<ContactChannel | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  async function openChannel(channel: ContactChannel) {
    setFailedChannel(null);
    setCopyStatus('');
    try {
      await Linking.openURL(channel.url);
    } catch {
      setFailedChannel(channel);
    }
  }
  async function copyChannel(channel: ContactChannel) {
    try {
      await Clipboard.setStringAsync(channel.value);
      setCopyStatus('已複製聯絡資訊');
    } catch {
      setCopyStatus('複製失敗，請稍後再試，或手動選取下方聯絡資訊。');
    }
  }
  // 小螢幕依聯絡優先順序排列，常見問題維持每題一列。
  const landscape = wide && width > height;
  // 大字模式與較矮的橫向畫面減少題數，避免拉高或壓縮問題列。
  const effectiveHeight = (height - insets.top - insets.bottom) / Math.max(1, fontScale);
  const faqCount = !landscape ? CONTACT_FAQ.length : effectiveHeight < 720 ? 3 : effectiveHeight < 800 ? 4 : effectiveHeight < 950 ? 5 : 6;
  const visibleFaq = CONTACT_FAQ.slice(0, faqCount);
  const robotSize = landscape ? 64 : wide ? 96 : 56;
  const services = (
    <View style={styles.services}>
      {SERVICES.map((s) => (
        <View key={s.title} style={styles.service}>
          <MaterialCommunityIcons name={s.icon} size={20} color={sm.blueDark} />
          <Text style={styles.serviceTitle}>{s.title}</Text>
        </View>
      ))}
    </View>
  );

  const banner = (
    <View style={[styles.banner, !wide && { padding: 14, paddingBottom: 12 }, landscape && { padding: 12 }]}>
      <View style={styles.bannerHeading}>
      <View style={{ flex: 1, gap: 6, zIndex: 1 }}>
        <Text accessibilityRole="header" style={pageTypography(wide).title}>聯絡我們</Text>
        <Text style={pageTypography(wide).description}>想了解導入方案、報價或安排展示，我們很樂意協助。</Text>

      </View>
      <View style={styles.contactRobot}><RobotAvatar size={robotSize} /></View>
      </View>
      {services}
    </View>
  );

  const agent = (
      <Pressable onPress={() => onAsk(PREPARE_QUESTION)} style={({ pressed }) => [styles.agent, landscape && { padding: 12 }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
        <MaterialCommunityIcons name="star-four-points" size={28} color={sm.blueDark} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.agentTitle, !wide && { fontSize: 19 }]}>需要協助？讓 HyAgent 整理需求</Text>
          {wide ? <Text style={styles.agentSub}>場域類型、空間數量、想解決的問題，整理好再聯絡更快</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={22} color={sm.blueDark} />
      </Pressable>
  );

  const flow = (
      <View style={[styles.card, { flexShrink: 0 }, landscape && { padding: 12 }]}>
        <Text accessibilityRole="header" style={styles.cardTitle}>諮詢流程</Text>
        <View style={[styles.flow, landscape && { gap: 10 }, wide && !landscape && styles.flowWide]}>
          {FLOW.map((f, i) => (
            <View key={f.title} style={[styles.flowRow, wide && !landscape ? styles.flowStepWide : !wide && styles.flowPill]}>
              <View style={[styles.flowNo, !wide && { width: 22, height: 22 }]}><Text style={[styles.flowNoText, !wide && { fontSize: 14 }]}>{i + 1}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.flowText, landscape && { fontSize: 18, lineHeight: 25 }]}>{f.title}</Text>
                <Text style={[styles.flowSub, landscape && { fontSize: 15, lineHeight: 22 }]}>{f.text}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>
  );

  const faq = (
    <View style={[styles.card, { flexShrink: 0 }, landscape && { padding: 14 }]}>
      <Text accessibilityRole="header" style={styles.cardTitle}>聯絡前常見問題</Text>
      <Text style={styles.channelNote}>點選問題，由 AI 顧問解答。</Text>
      <View style={{ gap: landscape ? 10 : 14 }}>
        {visibleFaq.map((q) => (
          <Pressable key={q} onPress={() => onAsk(q)} style={({ pressed }) => [styles.faq, landscape && { paddingVertical: 14 }, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityHint="開啟 AI 顧問並詢問這個問題">
            <MaterialCommunityIcons name="star-four-points" size={16} color={sm.blue} />
            <Text style={[styles.faqText, landscape && { fontSize: 22, lineHeight: 32 }, !wide && { fontSize: 20, lineHeight: 30 }]}>{q}</Text>
            <Ionicons name="chevron-forward" size={18} color={sm.blueDark} />
          </Pressable>
        ))}
      </View>
    </View>
  );

  const contacts = (
    <View style={[styles.card, styles.contactCard, landscape && { padding: 12 }]}>
      <Text accessibilityRole="header" style={styles.cardTitle}>聯絡窗口</Text>
      <View style={{ gap: 6 }}>
        {channels.map((c) => (
          <Pressable key={c.kind} onPress={() => void openChannel(c)} style={({ pressed }) => [styles.channel, landscape && { paddingVertical: 4 }, pressed && styles.channelPressed]} accessibilityRole="link" accessibilityLabel={`${c.label} ${c.value}`}>
            <View style={[styles.channelIcon, landscape && { width: 36, height: 36 }]}><Ionicons name={ICON[c.kind]} size={22} color={sm.blueDark} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.channelLabel}>{c.kind === 'website' ? '官方網站' : c.label}</Text>
              <Text selectable style={[styles.channelValue, !wide && { fontSize: 18 }]}>{c.value.replace(/^https?:\/\//, '')}</Text>
            </View>
            <Ionicons name="open-outline" size={20} color={sm.muted} />
          </Pressable>
        ))}
        {failedChannel ? (
          <View style={styles.channelError}>
            <Text accessibilityLiveRegion="polite" style={styles.channelNote}>無法開啟{failedChannel.label}，請複製聯絡資訊後使用其他應用程式聯絡。</Text>
            <Text selectable style={styles.channelValue}>{failedChannel.value}</Text>
            <Pressable onPress={() => void copyChannel(failedChannel)} accessibilityRole="button" style={({ pressed }) => [styles.copyButton, pressed && styles.channelPressed]}>
              <Text style={styles.copyText}>複製聯絡資訊</Text>
            </Pressable>
            {copyStatus ? <Text accessibilityLiveRegion="polite" style={styles.channelNote}>{copyStatus}</Text> : null}
          </View>
        ) : null}
        {channels.length === 0 ? <Text style={styles.channelNote}>業務窗口尚未設定，請先透過 HyAgent 整理您的需求。</Text> : null}
        {wide && channels.length > 0 && channels.every((c) => c.kind === 'website') ? (
          <Text style={styles.channelNote}>業務電話與信箱將由管理員設定；目前可先透過官網或 HyAgent 了解產品。</Text>
        ) : null}
      </View>
    </View>
  );

  const pageStyle = [styles.page, wide && styles.pageWide, {
    paddingTop: insets.top + (landscape ? PAGE_TOP_SPACE.landscape : wide ? PAGE_TOP_SPACE.tablet : PAGE_TOP_SPACE.phone) + 16,
    paddingBottom: landscape ? 16 : wide ? 24 : 20,
    paddingLeft: Math.max(insets.left, wide ? 24 : 14),
    paddingRight: Math.max(insets.right, wide ? 24 : 14),
  }];

  if (landscape) {
    return (
      <View style={styles.background}>
      <FrostedBackground photo={PHOTOS.contactBackground} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backgroundShade]} />
      <View testID="contact-landscape" style={[pageStyle, { flex: 1, gap: 12 }]}>
        {banner}
        <View style={styles.columns}>
          <View style={styles.column}>
            {agent}
            {contacts}
            {flow}
          </View>
          <View style={styles.column}>{faq}</View>
        </View>
      </View>
      </View>
    );
  }

  return (
    <View style={styles.background}>
    <FrostedBackground photo={PHOTOS.contactBackground} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backgroundShade]} />
    <ScrollView testID="contact-scroll" style={styles.scroll} contentContainerStyle={pageStyle}>
      {banner}
      {agent}
      {contacts}
      {faq}
      {flow}
    </ScrollView>
    </View>
  );
}

const card = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C4D2EA', borderRadius: 18, shadowColor: sm.blueDark, shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 5 };

const styles = StyleSheet.create({
  contactRobot: { marginLeft: 16 },
  background: { flex: 1, backgroundColor: sm.blueMist },
  backgroundShade: { backgroundColor: 'rgba(14,27,69,0.14)' },
  scroll: { flex: 1 },
  page: { flexGrow: 1, padding: 14, gap: 12 },
  pageWide: { padding: 24, gap: 16 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  column: { flex: 1, gap: 12 },
  banner: { ...card, padding: 22, gap: 16, borderRadius: 20 },
  bannerHeading: { flexDirection: 'row', alignItems: 'center' },
  services: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  service: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: sm.blueSoft },
  serviceTitle: { fontSize: 19, lineHeight: 27, fontWeight: '900', color: sm.ink },
  agent: { ...card, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 20, backgroundColor: sm.blueSoft, borderColor: '#AFC5F5' },
  agentTitle: { fontSize: 21, lineHeight: 29, fontWeight: '800', color: sm.ink },
  agentSub: { fontSize: 17, lineHeight: 25, color: sm.inkSoft },
  card: { ...card, gap: 10, padding: 18 },
  contactCard: { flexShrink: 0, padding: 14, gap: 8 },
  cardTitle: { fontSize: 21, lineHeight: 29, fontWeight: '900', color: sm.ink },
  flow: { gap: 18 },
  flowWide: { flexDirection: 'row', gap: 20 },
  flowStepWide: { flex: 1, alignItems: 'flex-start', paddingVertical: 8 },
  flowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flowNo: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: sm.blueDark },
  flowNoText: { fontSize: 17, fontWeight: '900', color: '#FFFFFF' },
  flowText: { fontSize: 19, lineHeight: 27, fontWeight: '800', color: sm.ink },
  flowPill: { gap: 6, paddingHorizontal: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: sm.blueMist },
  flowSub: { fontSize: 17, lineHeight: 25, color: sm.inkSoft, marginTop: 2 },
  faq: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 20, borderRadius: 14, backgroundColor: sm.blueMist },
  faqText: { flex: 1, fontSize: 22, lineHeight: 32, fontWeight: '700', color: sm.ink },
  channel: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  channelIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: sm.blueSoft },
  channelPressed: { backgroundColor: sm.blueSoft, opacity: 0.8 },
  channelError: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: sm.blueMist },
  copyButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: sm.blueDark },
  copyText: { fontSize: 17, fontWeight: '700', color: sm.blueDark },
  channelLabel: { fontSize: 16, lineHeight: 24, color: sm.inkSoft },
  channelValue: { fontSize: 20, lineHeight: 28, fontWeight: '800', color: sm.ink },
  channelNote: { fontSize: 16, lineHeight: 24, color: sm.muted, marginTop: 4 },
});
