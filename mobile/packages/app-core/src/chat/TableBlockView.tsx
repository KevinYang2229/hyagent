import { useMemo } from 'react';
import { useChatTypography } from './ChatTypography';
/** 回覆中的表格（資料來自工具，不經 AI 轉述）；欄位多時可左右滑。 */
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DisplayBlock } from '@hyagent/shared';
import { colors, radius, space, toneColors } from '@hyagent/app-core/theme/tokens';
import { useAppBranding } from '@hyagent/app-core/branding/AppBranding';
import { cellTone, formatCell, imageUri } from './tableFormat';

const MIN_COL = 96;

export function TableBlockView({ block }: { block: DisplayBlock }) {
  const styles = useStyles();
  const { resolveImage } = useAppBranding();
  return (
    <View style={styles.card}>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.row, styles.head]}>
            {block.columns.map((c, i) => (
              <Text key={c.key} style={[styles.cell, styles.headText, i === 0 && styles.first]}>{c.label}</Text>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={[styles.row, r > 0 && styles.divider]}>
              {block.columns.map((c, i) => {
                const v = row[c.key];
                const tone = cellTone(c, v);
                const image = c.image ? resolveImage({ productId: row.productId, name: row[c.key], image: imageUri(row, c) }) : undefined;
                const text = c.badge && v !== null && v !== undefined ? String(v) : formatCell(c, v);
                return (
                  <View key={c.key} style={[styles.cell, styles.cellRow, i === 0 && styles.first]}>
                    {image ? <Image source={image} style={styles.thumb} resizeMode="contain" /> : null}
                    {tone ? (
                      <Text style={[styles.pill, { color: toneColors[tone].fg, backgroundColor: toneColors[tone].bg }]}>{text}</Text>
                    ) : (
                      <Text style={styles.value}>{text}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function useStyles() {
  const chatFont = useChatTypography();
  return useMemo(() => StyleSheet.create({
  card: { marginTop: space.sm, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingVertical: space.sm },
  title: { fontSize: chatFont.body, fontWeight: '700', color: colors.text, paddingHorizontal: space.md, paddingBottom: space.sm },
  row: { flexDirection: 'row', alignItems: 'center' },
  head: { backgroundColor: colors.bg },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  cell: { minWidth: MIN_COL, paddingHorizontal: space.md, paddingVertical: 10 },
  first: { minWidth: 168 },
  cellRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headText: { fontSize: chatFont.label, fontWeight: '600', color: colors.textMuted },
  value: { fontSize: chatFont.body, fontWeight: '500', color: colors.text },
  pill: { fontSize: chatFont.label, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.sm, overflow: 'hidden' },
  thumb: { width: 36, height: 36, borderRadius: 8, backgroundColor: colors.bg },
}), [chatFont]);
}
