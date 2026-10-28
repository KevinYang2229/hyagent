/** AI 對話（稿 3）：寬版左助理面板、右對話；窄版助理橫條在上。 */
import { APP_IMAGES } from '@/brand/assets';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, ImageBackground, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';
import { AssistantPanel, type VoiceInteraction } from '@hyagent/app-core/chat/AssistantPanel';
import { ChatInput } from '@hyagent/app-core/chat/ChatInput';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { MessageBubble } from '@hyagent/app-core/chat/MessageBubble';
import { isNearBottom, shouldAutoScroll } from '@hyagent/app-core/chat/autoScroll';
import { useAutoAsk } from '@hyagent/app-core/chat/useAutoAsk';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useSettings } from '@hyagent/app-core/settings/SettingsProvider';
import { chatFont, colors, font, radius, shadow, space } from '@hyagent/app-core/theme/tokens';
import { useExpoRecorder } from '@hyagent/app-core/voice/expoRecorder';
import { stopSpeaking } from '@hyagent/app-core/voice/speech';
import { useSpeakReplies } from '@hyagent/app-core/voice/useSpeakReplies';
import { useVoiceInput } from '@hyagent/app-core/voice/useVoiceInput';
import { PERMISSION_HINT } from '@hyagent/app-core/voice/voiceMachine';

export const GREETING = '嗨！我是 Open醬，可以幫你查庫存、建補貨單、查活動和優惠券，也能回答門市作業問題。';

