/** 倒讚後的原因面板（底部彈出）。原因與說明都可略過。 */
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FeedbackReason } from '@hyagent/shared';
import { useAppBranding } from '@hyagent/app-core/branding/AppBranding';
import { colors, radius, space } from '@hyagent/app-core/theme/tokens';

const REASONS: { value: FeedbackReason; label: string }[] = [
  { value: 'wrong', label: '答錯了' },
  { value: 'not_answered', label: '沒回答到問題' },
  { value: 'outdated', label: '資料過時' },
  { value: 'inappropriate', label: '內容不恰當' },
  { value: 'other', label: '其他' },
];

export function FeedbackSheet({
  visible,
  onSubmit,
  onSkip,
}: {
  visible: boolean;
  onSubmit(detail: { reason?: FeedbackReason; comment?: string }): void;
  onSkip(): void;
}) {
  const { accent = colors } = useAppBranding();
  const [reason, setReason] = useState<FeedbackReason | undefined>();
  const [comment, setComment] = useState('');

  function close(submit: boolean) {
    const trimmed = comment.trim();
    if (submit) onSubmit({ ...(reason ? { reason } : {}), ...(trimmed ? { comment: trimmed } : {}) });
    else onSkip();
    setReason(undefined);
    setComment('');
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => close(false)}>
      <KeyboardAvoidingView style={styles.avoid} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={styles.backdrop} onPress={() => close(false)} accessibilityLabel="略過回饋" />
      <View style={styles.sheet}>
        <Text style={styles.title}>哪裡不好？</Text>
        <View style={styles.reasons}>
          {REASONS.map((r) => {
            const selected = reason === r.value;
            return (
              <Pressable
                key={r.value}
                accessibilityRole="radio"
                accessibilityLabel={r.label}
                accessibilityState={{ selected }}
                onPress={() => setReason(selected ? undefined : r.value)}
                style={[styles.reason, selected && { borderColor: accent.primary, backgroundColor: accent.primarySoft }]}
              >
                <Text style={[styles.reasonText, selected && { color: accent.primaryDark }]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          style={styles.input}
          placeholder="補充說明（選填）"
          accessibilityLabel="補充說明"
          value={comment}
          onChangeText={setComment}
          maxLength={500}
        />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="略過" onPress={() => close(false)} style={styles.skip}>
            <Text style={styles.skipText}>略過</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="送出回饋" onPress={() => close(true)} style={[styles.submit, { backgroundColor: accent.primary }]}>
            <Text style={styles.submitText}>送出</Text>
          </Pressable>
        </View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  avoid: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: space.md },
  title: { fontSize: 17, fontWeight: '600', color: colors.text },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  reason: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  reasonText: { fontSize: 15, color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 44, fontSize: 15, color: colors.text },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  skip: { paddingHorizontal: space.lg, minHeight: 44, justifyContent: 'center' },
  skipText: { fontSize: 15, color: colors.textMuted },
  submit: { paddingHorizontal: space.lg, minHeight: 44, justifyContent: 'center', borderRadius: radius.md },
  submitText: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
