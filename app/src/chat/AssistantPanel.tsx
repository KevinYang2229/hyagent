/**
 * 助理面板（稿 3 左半）：待機、聆聽中、辨識中三種狀態。
 * compact＝窄版，改成橫條放在對話上方。
 */
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';
import { colors, font, space } from '@/theme/tokens';

export type AssistantMode = 'idle' | 'recording' | 'transcribing';

export const VOICE_EXAMPLES = ['「查詢御飯糰的庫存」', '「建立補貨單」', '「今天有哪些即期品？」', '「咖啡機紅燈怎麼處理？」'];

const TITLE: Record<AssistantMode, string> = {
  idle: '按麥克風開始說話',
  recording: '正在聽你說話…',
  transcribing: '辨識中…',
};

export function AssistantPanel({
  mode,
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
  metering?: number;
  hint?: string | null;
  compact: boolean;
  micAvailable: boolean;
  onMicPress(): void;
  onStopPress(): void;
  onKeyboard(): void;
  onCamera(): void;
}) {
  const title = micAvailable ? TITLE[mode] : '用打字或拍照問我';
  const center =
    mode === 'recording' ? (
      <RoundButton label="停止並送出" color={colors.danger} icon="stop" onPress={onStopPress} />
    ) : mode === 'transcribing' ? (
      <View style={[styles.round, { backgroundColor: colors.primarySoft }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    ) : micAvailable ? (
      <RoundButton label="開始說話" color={colors.primary} icon="mic" onPress={onMicPress} />
    ) : null;

  if (compact) {
    return (
      <View style={styles.compact}>
        <Mascot pose={mode === 'recording' ? 'mic' : 'idle'} size={44} />
        <View style={{ flex: 1 }}>
          <Text style={styles.compactTitle}>{title}</Text>
          {mode === 'recording' ? <VoiceLevel metering={metering} /> : null}
          {mode === 'recording' ? <Text style={styles.example}>說完後按「停止並送出」</Text> : null}
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
        <SmallButton label="拍照" icon="camera-outline" onPress={onCamera} />
        {center}
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Mascot pose={mode === 'recording' ? 'mic' : 'idle'} size={180} />
      <Text style={styles.title}>{title}</Text>
      {mode === 'recording' ? <VoiceLevel metering={metering} /> : null}
      {mode === 'recording' ? <Text style={styles.example}>說完後按「停止並送出」，即可辨識並詢問 AI。</Text> : null}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <View style={styles.examples}>
        <Text style={styles.examplesLabel}>你可以說：</Text>
        {VOICE_EXAMPLES.map((e) => (
          <Text key={e} style={styles.example}>{e}</Text>
        ))}
      </View>
      <View style={styles.buttons}>
        <SmallButton label="鍵盤輸入" icon="keypad-outline" onPress={onKeyboard} />
        {center}
        <SmallButton label="拍照" icon="camera-outline" onPress={onCamera} />
      </View>
    </View>
  );
}

function VoiceLevel({ metering }: { metering?: number }) {
  const known = metering !== undefined && Number.isFinite(metering);
  const bars = known ? Math.round(Math.max(0, Math.min(1, (metering + 60) / 60)) * 10) : 0;
  const label = !known ? '音量偵測中…' : bars > 0 ? '收到聲音' : '目前未偵測到聲音，請確認麥克風輸入';
  return <View style={{ gap: 4 }} accessibilityLabel={label} accessibilityLiveRegion="polite">
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {Array.from({ length: 10 }, (_, i) => <View key={i} style={{ width: 9, height: 16, borderRadius: 3, backgroundColor: i < bars ? colors.primary : colors.border }} />)}
    </View>
    <Text style={styles.example}>{label}</Text>
  </View>;
}

function RoundButton({ label, color, icon, onPress }: { label: string; color: string; icon: 'mic' | 'stop'; onPress(): void }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button" style={{ alignItems: 'center', gap: 6 }}>
      <View style={[styles.round, { backgroundColor: color }]}>
        <Ionicons name={icon} size={30} color="#fff" />
      </View>
      <Text style={styles.btnLabel}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, icon, onPress }: { label: string; icon: 'keypad-outline' | 'camera-outline'; onPress(): void }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button" style={{ alignItems: 'center', gap: 6 }}>
      <View style={styles.small}>
        <Ionicons name={icon} size={24} color={colors.text} />
      </View>
      <Text style={styles.btnLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  title: { fontSize: font.xl, fontWeight: '700', color: colors.text },
  hint: { fontSize: font.sm, color: colors.danger },
  examples: { alignItems: 'flex-start', gap: 2 },
  examplesLabel: { fontSize: font.sm, color: colors.textMuted },
  example: { fontSize: font.sm, color: colors.text },
  buttons: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', alignSelf: 'stretch', marginTop: space.lg },
  round: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  small: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  btnLabel: { fontSize: font.sm, color: colors.text },
  compact: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  compactTitle: { fontSize: font.md, fontWeight: '600', color: colors.text },
});
