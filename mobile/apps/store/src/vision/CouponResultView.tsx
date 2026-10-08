/** 優惠券結果（版型同稿 2）：左券照片（掃條碼時顯示條碼圖示），右狀態與細節。 */
import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';
import { colors, font, radius, space } from '@hyagent/app-core/theme/tokens';
import { headline, type CouponView } from './coupon';
import type { Photo } from './types';

const STATUS = {
  valid: { label: '可使用', fg: '#fff', bg: colors.primary, soft: colors.primarySoft },
  invalid: { label: '', fg: '#fff', bg: colors.danger, soft: colors.dangerSoft },
  unknown: { label: '無法辨識', fg: colors.text, bg: '#E3E6E4', soft: colors.bg },
} as const;

export function CouponResultView({
  photo, view, wide, onRetake, onBarcode, onAskAi,
}: {
  photo?: Photo;
  view: CouponView;
  wide: boolean;
  onRetake(): void;
  onBarcode(): void;
  onAskAi(): void;
}) {
  const s = STATUS[view.status];
  const pill = view.status === 'invalid' ? view.reason : s.label;
  const canAsk = Boolean(view.code);
  const rows: [string, string | undefined][] = [
    ['券號', view.code],
    ['適用', view.applicableTo],
    ['條件', view.conditions],
    ['期限', view.validPeriod],
  ];

  return (
    <View style={[styles.page, { flexDirection: wide ? 'row' : 'column' }]}>
      <View style={[styles.left, wide ? { flex: 1.4 } : { height: 260 }]}>
        {photo ? (
          <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
        ) : (
          <Ionicons name="barcode-outline" size={160} color="#fff" />
        )}
        <Pressable style={styles.retake} onPress={onRetake} accessibilityRole="button" accessibilityLabel="再拍一張">
          <Ionicons name="refresh" size={20} color={colors.primaryDark} />
          <Text style={styles.retakeText}>再拍一張</Text>
        </Pressable>
      </View>
      <ScrollView style={[styles.right, wide ? { width: '42%', flexGrow: 0 } : { flex: 1 }]} contentContainerStyle={{ gap: space.md, padding: space.lg }}>
        <View style={styles.head}>
          <Mascot pose="wave" size={48} />
          <Text style={styles.headline}>{headline(view)}</Text>
        </View>
        <View style={[styles.info, { backgroundColor: s.soft }]}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{view.title ?? '優惠券'}</Text>
            <Text style={[styles.pill, { color: s.fg, backgroundColor: s.bg }]}>{pill}</Text>
          </View>
          {rows.map(([k, v]) =>
            v ? (
              <View key={k} style={styles.row}>
                <Text style={styles.key}>{k}</Text>
                <Text style={styles.value}>{v}</Text>
              </View>
            ) : null,
          )}
          {view.status === 'unknown' ? <Text style={styles.value}>{view.reason}</Text> : null}
        </View>
        {view.status === 'unknown' || !view.code ? (
          <Pressable style={styles.secondary} onPress={onBarcode} accessibilityRole="button" accessibilityLabel="改用掃條碼">
            <Ionicons name="barcode-outline" size={20} color={colors.primaryDark} />
            <Text style={styles.secondaryText}>改用掃條碼</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.primary, !canAsk && { opacity: 0.5 }]}
          onPress={() => { if (canAsk) onAskAi(); }}
          accessibilityRole="button"
          accessibilityLabel="問 AI 這張券的細節"
          accessibilityState={{ disabled: !canAsk }}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={20} color="#fff" />
          <Text style={styles.primaryText}>問 AI 這張券的細節</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  left: { backgroundColor: '#3a3430', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  retake: { position: 'absolute', right: space.lg, bottom: space.lg, flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.md },
  retakeText: { fontSize: font.md, fontWeight: '700', color: colors.primaryDark },
  right: { backgroundColor: colors.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headline: { flex: 1, fontSize: font.lg, fontWeight: '800', color: colors.text },
  info: { borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  title: { fontSize: font.xl, fontWeight: '800', color: colors.text },
  pill: { fontSize: font.sm, fontWeight: '800', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: space.md },
  key: { width: 40, fontSize: font.md, color: colors.textMuted },
  value: { flex: 1, fontSize: font.md, color: colors.text },
  secondary: { flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary, borderRadius: radius.lg, paddingVertical: 14 },
  secondaryText: { color: colors.primaryDark, fontSize: font.md, fontWeight: '700' },
  primary: { flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderRadius: radius.lg, paddingVertical: 16 },
  primaryText: { color: '#fff', fontSize: font.lg, fontWeight: '800' },
});
