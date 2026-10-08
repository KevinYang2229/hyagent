/**
 * AI 回覆的簡易排版：處理條列（- 、* 顯示為 •；1. 保留原編號）、標題（去掉開頭 #，整行粗體）與 **粗體**，
 * 其餘 markdown 符號照原文顯示。
 */
import { StyleSheet, Text, View } from 'react-native';
import { chatFont, colors } from '@hyagent/app-core/theme/tokens';

export interface RichLine {
  bullet: boolean;
  /** 條列符號：無序清單為「•」，有序清單保留原編號（例如「1.」）；非條列沒有 */
  marker?: string;
  parts: { text: string; bold: boolean }[];
}

function splitBold(body: string, allBold: boolean): RichLine['parts'] {
  return body
    .split(/(\*\*[^*]+\*\*)/)
    .filter((p) => p !== '')
    .map((p) => (p.startsWith('**') && p.endsWith('**') ? { text: p.slice(2, -2), bold: true } : { text: p, bold: allBold }));
}

export function parseRichText(text: string): RichLine[] {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .map((line): RichLine => {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (heading) return { bullet: false, parts: splitBold(heading[1], true) };
      const ordered = /^\s*(\d+\.)\s+(.*)$/.exec(line);
      if (ordered) return { bullet: true, marker: ordered[1], parts: splitBold(ordered[2], false) };
      const unordered = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (unordered) return { bullet: true, marker: '•', parts: splitBold(unordered[1], false) };
      return { bullet: false, parts: splitBold(line, false) };
    });
}

export function RichText({ text, color = colors.text }: { text: string; color?: string }) {
  return (
    <View style={{ gap: 8 }}>
      {parseRichText(text).map((line, i) => (
        <View key={i} style={styles.line}>
          {line.bullet ? <Text style={[styles.text, { color }]}>{line.marker ?? '•'}</Text> : null}
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
  text: { fontSize: chatFont.body, lineHeight: chatFont.lineHeight, fontWeight: '500' },
  bold: { fontWeight: '700' },
});
