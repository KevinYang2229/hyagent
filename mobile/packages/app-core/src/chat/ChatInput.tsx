import { useMemo } from 'react';
import { useChatTypography } from './ChatTypography';
/** 輸入列：送出即清空（失敗還原草稿）；麥克風可用時顯示在左邊。 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useAppBranding } from '@hyagent/app-core/branding/AppBranding';
import { colors, radius, space } from '@hyagent/app-core/theme/tokens';

export function ChatInput({
  onSend,
  micAvailable,
  onMicPress,
  disabled,
  onCancel,
  inputRef,
  editRequest,
  placeholder = '請說出或輸入你的需求…',
  largeControls = false,
}: {
  onSend(text: string): Promise<boolean>;
  micAvailable: boolean;
  onMicPress?: () => void;
  disabled?: boolean;
  onCancel?: () => void;
  inputRef?: RefObject<TextInput | null>;
  editRequest?: { text: string; nonce: number };
  placeholder?: string;
  largeControls?: boolean;
}) {
  const styles = useStyles();
  const accent = useAppBranding().accent ?? colors;
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
    <View style={[styles.bar, focused && { borderColor: accent.primary, backgroundColor: accent.primarySoft }]}>
      {micAvailable ? (
        <Pressable style={[styles.mic, largeControls && styles.largeControl, { backgroundColor: accent.primary }]} onPress={onMicPress} accessibilityLabel="開始說話" accessibilityRole="button">
          <Ionicons name="mic" size={largeControls ? 30 : 22} color="#fff" />
        </Pressable>
      ) : null}
      <TextInput
        key={editor.key}
        ref={editorRef}
        style={styles.input}
        placeholder={placeholder}
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
        <Pressable style={[styles.send, largeControls && styles.largeControl]} onPress={onCancel} accessibilityLabel="取消回覆" accessibilityRole="button">
          <Ionicons name="stop" size={largeControls ? 28 : 20} color={accent.primaryDark} />
        </Pressable>
      ) : <Pressable style={[styles.send, largeControls && styles.largeControl, { backgroundColor: accent.primarySoft }, (!text.trim() || disabled) && { opacity: 0.4 }]} onPress={submit} accessibilityLabel="送出" accessibilityRole="button">
        <Ionicons name="send" size={largeControls ? 28 : 20} color={accent.primaryDark} />
      </Pressable>}
    </View>
  );
}

function useStyles() {
  const chatFont = useChatTypography();
  return useMemo(() => StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, padding: 6 },
  mic: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  largeControl: { width: 56, height: 56, borderRadius: 28 },
  input: { flex: 1, minWidth: 0, maxHeight: 120, fontSize: chatFont.body, lineHeight: chatFont.lineHeight, fontWeight: '500', color: colors.text, paddingHorizontal: space.sm, paddingVertical: 10 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
}), [chatFont]);
}
