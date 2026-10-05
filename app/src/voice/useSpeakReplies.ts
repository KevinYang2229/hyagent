/** 朗讀開關為開時，唸出新出現的 AI 回覆（不唸進入畫面前就有的歷史）；關閉或離開時停止。 */
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/chat/types';
import { speak, stopSpeaking } from './speech';

export function useSpeakReplies(
  messages: ChatMessage[],
  enabled: boolean,
  speakFn: (text: string) => void = speak,
  stopFn: () => void = stopSpeaking,
): void {
  const lastId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === 'agent');
    if (lastId.current === undefined) {
      lastId.current = last?.id ?? null;
      return;
    }
    if (last && last.id !== lastId.current) {
      lastId.current = last.id;
      if (enabled) speakFn(last.text);
    }
  }, [messages, enabled, speakFn]);

  useEffect(() => {
    if (!enabled) stopFn();
  }, [enabled, stopFn]);

  useEffect(() => () => stopFn(), [stopFn]);
}
