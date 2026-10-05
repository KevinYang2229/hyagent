import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
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
  onEdit,
}: {
  message: ChatMessage;
  showSuggestions: boolean;
  onSuggestion(text: string): void;
  onEdit(text: string): void;
}) {
  const [copied, setCopied] = useState(false);
  const actions = (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={copied ? '已複製訊息' : '複製訊息'} style={styles.action} onPress={async () => {
        try {
          await Clipboard.setStringAsync(message.text);
          setCopied(true);
        } catch {
          Alert.alert('複製失敗', '請再試一次');
        }
      }}>
        <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={20} color={colors.primaryDark} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="重新編輯訊息" style={styles.action} onPress={() => onEdit(message.text)}>
        <Ionicons name="create-outline" size={20} color={colors.primaryDark} />
      </Pressable>
    </View>
  );
  if (message.role === 'system') {
    return (
      <View style={{ alignItems: 'center' }}>
      <Text style={[styles.system, message.tone === 'error' && { color: colors.danger }]} accessibilityRole="alert">
        {message.text}
      </Text>
      {message.hideActions ? null : actions}
      </View>
    );
  }
  if (message.role === 'user') {
    return (
      <View style={styles.userWrap}>
        <View style={styles.userMessage}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{message.text}</Text>
        </View>
        <View style={styles.meta}>
          <Text style={styles.time}>{time(message.at)}</Text>
          {actions}
        </View>
        </View>
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
        <View style={styles.meta}>
          <Text style={styles.time}>{time(message.at)}</Text>
          {actions}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', justifyContent: 'flex-start', gap: space.sm, marginTop: -6, marginLeft: 8 },
  actions: { flexDirection: 'row' },
  action: { width: 28, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  system: { alignSelf: 'center', fontSize: font.sm, color: colors.textMuted, marginVertical: space.sm, textAlign: 'center' },
  userWrap: { alignItems: 'flex-end', marginVertical: space.sm },
  userMessage: { maxWidth: '80%' },
  userBubble: { backgroundColor: colors.primarySoft, borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.lg, paddingVertical: space.md },
  userText: { fontSize: font.md, color: colors.text },
  agentWrap: { flexDirection: 'row', gap: space.sm, marginVertical: space.sm, alignItems: 'flex-start' },
  agentBubble: { backgroundColor: colors.surface, borderRadius: radius.lg, borderTopLeftRadius: 4, padding: space.md, ...shadow.card },
  time: { fontSize: 11, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  chipText: { fontSize: font.sm, color: colors.text },
});
