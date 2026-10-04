/** 輸入列：送出成功才清空（失敗保留文字）；麥克風可用時顯示在左邊。 */
import { Ionicons } from '@expo/vector-icons';
import { useState, type RefObject } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { colors, font, radius, space } from '@/theme/tokens';

export function ChatInput({
  onSend,
  micAvailable,
  onMicPress,
  disabled,
  inputRef,
}: {
  onSend(text: string): Promise<boolean>;
  micAvailable: boolean;
  onMicPress?: () => void;
  disabled?: boolean;
  inputRef?: RefObject<TextInput | null>;
}) {
  const [text, setText] = useState('');

  async function submit() {
    if (disabled || !text.trim()) return;
    let ok = false;
    try {
      ok = await onSend(text);
    } catch {
      ok = false; // 失敗保留文字
    }
    if (ok) setText('');
  }

  return (
    <View style={styles.bar}>
      {micAvailable ? (
        <Pressable style={styles.mic} onPress={onMicPress} accessibilityLabel="開始說話" accessibilityRole="button">
          <Ionicons name="mic" size={22} color="#fff" />
        </Pressable>
      ) : null}
      <TextInput
        ref={inputRef}
        style={styles.input}
        placeholder="請說出或輸入你的需求…"
        placeholderTextColor={colors.textMuted}
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        returnKeyType="send"
      />
      <Pressable style={[styles.send, (!text.trim() || disabled) && { opacity: 0.4 }]} onPress={submit} accessibilityLabel="送出" accessibilityRole="button">
        <Ionicons name="send" size={20} color={colors.primaryDark} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, padding: 6 },
  mic: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: font.md, color: colors.text, paddingHorizontal: space.sm, paddingVertical: 10 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
});