export default function ChatScreen() {
  const wide = useIsWide();
  const chat = useChat();
  const { speakEnabled, setSpeakEnabled } = useSettings();
  const params = useLocalSearchParams<{ q?: string; nonce?: string; focus?: string; voice?: string }>();
  const inputRef = useRef<TextInput>(null);
  const [editRequest, setEditRequest] = useState<{ text: string; nonce: number }>();
  const editMessage = (text: string) => setEditRequest((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
  const listRef = useRef<FlatList>(null);
  const { messages, sending } = chat.state;
  const lastAgent = [...messages].reverse().find((m) => m.role === 'agent');
  const suggestions = sending ? [] : lastAgent?.suggestions ?? [];

  const nearBottom = useRef(true);
  const prev = useRef({ count: 0, sending: false });
  const kavRef = useRef<View>(null);
  const [kavOffset, setKavOffset] = useState(0);

  // 量對話欄在視窗中的實際頂端位置，當作鍵盤避讓偏移（Android 靠 adjustResize，不使用 behavior）
  const measureKav = useCallback(() => {
    kavRef.current?.measureInWindow((_x, y) => setKavOffset(Math.max(0, y)));
  }, []);

  useAutoAsk(params.q, params.nonce, chat.send);

  const [voiceInteraction, setVoiceInteraction] = useState<VoiceInteraction>('conversation');
  const recordingInteraction = useRef<VoiceInteraction>('conversation');
  const voiceStarting = useRef(false);
  const api = useApi();
  const recorder = useExpoRecorder();
  const voice = useVoiceInput({ recorder, transcribe: api.transcribe, onText: (t) => {
    if (recordingInteraction.current === 'dictation') editMessage(t);
    else void chat.send(t);
  } });
  const startVoice = async (interaction = voiceInteraction) => {
    if (voiceStarting.current || voice.state.mode !== 'idle') return;
    voiceStarting.current = true;
    recordingInteraction.current = interaction;
    stopSpeaking();
    try { await voice.start(); } finally { voiceStarting.current = false; }
  };
  // 錄音中不朗讀：視同關閉（會停止朗讀，且錄音期間到的回覆不補唸）
  useSpeakReplies(messages, speakEnabled && voice.state.mode !== 'recording');

  // 從首頁大麥克風進來（voice=1）：每個 nonce 只自動開始一次
  const voiceNonce = useRef<string | null>(null);
  useEffect(() => {
    if (params.voice === '1' && params.nonce && voiceNonce.current !== params.nonce) {
      voiceNonce.current = params.nonce;
      setVoiceInteraction('conversation');
      void startVoice('conversation');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.voice, params.nonce]);

  const hint = voice.state.mode === 'idle' ? voice.state.hint : null;

  useEffect(() => {
    if (params.focus === '1') setTimeout(() => inputRef.current?.focus(), 300);
  }, [params.focus, params.nonce]);

  const openCamera = () => router.push({ pathname: '/camera', params: { mode: 'shelf' } });

  const panel = (
    <View style={{ flex: wide ? 1 : undefined }}>
      <AssistantPanel
        mode={voice.state.mode}
        interaction={voiceInteraction}
        onInteractionChange={setVoiceInteraction}
        metering={recorder.metering}
        hint={hint}
        compact={!wide}
        micAvailable={voice.available}
        // 回覆中先停用麥克風（按鈕保留、變灰；錄到一半的仍可停止）
        busy={sending}
        onMicPress={() => void startVoice()}
        onStopPress={() => void voice.stop()}
        onKeyboard={() => inputRef.current?.focus()}
        onCamera={openCamera}
      />
      {hint === PERMISSION_HINT ? (
        <Pressable onPress={() => void Linking.openSettings()} accessibilityRole="button" style={{ alignSelf: 'center', padding: space.sm }}>
          <Text style={{ color: colors.primaryDark, fontSize: font.sm }}>前往設定</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const conversation = (
    <View style={[styles.chatCard, !wide && styles.chatCardNarrow]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>AI 小幫手</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setSpeakEnabled(!speakEnabled)} style={styles.headerBtn} accessibilityRole="switch" accessibilityState={{ checked: speakEnabled }} accessibilityLabel="朗讀">
          <Ionicons name={speakEnabled ? 'volume-high-outline' : 'volume-mute-outline'} size={18} color={colors.text} />
          <Text style={styles.headerBtnText}>朗讀 {speakEnabled ? '開' : '關'}</Text>
        </Pressable>
        <Pressable onPress={chat.newConversation} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel="新對話">
          <Ionicons name="refresh-outline" size={18} color={colors.text} />
          <Text style={styles.headerBtnText}>新對話</Text>
        </Pressable>
      </View>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space.md }}
        ListHeaderComponent={<Text style={styles.greeting}>{GREETING}</Text>}
        ListFooterComponent={sending ? <Text style={styles.typing}>Open醬思考中…</Text> : null}
        renderItem={({ item }) => <MessageBubble message={item} showSuggestions={false} onSuggestion={chat.send} onEdit={editMessage} />}
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
      <View style={{ padding: space.md }}>
        {suggestions.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestions.map((suggestion) => (
              <Pressable key={suggestion} style={styles.suggestion} accessibilityRole="button" onPress={() => void chat.send(suggestion)}>
                <Text style={styles.suggestionText}>{suggestion}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <ChatInput
          onSend={chat.send}
          micAvailable={false}
          disabled={sending}
          onCancel={chat.cancelSend}
          inputRef={inputRef}
          editRequest={editRequest}
        />
      </View>
    </View>
  );

  const column = (style: object) => (
    <View ref={kavRef} style={style} onLayout={measureKav} collapsable={false}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={kavOffset}>
        {conversation}
      </KeyboardAvoidingView>
    </View>
  );

  return (
    <ImageBackground source={APP_IMAGES.chatBackground} style={styles.page} resizeMode="cover">
      {wide ? (
        <View style={styles.row}>
          <View style={{ width: '38%' }}>{panel}</View>
          {column({ flex: 1, padding: space.md })}
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {panel}
          {column({ flex: 1 })}
        </View>
      )}
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  row: { flex: 1, flexDirection: 'row' },
  chatCard: { flex: 1, backgroundColor: colors.bg, borderRadius: radius.xl, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, ...shadow.card },
  chatCardNarrow: { borderRadius: 0, borderWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitle: { fontSize: font.lg, fontWeight: '700', color: colors.text },
  headerBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.md, backgroundColor: colors.bg },
  headerBtnText: { fontSize: chatFont.label, fontWeight: '600', color: colors.text },
  greeting: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md, fontSize: chatFont.body, lineHeight: chatFont.lineHeight, fontWeight: '500', color: colors.text, marginBottom: space.sm, maxWidth: '85%' },
  typing: { fontSize: font.sm, color: colors.textMuted, marginTop: space.sm },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  suggestion: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  suggestionText: { fontSize: chatFont.label, fontWeight: '600', color: colors.text },
});
