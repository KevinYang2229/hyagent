/** 貨架辨識結果（稿 2）：左照片＋框選，右分組清單；寬版左右、窄版上下。 */
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ShelfResult } from '@/api/types';
import { productImageSource } from '@/brand/productImages';
import { Mascot } from '@/brand/Mascot';
import { colors, font, radius, space } from '@/theme/tokens';
import { ISSUE_ORDER, STATUS_META, boxRect, boxTagText, findingDetail, fitContain, groupFindings, issueCount, replenishmentCount, type Frame } from './shelf';
import type { Photo } from './types';

export function ShelfResultView({
  photo, result, today, wide, creating, error, onRetake, onCreate,
}: {
  photo: Photo;
  result: ShelfResult;
  today: string;
  wide: boolean;
  creating: boolean;
  error: string | null;
  onRetake(): void;
  onCreate(): Promise<void>;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const inFlight = useRef(false);
  const frame: Frame | null = size ? fitContain(photo.width, photo.height, size.w, size.h) : null;
  const groups = groupFindings(result.findings);
  const issues = issueCount(result.findings);
  const n = replenishmentCount(result);
  const canCreate = n > 0 && !creating;

  // 同步防連點：同一個 tick 內的多次按壓只會送出一次
  async function handleCreate() {
    if (!canCreate || inFlight.current) return;
    inFlight.current = true;
    try {
      await onCreate();
    } finally {
      inFlight.current = false;
    }
  }

  const photoPane = (
    <View style={[styles.photo, wide ? { flex: 1.4 } : { height: 320 }]} onLayout={(e) => {
      const { width, height } = e.nativeEvent.layout;
      setSize((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    }}>
      <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
      {frame
        ? result.findings.map((f, i) => {
            const r = boxRect(f.box, frame);
            const meta = STATUS_META[f.status];
            return (
              <View key={i} pointerEvents="none" style={[styles.box, { left: r.left, top: r.top, width: r.width, height: r.height, borderColor: meta.color }]}>
                <Text style={[styles.tag, { backgroundColor: meta.color }]}>{boxTagText(f)}</Text>
              </View>
            );
          })
        : null}
      <Pressable style={styles.retake} onPress={onRetake} accessibilityRole="button" accessibilityLabel="再拍一張">
        <Ionicons name="refresh" size={20} color={colors.primaryDark} />
        <Text style={styles.retakeText}>再拍一張</Text>
      </Pressable>
    </View>
  );

  const listPane = (
    <View style={[styles.list, wide ? { width: '40%' } : { flex: 1 }]}>
      <View style={styles.listHead}>
        <Mascot pose="wave" size={48} />
        <Text style={styles.listTitle}>{issues > 0 ? `我看到 ${issues} 個需要處理的項目：` : '這排貨架看起來都沒問題！'}</Text>
      </View>
      <ScrollView contentContainerStyle={{ gap: space.md, paddingBottom: space.md }}>
        {ISSUE_ORDER.map((status) =>
          groups[status].length > 0 ? (
            <View key={status} style={{ gap: space.sm }}>
              <Text style={[styles.group, { color: STATUS_META[status].color, backgroundColor: STATUS_META[status].soft }]}>
                {`${STATUS_META[status].label}（${groups[status].length}）`}
              </Text>
              {groups[status].map((f, i) => {
                const image = productImageSource(f);
                return (
                  <View key={i} style={styles.item}>
                    {image ? <Image source={image} style={styles.thumb} resizeMode="contain" /> : <View style={styles.thumb} />}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{f.name}</Text>
                      <Text style={styles.itemDetail}>{findingDetail(f, today)}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null,
        )}
        {result.warnings?.map((w) => <Text key={w} style={styles.warning}>{w}</Text>)}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={[styles.create, !canCreate && { opacity: 0.5 }]}
        onPress={() => { void handleCreate(); }}
        accessibilityRole="button"
        accessibilityLabel={`建立補貨單（${n} 項）`}
        accessibilityState={{ disabled: !canCreate }}
      >
        {creating ? <ActivityIndicator color="#fff" /> : <Ionicons name="cart-outline" size={22} color="#fff" />}
        <Text style={styles.createText}>{`建立補貨單（${n} 項）`}</Text>
      </Pressable>
    </View>
  );

  return <View style={[styles.page, { flexDirection: wide ? 'row' : 'column' }]}>{photoPane}{listPane}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  photo: { backgroundColor: '#1d2420', overflow: 'hidden' },
  box: { position: 'absolute', borderWidth: 3, borderRadius: 6 },
  tag: { position: 'absolute', top: -26, left: -3, color: '#fff', fontWeight: '800', fontSize: font.sm, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
  retake: { position: 'absolute', right: space.lg, bottom: space.lg, flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.md },
  retakeText: { fontSize: font.md, fontWeight: '700', color: colors.primaryDark },
  list: { backgroundColor: colors.surface, padding: space.lg, gap: space.md },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  listTitle: { flex: 1, fontSize: font.lg, fontWeight: '700', color: colors.text },
  group: { fontSize: font.md, fontWeight: '800', paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.md, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.sm },
  thumb: { width: 48, height: 48, borderRadius: 10, backgroundColor: colors.bg },
  itemName: { fontSize: font.md, fontWeight: '600', color: colors.text },
  itemDetail: { fontSize: font.sm, color: colors.textMuted },
  warning: { fontSize: font.sm, color: colors.warning },
  error: { fontSize: font.sm, color: colors.danger },
  create: { flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderRadius: radius.lg, paddingVertical: 16 },
  createText: { color: '#fff', fontSize: font.lg, fontWeight: '800' },
});
