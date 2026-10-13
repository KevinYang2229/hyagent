import { useMemo } from 'react';
import { useChatTypography } from './ChatTypography';
import { useEffect, useRef, useState } from 'react';
import { Feather, Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppBranding } from '@hyagent/app-core/branding/AppBranding';
import { colors, radius, shadow, space } from '@hyagent/app-core/theme/tokens';
import { useChatOptional } from './ChatProvider';
import { FeedbackSheet } from './FeedbackSheet';
import { RichText } from './RichText';
import { TableBlockView } from './TableBlockView';
import type { ChatMessage } from './types';

/** 「感謝回饋」顯示多久（毫秒） */
const THANKS_MS = 2000;

function time(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessageBubble({
  message,
  showSuggestions,
  onSuggestion,
  onEdit,
  avatarSize = 36,
}: {
  message: ChatMessage;
  avatarSize?: number;
  showSuggestions: boolean;
  onSuggestion(text: string): void;
  onEdit(text: string): void;
}) {
  const styles = useStyles();
  const { Mascot, accent = colors } = useAppBranding();
  const [copied, setCopied] = useState(false);
  const chat = useChatOptional();
  const [sheetOpen, setSheetOpen] = useState(false);
  // 評價請求進行中：快速連點不可讓 PUT／DELETE 亂序，ref 同步擋、state 讓按鈕 disabled
  const ratingRef = useRef(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  // 只有伺服器發了 replyId、且在 ChatProvider 內的 AI 回覆可以評價
  const feedback = message.role === 'agent' && message.replyId && chat ? message.feedback : undefined;
  const canRate = message.role === 'agent' && !!message.replyId && !!chat;
  // 評價成功後在動作列尾端短暫顯示「感謝回饋」
  const [thanks, setThanks] = useState(false);
  useEffect(() => {
    if (!thanks) return;
    const timer = setTimeout(() => setThanks(false), THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

  async function rateOrAlert(next: Parameters<NonNullable<typeof chat>['rate']>[1]): Promise<boolean> {
    const result = await chat!.rate(message.id, next);
    if (!result.ok) Alert.alert('評價失敗', result.message);
    return result.ok;
  }
  async function guarded(fn: () => Promise<void>) {
    if (ratingRef.current) return;
    ratingRef.current = true;
    setRatingBusy(true);
    try {
      await fn();
    } finally {
      ratingRef.current = false;
      setRatingBusy(false);
    }
  }
  const rateUp = () => guarded(async () => {
    const withdraw = feedback?.rating === 'up';
    if (await rateOrAlert(withdraw ? undefined : { rating: 'up' })) setThanks(!withdraw);
  });
  const rateDown = () => guarded(async () => {
    if (feedback?.rating === 'down') {
      await rateOrAlert(undefined);
      return;
    }
    if (await rateOrAlert({ rating: 'down' })) setSheetOpen(true);
  });
  const rating = canRate ? (
    <>
      {/* Feather 的讚／倒讚是單線條，與複製、編輯同風格（Ionicons 版手指線條過密）；Feather 沒有實心版，已評以主色實心圓底＋白色圖示標示 */}
      <Pressable accessibilityRole="button" accessibilityLabel="有幫助" accessibilityState={{ selected: feedback?.rating === 'up', disabled: ratingBusy }} disabled={ratingBusy} style={styles.action} onPress={() => void rateUp()}>
        <View style={[styles.rateIcon, feedback?.rating === 'up' && { backgroundColor: accent.primaryDark }]}>
          <Feather name="thumbs-up" size={16} color={feedback?.rating === 'up' ? '#fff' : accent.primaryDark} />
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="沒有幫助" accessibilityState={{ selected: feedback?.rating === 'down', disabled: ratingBusy }} disabled={ratingBusy} style={styles.action} onPress={() => void rateDown()}>
        <View style={[styles.rateIcon, feedback?.rating === 'down' && { backgroundColor: accent.primaryDark }]}>
          <Feather name="thumbs-down" size={16} color={feedback?.rating === 'down' ? '#fff' : accent.primaryDark} />
        </View>
      </Pressable>
      <FeedbackSheet
        visible={sheetOpen}
        onSkip={() => {
          setSheetOpen(false);
          setThanks(true);
        }}
        onSubmit={(detail) => {
          setSheetOpen(false);
          void guarded(async () => {
            if (await rateOrAlert({ rating: 'down', ...detail })) setThanks(true);
          });
        }}
      />
    </>
  ) : null;
  const actions = (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={copied ? '已複製訊息' : '複製訊息'} style={styles.action} onPress={async () => {
        try {
          await Clipboard.setStringAsync(message.text);
          setCopied(true);
        } catch {
          Alert.alert('複製失敗', '請再試一次');
        }
      }}>
        <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={20} color={accent.primaryDark} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="重新編輯訊息" style={styles.action} onPress={() => onEdit(message.text)}>
        <Ionicons name="create-outline" size={20} color={accent.primaryDark} />
      </Pressable>
      {/* 評價鈕放在同一個動作列：間距與複製／編輯一致（放在 meta 列會多出 gap） */}
      {rating}
      {thanks ? <Text style={[styles.thanks, { color: accent.primaryDark }]} accessibilityLiveRegion="polite">感謝回饋</Text> : null}
    </View>
  );
  if (message.role === 'system') {
    return (
      <View style={{ alignItems: 'center' }}>
      <Text style={[styles.system, message.tone === 'error' && { color: colors.danger }]} accessibilityRole="alert">
        {message.text}
      </Text>
      {message.hideActions ? null : actions}
      </View>
    );
  }
  if (message.role === 'user') {
    return (
      <View style={styles.userWrap}>
        <View style={styles.userMessage}>
        <View style={[styles.userBubble, { backgroundColor: accent.primarySoft }]}>
          <Text style={styles.userText}>{message.text}</Text>
        </View>
        <View style={styles.meta}>
          <Text style={styles.time}>{time(message.at)}</Text>
          {actions}
        </View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.agentWrap}>
      {Mascot ? <View style={{ width: avatarSize, flexShrink: 0 }}><Mascot pose="wave" size={avatarSize} /></View> : null}
      <View style={{ flex: 1 }}>
        <View style={styles.agentBubble}>
          <RichText text={message.text} />
          {message.blocks?.map((b, i) => <TableBlockView key={i} block={b} />)}
        </View>
        {showSuggestions && message.suggestions && message.suggestions.length > 0 ? (
          <View style={styles.chips}>
            {message.suggestions.map((s) => (
              <Pressable key={s} style={styles.chip} onPress={() => onSuggestion(s)} accessibilityRole="button">
                <Text style={styles.chipText}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.meta}>
          <Text style={styles.time}>{time(message.at)}</Text>
          {actions}
        </View>
      </View>
    </View>
  );
}

function useStyles() {
  const chatFont = useChatTypography();
  return useMemo(() => StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', justifyContent: 'flex-start', gap: space.sm, marginTop: -6, marginLeft: 8 },
  actions: { flexDirection: 'row' },
  action: { width: 28, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  rateIcon: { width: 28, height: 28, borderRadius: radius.pill, justifyContent: 'center', alignItems: 'center' },
  thanks: { alignSelf: 'center', marginLeft: space.xs, fontSize: chatFont.caption, fontWeight: '500' },
  system: { alignSelf: 'center', fontSize: chatFont.label, fontWeight: '500', color: colors.textMuted, marginVertical: space.sm, textAlign: 'center' },
  userWrap: { alignItems: 'flex-end', marginVertical: space.sm },
  userMessage: { maxWidth: '80%' },
  userBubble: { borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.lg, paddingVertical: space.md },
  userText: { fontSize: chatFont.body, lineHeight: chatFont.lineHeight, fontWeight: '500', color: colors.text },
  agentWrap: { flexDirection: 'row', gap: space.sm, marginVertical: space.sm, alignItems: 'flex-start' },
  agentBubble: { backgroundColor: colors.surface, borderRadius: radius.lg, borderTopLeftRadius: 4, padding: space.md, ...shadow.card },
  time: { fontSize: chatFont.caption, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  chipText: { fontSize: chatFont.label, fontWeight: '500', color: colors.text },
}), [chatFont]);
}
