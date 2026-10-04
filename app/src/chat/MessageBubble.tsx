import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';
import { colors, font, radius, shadow, space } from '@/theme/tokens';
import { RichText } from './RichText';
import { TableBlockView } from './TableBlockView';
import type { ChatMessage } from './types';

function time(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessageBubble({
  message,
  showSuggestions,
  onSuggestion,
}: {
  message: ChatMessage;
  showSuggestions: boolean;
  onSuggestion(text: string): void;
}) {
  if (message.role === 'system') {
    return (
      <Text style={[styles.system, message.tone === 'error' && { color: colors.danger }]} accessibilityRole="alert">
        {message.text}
      </Text>
    );
  }
  if (message.role === 'user') {
    return (
      <View style={styles.userWrap}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{message.text}</Text>
        </View>
        <Text style={styles.time}>{time(message.at)}</Text>
      </View>
    );
  }
  return (
    <View style={styles.agentWrap}>
      <Mascot pose="wave" size={36} />
      <View style={{ flex: 1 }}>
        <View style={styles.agentBubble}>
          <RichText text={message.text} />
          {message.blocks?.map((b, i) => <TableBlockView key={i} block={b} />)}
        </View>
        {showSuggestions && message.suggestions && message.suggestions.length > 0 ? (
          <View style={styles.chips}>
            {message.suggestions.map((s) => (
              <Pressable key={s} style={styles.chip} onPress={() => onSuggestion(s)} accessibilityRole="button">
                <Text style={styles.chipText}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={styles.time}>{time(message.at)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  system: { alignSelf: 'center', fontSize: font.sm, color: colors.textMuted, marginVertical: space.sm, textAlign: 'center' },
  userWrap: { alignItems: 'flex-end', marginVertical: space.sm },
  userBubble: { maxWidth: '80%', backgroundColor: colors.primarySoft, borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.lg, paddingVertical: space.md },
  userText: { fontSize: font.md, color: colors.text },
  agentWrap: { flexDirection: 'row', gap: space.sm, marginVertical: space.sm, alignItems: 'flex-start' },
  agentBubble: { backgroundColor: colors.surface, borderRadius: radius.lg, borderTopLeftRadius: 4, padding: space.md, ...shadow.card },
  time: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  chipText: { fontSize: font.sm, color: colors.text },
});
