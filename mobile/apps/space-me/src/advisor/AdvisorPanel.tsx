/**
 * HyAgent AI 產品顧問：平板與手機皆使用完整頁面，返回時保留原頁與對話。
 * 開場白與建議問題依所在頁面切換；可打字或語音（後端未設定語音時只能打字）。
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, BackHandler, Easing, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions,
  type TextInput,
} from 'react-native';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';
import { ChatTypographyContext } from '@hyagent/app-core/chat/ChatTypography';
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
import { PAGE_TOP_SPACE } from '@/chrome/Page';
import { useAdvisor } from './AdvisorProvider';
import { advisorPrompt } from './prompts';

const ADVISOR_AVATAR_SIZE = 60;
const advisorTypography = { body: 20, lineHeight: 32, label: 18, caption: 15 };

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
      <ChatTypographyContext.Provider value={advisorTypography}>
        <AdvisorConversation pathname={pathname} onClose={hide} />
      </ChatTypographyContext.Provider>
    </Animated.View>
  );
}

function AdvisorConversation({ pathname, onClose }: { pathname: string; onClose(): void }) {
  const chat = useChat();
  const { width, fontScale } = useWindowDimensions();
  const twoColumns = width >= 700 && fontScale < 1.4;
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
      <View style={[styles.header, { paddingTop: insets.top + PAGE_TOP_SPACE.phone + 16 }]}>
        <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回">
          <Ionicons name="arrow-back" size={26} color={sm.blue} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>HyAgent AI 產品顧問</Text>
        <View style={styles.tools}>
        <Pressable onPress={() => void setSpeakEnabled(!speakEnabled)} hitSlop={8} style={styles.tool} accessibilityRole="switch" accessibilityState={{ checked: speakEnabled }} accessibilityLabel="朗讀回覆">
          <Ionicons name={speakEnabled ? 'volume-high-outline' : 'volume-mute-outline'} size={22} color={sm.inkSoft} />
        </Pressable>
        <Pressable onPress={() => { stopSpeaking(); chat.newConversation(); }} hitSlop={8} style={styles.tool} accessibilityRole="button" accessibilityLabel="新對話">
          <Ionicons name="refresh-outline" size={22} color={sm.inkSoft} />
        </Pressable>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[styles.list, messages.length === 0 && styles.emptyList]}
        ListHeaderComponent={
          <View style={[styles.intro, messages.length === 0 && styles.introEmpty]}>
            <View style={styles.welcome}>
              <View style={{ width: ADVISOR_AVATAR_SIZE, flexShrink: 0 }}><RobotAvatar size={ADVISOR_AVATAR_SIZE} /></View>
              <View style={styles.greeting}><Text style={styles.greetingText}>{prompt.greeting}</Text></View>
            </View>
            {messages.length === 0 ? (
              <View style={{ gap: 14 }}>
                <Text style={styles.startersTitle}>今天想了解什麼？</Text>
                <View style={[styles.starters, twoColumns && styles.startersWide]}>
                {prompt.suggestions.map((q) => (
                  <Pressable key={q} onPress={() => void chat.send(q)} style={({ pressed }) => [styles.starter, twoColumns && styles.starterWide, pressed && { opacity: 0.7 }]} accessibilityRole="button">
                    <View style={styles.starterIcon}><Ionicons name="arrow-forward" size={16} color={sm.blue} /></View>
                    <Text style={styles.starterText}>{q}</Text>
                  </Pressable>
                ))}
                </View>
                <Text style={styles.inputHint}>選擇問題開始，或在下方輸入您的需求。</Text>
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={sending ? (
          <View style={styles.thinking}><ActivityIndicator color={sm.blue} /><Text style={styles.thinkingText}>HyAgent 思考中…</Text></View>
        ) : null}
        renderItem={({ item }) => <MessageBubble avatarSize={ADVISOR_AVATAR_SIZE} message={item} showSuggestions={false} onSuggestion={(t) => void chat.send(t)} onEdit={editMessage} />}
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
          largeControls
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
  conversation: { flex: 1, width: '100%' },
  header: { width: '100%', maxWidth: 1200, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 12 },
  title: { flex: 1, fontSize: 22, lineHeight: 30, fontWeight: '800', color: sm.ink },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  tool: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  list: { width: '100%', maxWidth: 1200, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 12, flexGrow: 1 },
  emptyList: { paddingBottom: 24 },
  intro: { gap: 20, marginBottom: 8 },
  introEmpty: { padding: 20, borderRadius: 28, backgroundColor: sm.blueSoft },
  startersTitle: { fontSize: 22, lineHeight: 32, fontWeight: '800', color: sm.ink },
  inputHint: { fontSize: 17, lineHeight: 26, color: sm.inkSoft },
  welcome: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  greeting: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 20, borderTopLeftRadius: 6, padding: 16, ...shadow.card },
  greetingText: { fontSize: 20, lineHeight: 32, color: sm.ink, fontWeight: '500' },
  starters: { gap: 12 },
  startersWide: { flexDirection: 'row', flexWrap: 'wrap' },
  starterWide: { flexBasis: '48%', flexGrow: 1, minHeight: 100 },
  starter: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 18, borderRadius: 18, borderWidth: 1, borderColor: '#C9D9FF', backgroundColor: '#FFFFFF' },
  starterIcon: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: sm.blue, alignItems: 'center', justifyContent: 'center' },
  starterText: { flex: 1, fontSize: 18, lineHeight: 28, fontWeight: '600', color: sm.blueDark },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  thinkingText: { fontSize: 18, lineHeight: 28, color: sm.inkSoft },
  bottom: { width: '100%', maxWidth: 1200, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C9D9FF' },
  chipText: { fontSize: 18, lineHeight: 28, fontWeight: '600', color: sm.blueDark },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 16, backgroundColor: sm.blueSoft },
  voiceText: { flex: 1, fontSize: 18, lineHeight: 28, fontWeight: '600', color: sm.ink },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: sm.danger },
  stopText: { fontSize: 18, lineHeight: 28, fontWeight: '800', color: '#FFFFFF' },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hint: { flex: 1, fontSize: 18, lineHeight: 28, color: sm.danger },
  hintLink: { fontSize: 18, lineHeight: 28, fontWeight: '700', color: sm.blueDark },
});
