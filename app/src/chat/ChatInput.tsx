/** 輸入列：送出即清空（失敗還原草稿）；麥克風可用時顯示在左邊。 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { colors, font, radius, space } from '@/theme/tokens';

export function ChatInput({
  onSend,
  micAvailable,
  onMicPress,
  disabled,
  onCancel,
  inputRef,
  editRequest,
}: {
  onSend(text: string): Promise<boolean>;
  micAvailable: boolean;
  onMicPress?: () => void;
  disabled?: boolean;
  onCancel?: () => void;
  inputRef?: RefObject<TextInput | null>;
  editRequest?: { text: string; nonce: number };
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const localInputRef = useRef<TextInput>(null);
  const editorRef = inputRef ?? localInputRef;
  const latestText = useRef('');
  const revision = useRef(0);
  const sending = useRef(false);
  const [editor, setEditor] = useState({ key: 0, initial: '' });

  function replaceText(next: string) {
    revision.current += 1;
    latestText.current = next;
    setText(next);
    setEditor((current) => ({ key: current.key + 1, initial: next }));
  }

  useEffect(() => {
    if (editRequest) replaceText(editRequest.text);
  }, [editRequest]);

  useEffect(() => {
    if (editor.initial) editorRef.current?.focus();
  }, [editor, editorRef]);

  async function submit() {
    if (disabled || sending.current || !latestText.current.trim()) return;
    const submittedText = latestText.current;
    sending.current = true;
    editorRef.current?.clear();
    replaceText('');
    const submittedRevision = revision.current;
    let ok = false;
    try {
      ok = await onSend(submittedText);
    } catch {
      ok = false;
    } finally {
      sending.current = false;
    }
    if (!ok && revision.current === submittedRevision) replaceText(submittedText);
  }

  return (
    <View style={[styles.bar, focused && styles.barFocused]}>
      {micAvailable ? (
        <Pressable style={styles.mic} onPress={onMicPress} accessibilityLabel="開始說話" accessibilityRole="button">
          <Ionicons name="mic" size={22} color="#fff" />
        </Pressable>
      ) : null}
      <TextInput
        key={editor.key}
        ref={editorRef}
        style={styles.input}
        placeholder="請說出或輸入你的需求…"
        placeholderTextColor={colors.textMuted}
        // 由原生輸入框保留注音組字，避免每次更新 value 覆蓋尚未選字的內容。
        defaultValue={editor.initial}
        onChangeText={(next) => { revision.current += 1; latestText.current = next; setText(next); }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        multiline
        submitBehavior="newline"
        returnKeyType="default"
      />
      {disabled && onCancel ? (
        <Pressable style={styles.send} onPress={onCancel} accessibilityLabel="取消回覆" accessibilityRole="button">
          <Ionicons name="stop" size={20} color={colors.primaryDark} />
        </Pressable>
      ) : <Pressable style={[styles.send, (!text.trim() || disabled) && { opacity: 0.4 }]} onPress={submit} accessibilityLabel="送出" accessibilityRole="button">
        <Ionicons name="send" size={20} color={colors.primaryDark} />
      </Pressable>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, padding: 6 },
  barFocused: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  mic: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, minWidth: 0, maxHeight: 120, fontSize: font.md, color: colors.text, paddingHorizontal: space.sm, paddingVertical: 10 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
});
