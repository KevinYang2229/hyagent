import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { errorMessage } from '@hyagent/app-core/api/errors';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { localToday } from '@hyagent/app-core/confirm/confirmForm';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { colors, font, space } from '@hyagent/app-core/theme/tokens';
import { ShelfResultView } from '@/vision/ShelfResultView';
import { useVisionResults } from '@/vision/VisionResultStore';

export default function ShelfResultScreen() {
  const { shelf } = useVisionResults();
  const chat = useChat();
  const wide = useIsWide();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retake = () => router.push({ pathname: '/camera', params: { mode: 'shelf' } });

  if (!shelf) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md }}>
        <Text style={{ fontSize: font.lg, color: colors.text }}>還沒有辨識結果</Text>
        <Pressable onPress={retake} accessibilityRole="button">
          <Text style={{ color: colors.primaryDark, fontSize: font.md }}>拍一張貨架照片</Text>
        </Pressable>
      </View>
    );
  }

  async function create() {
    const rep = shelf?.result.replenishment;
    if (!rep) return;
    setCreating(true);
    setError(null);
    try {
      await chat.propose(rep.toolId, rep.input);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <ShelfResultView photo={shelf.photo} result={shelf.result} today={localToday()} wide={wide} creating={creating} error={error} onRetake={retake} onCreate={create} />
  );
}
