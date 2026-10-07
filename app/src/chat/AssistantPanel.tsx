/**
 * 助理面板（稿 3 左半）：待機、聆聽中、辨識中三種狀態。
 * compact＝窄版，改成橫條放在對話上方。
 */
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';
import { chatFont, colors, space } from '@/theme/tokens';

export type VoiceInteraction = 'conversation' | 'dictation';

export type AssistantMode = 'idle' | 'recording' | 'transcribing';

export const VOICE_EXAMPLES = ['「查詢御飯糰的庫存」', '「建立補貨單」', '「今天有哪些即期品？」', '「咖啡機紅燈怎麼處理？」'];

const TITLE: Record<AssistantMode, string> = {
  idle: '按麥克風開始說話',
  recording: '正在聽你說話…',
  transcribing: '辨識中…',
};

export function AssistantPanel({
  mode,
  interaction,
  onInteractionChange,
  metering,
  hint,
  compact,
  micAvailable,
  onMicPress,
  onStopPress,
  onKeyboard,
  onCamera,
}: {
  mode: AssistantMode;
  interaction: VoiceInteraction;
  onInteractionChange(value: VoiceInteraction): void;
  metering?: number;
  hint?: string | null;
  compact: boolean;
  micAvailable: boolean;
  onMicPress(): void;
  onStopPress(): void;
  onKeyboard(): void;
  onCamera(): void;
}) {
  const stopLabel = interaction === 'dictation' ? '停止並轉文字' : '停止並送出';
  const modeSwitch = <View style={styles.modeSwitch}>
    {(['conversation', 'dictation'] as const).map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: interaction === value, disabled: mode !== 'idle' }} disabled={mode !== 'idle'} onPress={() => onInteractionChange(value)} style={[styles.modeButton, interaction === value && styles.modeSelected, mode !== 'idle' && { opacity: 0.6 }]}>
      <Text style={[styles.modeText, !compact && styles.largeModeText, interaction === value && { color: colors.primaryDark }]}>{value === 'conversation' ? '直接送出' : '編輯後送出'}</Text>
    </Pressable>)}
  </View>;
  const title = micAvailable ? TITLE[mode] : '用打字或拍照問我';
  const description = interaction === 'dictation' ? '辨識後顯示文字，可修改再手動送出' : '辨識完成後自動送出';
  const center =
    mode === 'recording' ? (
      <RoundButton compact={compact} label={stopLabel} color={colors.danger} icon="stop" onPress={onStopPress} />
    ) : mode === 'transcribing' ? (
      <View style={[styles.round, !compact && styles.largeRound, { backgroundColor: colors.primarySoft }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    ) : micAvailable ? (
      <RoundButton compact={compact} label="開始說話" color={colors.primary} icon="mic" onPress={onMicPress} />
    ) : null;

  if (compact) {
    return (
      <View>
        {modeSwitch}
        <View style={styles.compact}>
        <Mascot pose={mode === 'recording' ? 'mic' : 'idle'} size={44} />
        <View style={{ flex: 1 }}>
          <Text style={styles.compactTitle}>{title}</Text>
          {mode === 'idle' && micAvailable ? <Text style={styles.example}>{description}</Text> : null}
          {mode === 'recording' ? <VoiceLevel metering={metering} compact={compact} /> : null}
          {mode === 'recording' ? <Text style={[styles.example, !compact && styles.largeCopy]}>說完後按「{stopLabel}」</Text> : null}
          {hint ? <Text style={[styles.hint, !compact && styles.largeCopy]}>{hint}</Text> : null}
        </View>
        <SmallButton compact label="拍照" icon="camera-outline" onPress={onCamera} />
        {center}
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.panel}>
      {modeSwitch}
      <Mascot pose={mode === 'recording' ? 'mic' : 'idle'} size={180} />
      <Text style={styles.title}>{title}</Text>
      {mode === 'recording' ? <VoiceLevel metering={metering} compact={compact} /> : null}
      {mode === 'recording' ? <Text style={[styles.example, !compact && styles.largeCopy]}>說完後按「{stopLabel}」，{interaction === 'dictation' ? '辨識後可修改文字再送出。' : '即可辨識並詢問 AI。'}</Text> : null}
      {hint ? <Text style={[styles.hint, !compact && styles.largeCopy]}>{hint}</Text> : null}
      <Text style={[styles.example, styles.largeCopy]}>{description}</Text>
      <View style={styles.examples}>
        <Text style={[styles.examplesLabel, styles.largeCopy]}>你可以說：</Text>
        {VOICE_EXAMPLES.map((e) => (
          <Text key={e} style={[styles.example, styles.largeCopy]}>{e}</Text>
        ))}
      </View>
      <View style={styles.buttons}>
        <SmallButton label="前往輸入框" icon="keypad-outline" onPress={onKeyboard} />
        {center}
        <SmallButton label="拍照" icon="camera-outline" onPress={onCamera} />
      </View>
    </ScrollView>
  );
}

function VoiceLevel({ metering, compact }: { metering?: number; compact: boolean }) {
  const known = metering !== undefined && Number.isFinite(metering);
  const bars = known ? Math.round(Math.max(0, Math.min(1, (metering + 60) / 60)) * 10) : 0;
  const label = !known ? '音量偵測中…' : bars > 0 ? '收到聲音' : '目前未偵測到聲音，請確認麥克風輸入';
  return <View style={{ gap: 4 }} accessibilityLabel={label} accessibilityLiveRegion="polite">
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {Array.from({ length: 10 }, (_, i) => <View key={i} style={{ width: 9, height: 16, borderRadius: 3, backgroundColor: i < bars ? colors.primary : colors.border }} />)}
    </View>
    <Text style={[styles.example, !compact && styles.largeCopy]}>{label}</Text>
  </View>;
}

function RoundButton({ compact = false, label, color, icon, onPress }: { compact?: boolean; label: string; color: string; icon: 'mic' | 'stop'; onPress(): void }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button" style={[styles.actionButton, compact && styles.compactActionButton]}>
      <View style={[styles.round, !compact && styles.largeRound, { backgroundColor: color }]}>
        <Ionicons name={icon} size={compact ? 36 : 48} color="#fff" />
      </View>
      <Text style={[styles.btnLabel, !compact && styles.largeButtonLabel]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ compact = false, label, icon, onPress }: { compact?: boolean; label: string; icon: 'keypad-outline' | 'camera-outline'; onPress(): void }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button" style={[styles.actionButton, compact && styles.compactActionButton]}>
      <View style={[styles.small, !compact && styles.largeSmall]}>
        <Ionicons name={icon} size={compact ? 30 : 40} color={colors.text} />
      </View>
      <Text style={[styles.btnLabel, !compact && styles.largeButtonLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modeSwitch: { flexDirection: 'row', alignSelf: 'center', backgroundColor: colors.surface, borderRadius: 24, padding: 4, gap: 4 },
  modeButton: { paddingHorizontal: space.md, paddingVertical: 10, borderRadius: 20 },
  modeSelected: { backgroundColor: colors.primarySoft },
  modeText: { fontSize: chatFont.label, fontWeight: '700', color: colors.textMuted },
  panel: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  title: { fontSize: 26, lineHeight: 36, fontWeight: '800', textAlign: 'center', color: colors.text },
  hint: { fontSize: chatFont.label, lineHeight: 24, fontWeight: '500', color: colors.danger },
  examples: { alignItems: 'flex-start', gap: 8 },
  examplesLabel: { fontSize: chatFont.label, lineHeight: 24, fontWeight: '500', color: colors.textMuted },
  example: { fontSize: chatFont.label, lineHeight: 24, fontWeight: '500', color: colors.text },
  buttons: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', gap: 8, alignSelf: 'stretch', marginTop: space.lg },
  round: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  small: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  btnLabel: { fontSize: chatFont.label, lineHeight: 24, fontWeight: '700', color: colors.text },
  largeModeText: { fontSize: 18, lineHeight: 26 },
  largeCopy: { fontSize: 20, lineHeight: 30, fontWeight: '600' },
  largeButtonLabel: { fontSize: 20, lineHeight: 28, fontWeight: '800', textAlign: 'center' },
  actionButton: { flex: 1, maxWidth: 120, alignItems: 'center', gap: 10 },
  compactActionButton: { flex: 0, gap: 6 },
  largeRound: { width: 88, height: 88, borderRadius: 44 },
  largeSmall: { width: 68, height: 68, borderRadius: 34 },
  compact: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  compactTitle: { fontSize: chatFont.body, fontWeight: '700', color: colors.text },
});
