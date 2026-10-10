import { useMemo } from 'react';
import { useChatTypography } from './ChatTypography';
/**
 * AI 回覆的簡易排版：處理條列（- 、* 顯示為 •；1. 保留原編號）、標題（去掉開頭 #，整行粗體）、**粗體**、
 * markdown 表格（連續以 | 開頭的行，畫成表格、欄位多時可左右滑）與分隔線（---）。其餘 markdown 符號照原文顯示。
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@hyagent/app-core/theme/tokens';

export interface RichLine {
  bullet: boolean;
  /** 條列符號：無序清單為「•」，有序清單保留原編號（例如「1.」）；非條列沒有 */
  marker?: string;
  parts: { text: string; bold: boolean }[];
}

export type RichBlock =
  | { kind: 'line'; line: RichLine }
  | { kind: 'table'; header: RichLine['parts'][]; rows: RichLine['parts'][][] }
  | { kind: 'rule' };

function splitBold(body: string, allBold: boolean): RichLine['parts'] {
  return body
    .split(/(\*\*[^*]+\*\*)/)
    .filter((p) => p !== '')
    .map((p) => (p.startsWith('**') && p.endsWith('**') ? { text: p.slice(2, -2), bold: true } : { text: p, bold: allBold }));
}

function parseLine(line: string): RichLine {
  const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
  if (heading) return { bullet: false, parts: splitBold(heading[1], true) };
  const ordered = /^\s*(\d+\.)\s+(.*)$/.exec(line);
  if (ordered) return { bullet: true, marker: ordered[1], parts: splitBold(ordered[2], false) };
  const unordered = /^\s*[-*•]\s+(.*)$/.exec(line);
  if (unordered) return { bullet: true, marker: '•', parts: splitBold(unordered[1], false) };
  return { bullet: false, parts: splitBold(line, false) };
}

export function parseRichText(text: string): RichLine[] {
  return parseRichBlocks(text).flatMap((b) => (b.kind === 'line' ? [b.line] : []));
}

const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparatorRow = (l: string) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** 依行分段：表格（含表頭分隔列）、分隔線、一般行。表格被截斷（只有表頭）也照樣畫出來。 */
export function parseRichBlocks(text: string): RichBlock[] {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const blocks: RichBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      continue;
    }
    if (isTableLine(line)) {
      const group: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) group.push(lines[i++]);
      i--;
      const body = group.filter((l) => !isSeparatorRow(l)).map(cells);
      const hasHeader = group.length > 1 && isSeparatorRow(group[1]);
      const [head, ...rest] = hasHeader ? body : [[], ...body];
      const width = Math.max(head.length, ...rest.map((r) => r.length));
      const pad = (r: string[]) => Array.from({ length: width }, (_, k) => splitBold(r[k] ?? '', false));
      blocks.push({ kind: 'table', header: head.length ? pad(head) : [], rows: rest.map(pad) });
      continue;
    }
    blocks.push({ kind: 'line', line: parseLine(line) });
  }
  return blocks;
}

function Parts({ parts }: { parts: RichLine['parts'] }) {
  const styles = useStyles();
  return <>{parts.map((p, j) => <Text key={j} style={p.bold ? styles.bold : undefined}>{p.text}</Text>)}</>;
}

function MarkdownTable({ header, rows, color }: { header: RichLine['parts'][]; rows: RichLine['parts'][][]; color: string }) {
  const styles = useStyles();
  const cols = Math.max(header.length, rows[0]?.length ?? 0);
  // 欄位少時平均分配；多時給固定寬度、可左右滑
  const colWidth = cols <= 3 ? undefined : 150;
  const row = (r: RichLine['parts'][], key: string, head: boolean) => (
    <View key={key} style={[styles.tr, head && styles.thRow]}>
      {r.map((c, k) => (
        <View key={k} style={[styles.td, colWidth ? { width: k === 0 ? 120 : colWidth } : { flex: k === 0 ? 0.8 : 1 }, k > 0 && styles.tdBorder]}>
          <Text style={[styles.cell, { color }, (head || k === 0) && styles.bold]}><Parts parts={c} /></Text>
        </View>
      ))}
    </View>
  );
  const table = (
    <View style={[styles.table, !colWidth && { alignSelf: 'stretch' }]}>
      {header.length ? row(header, 'h', true) : null}
      {rows.map((r, i) => row(r, String(i), false))}
    </View>
  );
  return colWidth ? <ScrollView horizontal showsHorizontalScrollIndicator>{table}</ScrollView> : table;
}

export function RichText({ text, color = colors.text }: { text: string; color?: string }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      {parseRichBlocks(text).map((b, i) => {
        if (b.kind === 'rule') return <View key={i} style={styles.rule} />;
        if (b.kind === 'table') return <MarkdownTable key={i} header={b.header} rows={b.rows} color={color} />;
        const line = b.line;
        return (
          <View key={i} style={styles.line}>
            {line.bullet ? <Text style={[styles.text, { color }]}>{line.marker ?? '•'}</Text> : null}
            <Text style={[styles.text, { color, flex: 1 }]}><Parts parts={line.parts} /></Text>
          </View>
        );
      })}
    </View>
  );
}

function useStyles() {
  const chatFont = useChatTypography();
  return useMemo(() => StyleSheet.create({
  line: { flexDirection: 'row', gap: 6 },
  text: { fontSize: chatFont.body, lineHeight: chatFont.lineHeight, fontWeight: '500' },
  bold: { fontWeight: '700' },
  rule: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden', marginVertical: 2 },
  tr: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border },
  thRow: { borderTopWidth: 0, backgroundColor: colors.primarySoft },
  td: { paddingHorizontal: 10, paddingVertical: 8 },
  tdBorder: { borderLeftWidth: 1, borderLeftColor: colors.border },
  cell: { fontSize: chatFont.label, lineHeight: chatFont.label + 6 },
}), [chatFont]);
}
