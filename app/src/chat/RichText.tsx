/** AI 回覆的簡易排版：只處理條列（- 、* 、1. ）與 **粗體**，其餘 markdown 符號照原文顯示。 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, font } from '@/theme/tokens';

export interface RichLine {
  bullet: boolean;
  parts: { text: string; bold: boolean }[];
}

export function parseRichText(text: string): RichLine[] {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
      const body = m ? m[1] : line;
      const parts = body
        .split(/(\*\*[^*]+\*\*)/)
        .filter((p) => p !== '')
        .map((p) => (p.startsWith('**') && p.endsWith('**') ? { text: p.slice(2, -2), bold: true } : { text: p, bold: false }));
      return { bullet: Boolean(m), parts };
    });
}

export function RichText({ text, color = colors.text }: { text: string; color?: string }) {
  return (
    <View style={{ gap: 4 }}>
      {parseRichText(text).map((line, i) => (
        <View key={i} style={styles.line}>
          {line.bullet ? <Text style={[styles.text, { color }]}>•</Text> : null}
          <Text style={[styles.text, { color, flex: 1 }]}>
            {line.parts.map((p, j) => (
              <Text key={j} style={p.bold ? styles.bold : undefined}>{p.text}</Text>
            ))}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', gap: 6 },
  text: { fontSize: font.md, lineHeight: 22 },
  bold: { fontWeight: '700' },
});
