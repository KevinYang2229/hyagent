import { router } from 'expo-router';
import { useRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useChat } from '@/chat/ChatProvider';
import { useIsWide } from '@/layout/useIsWide';
import { colors, font, space } from '@/theme/tokens';
import { askAiText } from '@/vision/coupon';
import { CouponResultView } from '@/vision/CouponResultView';
import { useVisionResults } from '@/vision/VisionResultStore';

export default function CouponResultScreen() {
  const { coupon } = useVisionResults();
  const chat = useChat();
  const wide = useIsWide();
  // 同一個 tick 內連點兩下：只送一次、只導頁一次
  const asked = useRef(false);
  const camera = (mode: 'coupon' | 'barcode') => router.push({ pathname: '/camera', params: { mode } });

  if (!coupon) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md }}>
        <Text style={{ fontSize: font.lg, color: colors.text }}>還沒有優惠券結果</Text>
        <Pressable onPress={() => camera('coupon')} accessibilityRole="button">
          <Text style={{ color: colors.primaryDark, fontSize: font.md }}>拍一張優惠券</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <CouponResultView
      photo={coupon.photo}
      view={coupon.view}
      wide={wide}
      onRetake={() => camera(coupon.photo ? 'coupon' : 'barcode')}
      onBarcode={() => camera('barcode')}
      onAskAi={() => {
        if (asked.current) return;
        asked.current = true;
        void chat.send(askAiText(coupon.view));
        router.navigate('/chat');
        // 導頁後使用者可能再回到此頁，下一次點擊要能再問
        setTimeout(() => { asked.current = false; }, 0);
      }}
    />
  );
}
