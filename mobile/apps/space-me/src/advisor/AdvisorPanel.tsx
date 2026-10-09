/**
 * HyAgent AI 產品顧問：平板與手機皆使用完整頁面，返回時保留原頁與對話。
 * 開場白與建議問題依所在頁面切換；可打字或語音（後端未設定語音時只能打字）。
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, BackHandler, Easing, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View,
  type TextInput,
} from 'react-native';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';
import { ChatInput } from '@hyagent/app-core/chat/ChatInput';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { MessageBubble } from '@hyagent/app-core/chat/MessageBubble';
import { isNearBottom, shouldAutoScroll } from '@hyagent/app-core/chat/autoScroll';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '@hyagent/app-core/settings/SettingsProvider';
import { useExpoRecorder } from '@hyagent/app-core/voice/expoRecorder';
import { stopSpeaking } from '@hyagent/app-core/voice/speech';
import { useSpeakReplies } from '@hyagent/app-core/voice/useSpeakReplies';
import { useVoiceInput } from '@hyagent/app-core/voice/useVoiceInput';
import { PERMISSION_HINT } from '@hyagent/app-core/voice/voiceMachine';
import { RobotAvatar } from '@/brand/Brand';
import { shadow, sm } from '@/brand/theme';
import { useAdvisor } from './AdvisorProvider';
import { advisorPrompt } from './prompts';

export function AdvisorPanel({ pathname }: { pathname: string }) {
  const { open, hide } = useAdvisor();
  const fade = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
    Animated.timing(fade, { toValue: open ? 1 : 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      .start(({ finished }) => { if (finished && !open) setMounted(false); });
  }, [open, fade]);

  // Android 返回鍵：面板開著時先關面板
  useEffect(() => {
    if (!open || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { hide(); return true; });
    return () => sub.remove();
  }, [open, hide]);

  if (!mounted) return null;
  return (
    <Animated.View
      style={[styles.panel, StyleSheet.absoluteFill, { opacity: fade }]}
      accessibilityViewIsModal
    >
      <AdvisorConversation pathname={pathname} onClose={hide} />
    </Animated.View>
  );
}

function AdvisorConversation({ pathname, onClose }: { pathname: string; onClose(): void }) {
  const chat = useChat();
  const { speakEnabled, setSpeakEnabled } = useSettings();
  const prompt = advisorPrompt(pathname);
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);
  const [editRequest, setEditRequest] = useState<{ text: string; nonce: number }>();
  const editMessage = (text: string) => setEditRequest((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
  const { messages, sending } = chat.state;
  const lastAgent = [...messages].reverse().find((m) => m.role === 'agent');
  const followUps = sending ? [] : lastAgent?.role === 'agent' ? lastAgent.suggestions ?? [] : [];

  const api = useApi();
  const recorder = useExpoRecorder();
  const voice = useVoiceInput({ recorder, transcribe: api.transcribe, onText: (t) => void chat.send(t) });
  const voiceStarting = useRef(false);
  const startVoice = useCallback(async () => {
    if (voiceStarting.current || voice.state.mode !== 'idle') return;
    voiceStarting.current = true;
    stopSpeaking();
    try { await voice.start(); } finally { voiceStarting.current = false; }
  }, [voice]);
  // 錄音中不朗讀
  useSpeakReplies(messages, speakEnabled && voice.state.mode !== 'recording');
  const hint = voice.state.mode === 'idle' ? voice.state.hint : null;

  const nearBottom = useRef(true);
  const prev = useRef({ count: 0, sending: false });

  const close = () => {
    stopSpeaking();
    if (voice.state.mode === 'recording') void voice.stop();
    onClose();
  };

  return (
    <KeyboardAvoidingView style={[styles.conversation, { paddingLeft: insets.left, paddingRight: insets.right }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
        <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回">
          <Ionicons name="arrow-back" size={26} color={sm.blue} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>HyAgent AI 產品顧問</Text>
        <Pressable onPress={() => void setSpeakEnabled(!speakEnabled)} hitSlop={8} style={styles.tool} accessibilityRole="switch" accessibilityState={{ checked: speakEnabled }} accessibilityLabel="朗讀回覆">
          <Ionicons name={speakEnabled ? 'volume-high-outline' : 'volume-mute-outline'} size={22} color={sm.inkSoft} />
        </Pressable>
        <Pressable onPress={() => { stopSpeaking(); chat.newConversation(); }} hitSlop={8} style={styles.tool} accessibilityRole="button" accessibilityLabel="新對話">
          <Ionicons name="refresh-outline" size={22} color={sm.inkSoft} />
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={{ gap: 16, marginBottom: 8 }}>
            <View style={styles.welcome}>
              <RobotAvatar size={60} />
              <View style={styles.greeting}><Text style={styles.greetingText}>{prompt.greeting}</Text></View>
            </View>
            {messages.length === 0 ? (
              <View style={styles.starters}>
                {prompt.suggestions.map((q) => (
                  <Pressable key={q} onPress={() => void chat.send(q)} style={({ pressed }) => [styles.starter, pressed && { opacity: 0.7 }]} accessibilityRole="button">
                    <View style={styles.starterIcon}><Ionicons name="arrow-forward" size={16} color={sm.blue} /></View>
                    <Text style={styles.starterText}>{q}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={sending ? (
          <View style={styles.thinking}><ActivityIndicator color={sm.blue} /><Text style={styles.thinkingText}>HyAgent 思考中…</Text></View>
        ) : null}
        renderItem={({ item }) => <MessageBubble message={item} showSuggestions={false} onSuggestion={(t) => void chat.send(t)} onEdit={editMessage} />}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={(e) => {
          const { layoutMeasurement, contentSize, contentOffset } = e.nativeEvent;
          nearBottom.current = isNearBottom(layoutMeasurement.height, contentSize.height, contentOffset.y);
        }}
        onContentSizeChange={() => {
          const count = messages.length;
          const go = shouldAutoScroll({ prevCount: prev.current.count, count, prevSending: prev.current.sending, sending, nearBottom: nearBottom.current });
          prev.current = { count, sending };
          if (go) listRef.current?.scrollToEnd({ animated: true });
        }}
      />

      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        {followUps.length > 0 ? (
          <View style={styles.chips}>
            {followUps.map((s) => (
              <Pressable key={s} onPress={() => void chat.send(s)} style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]} accessibilityRole="button">
                <Text style={styles.chipText}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {voice.state.mode !== 'idle' ? (
          <View style={styles.voice} accessibilityLiveRegion="polite">
            <Text style={styles.voiceText}>{voice.state.mode === 'recording' ? '正在聽您說話…說完請按「停止並送出」' : '辨識中…'}</Text>
            {voice.state.mode === 'recording' ? (
              <Pressable onPress={() => void voice.stop()} style={styles.stop} accessibilityRole="button" accessibilityLabel="停止並送出">
                <Ionicons name="stop" size={16} color="#FFFFFF" />
                <Text style={styles.stopText}>停止並送出</Text>
              </Pressable>
            ) : <ActivityIndicator color={sm.blue} />}
          </View>
        ) : hint ? (
          <View style={styles.hintRow}>
            <Text style={styles.hint}>{hint}</Text>
            {hint === PERMISSION_HINT ? <Pressable onPress={() => void Linking.openSettings()} accessibilityRole="button"><Text style={styles.hintLink}>前往設定</Text></Pressable> : null}
          </View>
        ) : null}
        <ChatInput
          onSend={chat.send}
          micAvailable={voice.available && !sending && voice.state.mode === 'idle'}
          onMicPress={() => void startVoice()}
          disabled={sending}
          onCancel={chat.cancelSend}
          inputRef={inputRef}
          editRequest={editRequest}
          placeholder="請輸入您的問題…"
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: '#F7FAFF', zIndex: 200, elevation: 40 },
  conversation: { flex: 1, width: '100%', maxWidth: 1040, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12 },
  title: { flex: 1, fontSize: 21, fontWeight: '800', color: sm.ink },
  tool: { padding: 4 },
  list: { paddingHorizontal: 20, paddingBottom: 12, flexGrow: 1 },
  welcome: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  greeting: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 20, borderTopLeftRadius: 6, padding: 16, ...shadow.card },
  greetingText: { fontSize: 17, lineHeight: 27, color: sm.ink, fontWeight: '500' },
  starters: { gap: 10, paddingLeft: 74 },
  starter: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 999, borderWidth: 1.5, borderColor: '#C9D9FF', backgroundColor: '#FFFFFF' },
  starterIcon: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: sm.blue, alignItems: 'center', justifyContent: 'center' },
  starterText: { flex: 1, fontSize: 16, fontWeight: '600', color: sm.blueDark },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  thinkingText: { fontSize: 16, color: sm.muted },
  bottom: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14, gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C9D9FF' },
  chipText: { fontSize: 15, fontWeight: '600', color: sm.blueDark },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 16, backgroundColor: sm.blueSoft },
  voiceText: { flex: 1, fontSize: 16, fontWeight: '600', color: sm.ink },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: sm.danger },
  stopText: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hint: { flex: 1, fontSize: 15, color: sm.danger },
  hintLink: { fontSize: 15, fontWeight: '700', color: sm.blueDark },
});
