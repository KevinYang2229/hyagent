/**
 * HyAgent 對話（稿 02）：App 的核心。回覆下方帶出提到的產品卡，底部「你可能還想問」與輸入列（可語音）。
 * 從首頁、產品頁、比較頁帶問題進來（q + nonce），每個 nonce 只送一次。
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';
import { ChatInput } from '@hyagent/app-core/chat/ChatInput';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { MessageBubble } from '@hyagent/app-core/chat/MessageBubble';
import { isNearBottom, shouldAutoScroll } from '@hyagent/app-core/chat/autoScroll';
import { useAutoAsk } from '@hyagent/app-core/chat/useAutoAsk';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useSettings } from '@hyagent/app-core/settings/SettingsProvider';
import { useExpoRecorder } from '@hyagent/app-core/voice/expoRecorder';
import { stopSpeaking } from '@hyagent/app-core/voice/speech';
import { useSpeakReplies } from '@hyagent/app-core/voice/useSpeakReplies';
import { useVoiceInput } from '@hyagent/app-core/voice/useVoiceInput';
import { PERMISSION_HINT } from '@hyagent/app-core/voice/voiceMachine';
import { HyAgentAvatar } from '@/brand/Brand';
import { lib } from '@/brand/theme';
import { DEFAULT_SUGGESTIONS } from '@/catalog/agentBridge';
import { ChatWelcome } from '@/chat/ChatWelcome';
import { ProductStrip } from '@/chat/ProductStrip';

export { GREETING } from '@/chat/ChatWelcome';

export default function ChatScreen() {
  const wide = useIsWide();
  const chat = useChat();
  const { speakEnabled } = useSettings();
  const params = useLocalSearchParams<{ q?: string; nonce?: string; focus?: string; voice?: string }>();
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);
  const [editRequest, setEditRequest] = useState<{ text: string; nonce: number }>();
  const editMessage = (text: string) => setEditRequest((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
  const { messages, sending } = chat.state;
  const lastAgent = [...messages].reverse().find((m) => m.role === 'agent');
  const agentSuggestions = lastAgent?.role === 'agent' ? lastAgent.suggestions ?? [] : [];
  const suggestions = sending || messages.length === 0 ? [] : agentSuggestions.length > 0 ? agentSuggestions : DEFAULT_SUGGESTIONS;

  useAutoAsk(params.q, params.nonce, chat.send);

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

  // 從首頁麥克風進來（voice=1）：每個 nonce 只自動開始一次
  const voiceNonce = useRef<string | null>(null);
  useEffect(() => {
    if (params.voice === '1' && params.nonce && voiceNonce.current !== params.nonce) {
      voiceNonce.current = params.nonce;
      void startVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.voice, params.nonce]);

  useEffect(() => {
    if (params.focus === '1') setTimeout(() => inputRef.current?.focus(), 300);
  }, [params.focus, params.nonce]);

  const nearBottom = useRef(true);
  const prev = useRef({ count: 0, sending: false });
  const hint = voice.state.mode === 'idle' ? voice.state.hint : null;

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}>
      <View style={[styles.column, wide && styles.columnWide]}>
        {messages.length === 0 && !sending ? (
          <View style={{ flex: 1, padding: wide ? 20 : 14 }}>
            <ChatWelcome full wide={wide} onAsk={(q) => void chat.send(q)} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ padding: wide ? 20 : 14, flexGrow: 1 }}
            ListHeaderComponent={<ChatWelcome full={false} wide={wide} onAsk={(q) => void chat.send(q)} />}
            ListFooterComponent={sending ? <View style={styles.thinking}><ActivityIndicator color={lib.green} /><Text style={styles.thinkingText}>HyAgent 思考中…</Text></View> : null}
            renderItem={({ item }) => (
              <View>
                <MessageBubble message={item} showSuggestions={false} onSuggestion={(t) => void chat.send(t)} onEdit={editMessage} />
                {item.role === 'agent' ? <ProductStrip text={item.text} wide={wide} /> : null}
              </View>
            )}
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
        )}
        <View style={styles.bottom}>
          {suggestions.length > 0 ? (
            <View style={{ gap: 8, marginBottom: 10 }}>
              <View style={styles.suggestHead}>
                <MaterialCommunityIcons name="lightbulb-on-outline" size={16} color={lib.green} />
                <Text style={styles.suggestTitle}>你可能還想問</Text>
              </View>
              <View style={styles.suggestions}>
                {suggestions.map((s) => (
                  <Pressable key={s} onPress={() => void chat.send(s)} style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]} accessibilityRole="button">
                    <Text style={styles.suggestionText}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {voice.state.mode !== 'idle' ? (
            <VoiceStrip mode={voice.state.mode} onStop={() => void voice.stop()} />
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
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}


function VoiceStrip({ mode, onStop }: { mode: 'recording' | 'transcribing'; onStop(): void }) {
  return (
    <View style={styles.voice} accessibilityLiveRegion="polite">
      <HyAgentAvatar pose="mic" size={36} />
      <Text style={styles.voiceText}>{mode === 'recording' ? '正在聽你說話…說完按「停止並送出」' : '辨識中…'}</Text>
      {mode === 'recording' ? (
        <Pressable onPress={onStop} style={styles.stop} accessibilityRole="button" accessibilityLabel="停止並送出">
          <Ionicons name="stop" size={16} color="#FFFFFF" />
          <Text style={styles.stopText}>停止並送出</Text>
        </Pressable>
      ) : <ActivityIndicator color={lib.green} />}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  column: { flex: 1, width: '100%' },
  columnWide: { maxWidth: 1180, alignSelf: 'center', paddingHorizontal: 12 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  thinkingText: { fontSize: 16, color: lib.muted },
  bottom: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  suggestHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  suggestTitle: { fontSize: 17, fontWeight: '800', color: lib.ink },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  suggestion: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#CFE8D6' },
  suggestionText: { fontSize: 16, fontWeight: '600', color: lib.greenDark },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  hint: { flex: 1, fontSize: 16, color: '#C0392B' },
  hintLink: { fontSize: 16, fontWeight: '700', color: lib.greenDark },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16, backgroundColor: lib.greenSoft },
  voiceText: { flex: 1, fontSize: 17, fontWeight: '600', color: lib.ink },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: '#D93B30' },
  stopText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
});
